from __future__ import annotations

import json
import os
import re
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List

import requests
from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"

_TEXT_PART = re.compile(
    r"^word/(document|header\d*|footer\d*|endnotes|footnotes|comments)\d*\.xml$"
)
_ARABIC_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]")
_MULTISPACE_RE = re.compile(r"\s+")
TRANSLATED_DOCX_LANGUAGE = "en-US"
HEADER_SEPARATOR = "---------- HEADER ----------"
FOOTER_SEPARATOR = "---------- FOOTER ----------"
SEPARATOR_LINES = {HEADER_SEPARATOR, FOOTER_SEPARATOR}

DEFAULT_TRANSLATION_SYSTEM_PROMPT = """You are a professional document translator at a leading financial institution in Jordan, specialising in Corporate and Institutional Banking.

Translate Arabic documents into formal English.

Core rules:
1. Maintain the EXACT meaning of all banking, financial, legal, and compliance terminology.
2. Use standard banking and financial-services terminology appropriate for the document type.
3. Preserve verbatim any system, platform, tool, or software name when it is already written in its official form.
4. Preserve the referential structure of the source text, especially named items, points, articles, clauses, appendices, attachments, and signatory blocks.
5. Use a highly formal, objective, professional tone suitable for an official institutional document.
6. Preserve original structure: headings, numbered lists, bullet points.
7. Preserve any identifiers, codes, acronyms, numerals, percentages, decimals, numeric ranges, and numeric identifiers exactly as written.
8. Do NOT add explanatory notes, comments, or any text not present in the source.
9. Return ONLY the translated text.
10. Every word MUST be separated by exactly one space.
""".strip()


@dataclass(frozen=True)
class TranslationSettings:
    endpoint: str
    model: str
    api_key: str
    timeout: int
    max_retries: int
    batch_word_limit: int
    system_prompt: str


def _w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


def _local(elem: etree._Element) -> str:
    tag = elem.tag
    return tag.split("}")[-1] if "}" in tag else tag


def _is_text_part(name: str) -> bool:
    return bool(_TEXT_PART.match(name))


def _run_text(run: etree._Element) -> str:
    return "".join(child.text or "" for child in run if _local(child) in {"t", "delText"})


def _run_has_break(run: etree._Element) -> bool:
    return any(_local(child) == "br" for child in run)


def _get_or_add_first_child(parent: etree._Element, tag_name: str) -> etree._Element:
    child = parent.find(_w(tag_name))
    if child is None:
        child = etree.Element(_w(tag_name))
        parent.insert(0, child)
    return child


def _set_xml_language(r_pr: etree._Element, language: str) -> None:
    lang = r_pr.find(_w("lang"))
    if lang is None:
        lang = etree.SubElement(r_pr, _w("lang"))
    lang.set(_w("val"), language)
    lang.set(_w("eastAsia"), language)
    lang.set(_w("bidi"), language)


def _set_xml_ltr_run(run: etree._Element, language: str) -> None:
    r_pr = _get_or_add_first_child(run, "rPr")
    rtl = r_pr.find(_w("rtl"))
    if rtl is None:
        rtl = etree.SubElement(r_pr, _w("rtl"))
    rtl.set(_w("val"), "0")
    _set_xml_language(r_pr, language)


def _set_xml_ltr_paragraph(paragraph: etree._Element, center: bool = False) -> None:
    p_pr = _get_or_add_first_child(paragraph, "pPr")
    bidi = p_pr.find(_w("bidi"))
    if bidi is None:
        bidi = etree.SubElement(p_pr, _w("bidi"))
    bidi.set(_w("val"), "0")

    jc = p_pr.find(_w("jc"))
    if jc is None:
        jc = etree.SubElement(p_pr, _w("jc"))

    current_alignment = jc.get(_w("val"))
    if center:
        jc.set(_w("val"), "center")
    elif current_alignment in {None, "right", "end"}:
        jc.set(_w("val"), "left")


def _iter_runs(para: etree._Element):
    wrappers = {"ins", "del", "hyperlink", "sdtContent", "sdt"}

    def _walk(element: etree._Element):
        loc = _local(element)
        if loc == "r":
            yield element
        elif loc in wrappers:
            for child in element:
                yield from _walk(child)

    for child in para:
        yield from _walk(child)


