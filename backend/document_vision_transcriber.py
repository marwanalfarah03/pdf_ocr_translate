"""
Flexible OCR with vLLM Vision
"""

from __future__ import annotations

import base64
import json
import re
import urllib.request
from typing import Callable, Optional

import fitz  # pip install pymupdf


# ── Config ────────────────────────────────────────────────────────────────────
MODEL = "/data/models/Qwen3.5-122B-A10B"
VLLM_URL = "http://localhost:8018/v1/chat/completions"
DPI = 200
REQUEST_TIMEOUT_SECONDS = 600
# ─────────────────────────────────────────────────────────────────────────────


THINK_START_PREFIX = "<think"
THINK_END_TAG = "</think>"
HEADER_SEPARATOR = "---------- HEADER ----------"
FOOTER_SEPARATOR = "---------- FOOTER ----------"

_ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
_MULTISPACE_RE = re.compile(r"[ \t]{2,}")


SYSTEM_PROMPT = f"""
You are a precise document transcription engine.

Output faithful plain text only.

Rules:
- Do not summarize, translate, explain, correct, or add commentary.
- Preserve Arabic, English, numbers, punctuation, symbols, bullets, parentheses, slashes, and diacritics exactly when visible.
- Keep Arabic in logical reading order.
- Use [unclear] for unreadable words or spans.
- Ignore text inside logos, seals, icons, decorative watermarks, and background graphics unless clearly part of the document content.
- Follow the natural reading order of the page.
- For multi-column layouts, read each column in its natural order.
- Keep headings, titles, bullets, numbered items, clauses, form fields, and table rows clearly separated.
- Join lines that are only visual wrapping inside the same sentence or field.
- If a label and value appear together, output: LABEL : VALUE.
- For tables, use readable plain text. Use " | " between cells only when helpful.
- Never output a term or label alone if its definition/value continues beside or below it.

Headers and footers:
- If a visually distinct running header appears above the main content, transcribe it, then output exactly:
{HEADER_SEPARATOR}
- If a visually distinct footer appears below the main content, output exactly:
{FOOTER_SEPARATOR}
then transcribe the footer.
- Use these separators only for clear running headers/footers.

Return transcription only.
""".strip()


FULL_PAGE_PROMPT = f"""
Transcribe this page faithfully as plain text.

The page may contain Arabic, English, mixed RTL/LTR text, tables, forms, boxes,
signatures, lists, clauses, definitions, annexes, page numbers, or scanned content.

Use this order:
1. Clear running header if present, followed by:
   {HEADER_SEPARATOR}
2. Main content in natural reading order.
3. Clear footer if present, preceded by:
   {FOOTER_SEPARATOR}

Return transcription only.
""".strip()


def rasterize_page(page: fitz.Page, dpi: int = DPI) -> bytes:
    """Render a PDF page to JPEG bytes."""
    zoom = dpi / 72
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB, alpha=False)
    return pix.tobytes("jpeg")


def _visible_after_think_token(
    token: str,
    pending: list[str],
    streaming_started: bool,
) -> tuple[str, bool]:
    """Return streamed text only after a closing think tag has appeared."""
    if streaming_started:
        return token, True

    pending.append(token)
    pending_text = "".join(pending)
    pending_lower = pending_text.lower()

    end_index = pending_lower.find(THINK_END_TAG)
    if end_index >= 0:
        pending.clear()
        return pending_text[end_index + len(THINK_END_TAG):], True

    return "", False


def transcribe_image(
    jpeg_bytes: bytes,
    on_token: Optional[Callable[[str], None]] = None,
    print_tokens: bool = True,
) -> str:
    """Send a page image to vLLM and return the transcription."""
    image_base64 = base64.b64encode(jpeg_bytes).decode("ascii")
    image_url = f"data:image/jpeg;base64,{image_base64}"

    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": FULL_PAGE_PROMPT,
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                        },
                    },
                ],
            },
        ],
        "stream": True,
        "temperature": 0,
        "top_p": 1,
    }

    req = urllib.request.Request(
        VLLM_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    full_text: list[str] = []
    raw_text: list[str] = []
    pending_think_text: list[str] = []
    streaming_started = False

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            if print_tokens:
                print()

            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").strip()

                if not line:
                    continue

                if not line.startswith("data:"):
                    continue

                data = line.removeprefix("data:").strip()

                if data == "[DONE]":
                    break

                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue

                choices = chunk.get("choices", [])
                if not choices:
                    continue

                delta = choices[0].get("delta", {})
                token = delta.get("content", "")

                if token:
                    raw_text.append(token)
                    visible_token, streaming_started = _visible_after_think_token(
                        token,
                        pending_think_text,
                        streaming_started,
                    )

                    if not visible_token:
                        continue

                    full_text.append(visible_token)

                    if print_tokens:
                        print(visible_token, end="", flush=True)

                    if on_token is not None:
                        on_token(visible_token)

            if print_tokens:
                print()

    except Exception as e:
        return f"[ERROR calling model: {e}]"

    if streaming_started:
        return "".join(full_text).strip()

    raw_output = "".join(raw_text).strip()
    raw_output_lower = raw_output.lower()
    if THINK_START_PREFIX in raw_output_lower or THINK_END_TAG in raw_output_lower:
        return ""

    return raw_output


def _normalize_separator_lines(text: str) -> str:
    lines = []

    for line in text.splitlines():
        stripped = line.strip()

        if stripped == HEADER_SEPARATOR:
            lines.append(HEADER_SEPARATOR)
        elif stripped == FOOTER_SEPARATOR:
            lines.append(FOOTER_SEPARATOR)
        else:
            lines.append(line.rstrip())

    return "\n".join(lines).strip()


def _merge_orphan_label_value_lines(text: str) -> str:
    lines = text.splitlines()
    output: list[str] = []
    i = 0

    while i < len(lines):
        current = lines[i].strip()

        if not current:
            output.append("")
            i += 1
            continue

        if current in {HEADER_SEPARATOR, FOOTER_SEPARATOR}:
            output.append(current)
            i += 1
            continue

        next_index = i + 1
        while next_index < len(lines) and not lines[next_index].strip():
            next_index += 1

        next_line = lines[next_index].strip() if next_index < len(lines) else ""

        if (
            next_line
            and _ARABIC_RE.search(current)
            and ":" not in current
            and next_line.startswith("(")
        ):
            output.append(f"{current} {next_line}")
            i = next_index + 1
            continue

        if next_line.startswith(":") and ":" not in current:
            output.append(f"{current} {next_line}")
            i = next_index + 1
            continue

        if current.endswith(":") and next_line and next_line not in {HEADER_SEPARATOR, FOOTER_SEPARATOR}:
            output.append(f"{current} {next_line}")
            i = next_index + 1
            continue

        output.append(lines[i].rstrip())
        i += 1

    return "\n".join(output)


def postprocess_page_text(text: str) -> str:
    """Light cleanup without hard-coding a specific document layout."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _normalize_separator_lines(text)
    text = _merge_orphan_label_value_lines(text)

    cleaned_lines = []

    for line in text.splitlines():
        if line.strip() in {HEADER_SEPARATOR, FOOTER_SEPARATOR}:
            cleaned_lines.append(line.strip())
        else:
            cleaned_lines.append(_MULTISPACE_RE.sub(" ", line).rstrip())

    text = "\n".join(cleaned_lines)
    text = re.sub(r"\n{4,}", "\n\n\n", text)

    return text.strip()
