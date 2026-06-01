from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, List


class HistoryStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read_items(self) -> List[Dict[str, Any]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                return [item for item in payload if isinstance(item, dict)]
        except (OSError, json.JSONDecodeError):
            pass
        return []

    def list(self) -> List[Dict[str, Any]]:
        with self.lock:
            return list(self._read_items())

    def append(self, record: Dict[str, Any]) -> None:
        with self.lock:
            items = self._read_items()
            items.insert(0, dict(record))
            self.path.write_text(
                json.dumps(items[:5000], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