def _paragraph_text(para: etree._Element) -> str:
    return "".join(_run_text(run) for run in _iter_runs(para))


def _apply_english_direction_and_language(root: etree._Element) -> None:
    for paragraph in root.iter(_w("p")):
        text = _paragraph_text(paragraph).strip()
        _set_xml_ltr_paragraph(paragraph, center=text in SEPARATOR_LINES)
        for run in _iter_runs(paragraph):
            _set_xml_ltr_run(run, TRANSLATED_DOCX_LANGUAGE)


def _apply_english_styles(xml_bytes: bytes) -> bytes:
    root = etree.fromstring(xml_bytes)

    for p_pr in root.iter(_w("pPr")):
        bidi = p_pr.find(_w("bidi"))
        if bidi is not None:
            bidi.set(_w("val"), "0")

    for r_pr in root.iter(_w("rPr")):
        rtl = r_pr.find(_w("rtl"))
        if rtl is not None:
            rtl.set(_w("val"), "0")
        _set_xml_language(r_pr, TRANSLATED_DOCX_LANGUAGE)

    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


class Line:
    __slots__ = ("segments", "exact_original", "original", "translated")

    def __init__(self, segments):
        self.segments = segments
        self.exact_original = "".join(fragment for _, fragment in segments)
        self.original = _join_run_texts([fragment for _, fragment in segments])
        self.translated = None


def _join_run_texts(fragments: List[str]) -> str:
    if not fragments:
        return ""
    output = fragments[0]
    for fragment in fragments[1:]:
        if not output:
            output = fragment
            continue
        if fragment and not output[-1].isspace() and not fragment[0].isspace():
            output += " "
        output += fragment
    return output


def _extract_lines(para: etree._Element) -> List[Line]:
    lines: List[Line] = []
    current = []
    for run in _iter_runs(para):
        text = _run_text(run)
        has_break = _run_has_break(run)
        if text:
            current.append((run, text))
        if has_break:
            if current:
                lines.append(Line(current))
            current = []
    if current:
        lines.append(Line(current))
    return lines


def _set_run_text(run: etree._Element, text: str) -> None:
    for child in [c for c in run if _local(c) in {"t", "delText"}]:
        run.remove(child)
    if not text:
        return
    text_element = etree.SubElement(run, _w("t"))
    text_element.set(f"{{{XML_NS}}}space", "preserve")
    text_element.text = text


def _redistribute_translated_text(line: Line) -> None:
    translated = " ".join((line.translated or "").split())
    segments = line.segments
    if not translated or not segments:
        return

    if len(segments) == 1:
        _set_run_text(segments[0][0], translated)
        return

    words = translated.split()
    total_words = len(words)
    original_lengths = [len(fragment) for _, fragment in segments]
    total_original = sum(original_lengths) or 1

    cumulative = 0
    cursor = 0
    for index, (run, _) in enumerate(segments):
        if index == len(segments) - 1:
            chunk = " ".join(words[cursor:])
        else:
            cumulative += original_lengths[index]
            target_cursor = max(
                cursor + 1,
                min(
                    round((cumulative / total_original) * total_words),
                    total_words - (len(segments) - index - 1),
                ),
            )
            chunk = " ".join(words[cursor:target_cursor])
            cursor = target_cursor
            if chunk and not chunk[-1].isspace():
                chunk += " "
        _set_run_text(run, chunk)


def _word_count(text: str) -> int:
    collapsed = _MULTISPACE_RE.sub(" ", str(text or "")).strip()
    return len(collapsed.split()) if collapsed else 0


def _line_source_text(item: dict) -> str:
    return str(item.get("match_text") or item.get("display_text") or "")


def chunk_line_items_by_word_limit(line_items: List[dict], batch_word_limit: int) -> List[List[dict]]:
    limit = max(1, int(batch_word_limit))
    batches: List[List[dict]] = []
    current: List[dict] = []
    current_words = 0

    for item in line_items:
        words = max(1, _word_count(_line_source_text(item)))
        if current and current_words + words > limit:
            batches.append(current)
            current = [item]
            current_words = words
        else:
            current.append(item)
            current_words += words

    if current:
        batches.append(current)

    return batches


def _is_arabic_source_text(text: str) -> bool:
    return bool(_ARABIC_RE.search(text or ""))


def extract_docx_arabic_lines(input_path: Path) -> List[dict]:
    items: List[dict] = []
    line_id = 0

    with zipfile.ZipFile(input_path, "r") as zin:
        for entry in zin.infolist():
            if not _is_text_part(entry.filename):
                continue
            try:
                root = etree.fromstring(zin.read(entry.filename))
            except etree.XMLSyntaxError:
                continue

            for paragraph in root.iter(_w("p")):
                for line in _extract_lines(paragraph):
                    text = (line.exact_original or line.original).strip()
                    if not text or not _is_arabic_source_text(text):
                        continue
                    items.append({"id": line_id, "display_text": text, "match_text": text})
                    line_id += 1

    return items


def _apply_translations_to_xml(xml_bytes: bytes, translations_by_id: Dict[int, str], state: dict) -> bytes:
    root = etree.fromstring(xml_bytes)

    for paragraph in root.iter(_w("p")):
        lines = _extract_lines(paragraph)
        if not lines:
            continue

        for line in lines:
            text = (line.exact_original or line.original).strip()
            if not text or not _is_arabic_source_text(text):
                continue
            line_id = state["line_id"]
            state["line_id"] += 1
            translated = translations_by_id.get(line_id)
            if translated:
                line.translated = translated
                _redistribute_translated_text(line)

    _apply_english_direction_and_language(root)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def build_translated_docx(input_path: Path, output_path: Path, translations_by_id: Dict[int, str]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    state = {"line_id": 0}

    with zipfile.ZipFile(input_path, "r") as zin, zipfile.ZipFile(
        output_path, "w", compression=zipfile.ZIP_DEFLATED
    ) as zout:
        for entry in zin.infolist():
            raw = zin.read(entry.filename)
            if _is_text_part(entry.filename):
                try:
                    raw = _apply_translations_to_xml(raw, translations_by_id, state)
                except etree.XMLSyntaxError:
                    pass
            elif entry.filename == "word/styles.xml":
                try:
                    raw = _apply_english_styles(raw)
                except etree.XMLSyntaxError:
                    pass
            zout.writestr(entry, raw)


class VLLMTranslationClient:
    def __init__(self, settings: TranslationSettings):
        self.settings = settings
        self.url = settings.endpoint.rstrip("/") + "/v1/chat/completions"
        self.session = requests.Session()
        if settings.api_key:
            self.session.headers.update({"Authorization": f"Bearer {settings.api_key}"})

    def close(self) -> None:
        self.session.close()

    def _call(self, user_text: str, max_tokens: int, call_kind: str) -> str:
        payload = {
            "model": self.settings.model,
            "messages": [
                {"role": "system", "content": self.settings.system_prompt},
                {"role": "user", "content": user_text},
            ],
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }

        for attempt in range(1, self.settings.max_retries + 1):
            try:
                response = self.session.post(self.url, json=payload, timeout=self.settings.timeout)
                response.raise_for_status()
                body = response.json()
                choices = body.get("choices")
                if not choices or not isinstance(choices, list):
                    raise ValueError(f"Invalid response for {call_kind}: missing choices")
                content = choices[0].get("message", {}).get("content")
                if content is None:
                    raise ValueError(f"Invalid response for {call_kind}: missing content")
                return str(content).strip()
            except requests.RequestException:
                if attempt == self.settings.max_retries:
                    raise
                time.sleep(2 ** attempt)

        raise RuntimeError("Translation request failed after retries")

    def translate_single(self, text: str) -> str:
        prompt = (
            "Translate the following Arabic text to English. Keep numbers and percentages exactly "
            "as written. Return ONLY the translation:\n\n"
            f"{text}"
        )
        return self._call(prompt, max_tokens=4096, call_kind="translation_single")

    @staticmethod
    def _parse_numbered(raw: str, expected: int) -> List[str] | None:
        strict_matches = {
            int(match.group(1)): match.group(2).strip()
            for match in re.finditer(r"\[(\d+)\]\s*(.*?)(?=\n\s*\[\d+\]|\Z)", raw, re.DOTALL)
        }
        if strict_matches:
            parsed = [strict_matches.get(i) for i in range(1, expected + 1)]
            if all(value is not None for value in parsed):
                return [str(value) for value in parsed]

        loose_matches = {
            int(match.group(1)): match.group(2).strip()
            for match in re.finditer(r"\[(\d+)\]\s*(.*?)(?=\[(\d+)\]\s*|\Z)", raw, re.DOTALL)
        }
        if not loose_matches:
            return None
        parsed = [loose_matches.get(i) for i in range(1, expected + 1)]
        if any(value is None for value in parsed):
            return None
        return [str(value) for value in parsed]

    def translate_batch(self, texts: List[str]) -> List[str]:
        if not texts:
            return []
        if len(texts) == 1:
            return [self.translate_single(texts[0])]

        numbered = "\n".join(f"[{index + 1}] {text}" for index, text in enumerate(texts))
        prompt = (
            "Translate each numbered Arabic line to English. Keep any source numerals and percentages "
            "exactly as written. Return ONLY the translations while preserving [N] prefixes exactly.\n\n"
            + numbered
        )

        try:
            raw = self._call(prompt, max_tokens=8192, call_kind="translation_batch")
            parsed = self._parse_numbered(raw, len(texts))
            if parsed is not None:
                return parsed
        except Exception:
            pass

        results: List[str] = []
        for text in texts:
            try:
                results.append(self.translate_single(text))
            except Exception:
                results.append(text)
        return results


def load_translation_settings(settings_path: Path) -> TranslationSettings:
    defaults = {
        "endpoint": os.environ.get("TRANSLATION_ENDPOINT", "http://localhost:8020"),
        "model": os.environ.get("TRANSLATION_MODEL", "/data/models/gpt-oss-120b"),
        "api_key": os.environ.get("TRANSLATION_API_KEY", ""),
        "batch_word_limit": int(os.environ.get("TRANSLATION_BATCH_WORD_LIMIT", "250")),
        "timeout": int(os.environ.get("TRANSLATION_TIMEOUT", "180")),
        "max_retries": int(os.environ.get("TRANSLATION_MAX_RETRIES", "5")),
        "system_prompt": os.environ.get("TRANSLATION_SYSTEM_PROMPT", DEFAULT_TRANSLATION_SYSTEM_PROMPT),
    }

    payload = {}
    try:
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}

    merged = {**defaults, **(payload if isinstance(payload, dict) else {})}

    return TranslationSettings(
        endpoint=str(merged.get("endpoint") or defaults["endpoint"]).strip(),
        model=str(merged.get("model") or defaults["model"]).strip(),
        api_key=str(merged.get("api_key") or defaults["api_key"]).strip(),
        timeout=max(1, int(merged.get("timeout") or defaults["timeout"])),
        max_retries=max(1, int(merged.get("max_retries") or defaults["max_retries"])),
        batch_word_limit=max(1, int(merged.get("batch_word_limit") or defaults["batch_word_limit"])),
        system_prompt=str(merged.get("system_prompt") or defaults["system_prompt"]).strip(),
    )


def translate_docx_file(
    input_path: Path,
    output_path: Path,
    settings: TranslationSettings,
    progress_callback: Callable[[dict], None] | None = None,
) -> dict:
    line_items = extract_docx_arabic_lines(input_path)
    batches = chunk_line_items_by_word_limit(line_items, settings.batch_word_limit)
    translations_by_id: Dict[int, str] = {}

    client = VLLMTranslationClient(settings)
    try:
        total_batches = max(1, len(batches))
        for batch_index, batch in enumerate(batches, start=1):
            texts = [_line_source_text(item) for item in batch]
            translations = client.translate_batch(texts)
            for item, translated_text in zip(batch, translations):
                translations_by_id[int(item["id"])] = translated_text
            if progress_callback is not None:
                progress_callback(
                    {
                        "type": "translation_batch",
                        "processed_batches": batch_index,
                        "total_batches": total_batches,
                        "processed_lines": len(translations_by_id),
                        "total_lines": len(line_items),
                    }
                )
    finally:
        client.close()

    build_translated_docx(input_path, output_path, translations_by_id)

    return {
        "total_lines": len(line_items),
        "translated_lines": len(translations_by_id),
        "total_batches": len(batches),
    }
