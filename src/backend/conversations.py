"""Durable local conversation storage for knowledge and design workspaces."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
STORE_ROOT = ROOT / "data" / "conversations"
_LOCK = Lock()
_KINDS = {"knowledge", "design"}


class ConversationStoreError(ValueError):
    pass


def _path(kind: str) -> Path:
    if kind not in _KINDS:
        raise ConversationStoreError("未知会话类型。")
    return STORE_ROOT / f"{kind}.json"


def _validate(conversations: Any) -> list[dict[str, Any]]:
    if not isinstance(conversations, list) or len(conversations) > 500:
        raise ConversationStoreError("会话数据格式无效或数量超过上限。")
    encoded = json.dumps(conversations, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 20 * 1024 * 1024:
        raise ConversationStoreError("会话数据超过 20 MB 上限。")
    result: list[dict[str, Any]] = []
    for item in conversations:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("title"), str) or not isinstance(item.get("turns"), list):
            raise ConversationStoreError("会话条目缺少 id、title 或 turns。")
        result.append(item)
    return result


def load_conversations(kind: str) -> list[dict[str, Any]]:
    path = _path(kind)
    with _LOCK:
        if not path.exists():
            return []
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return _validate(value.get("conversations") if isinstance(value, dict) else value)
        except (OSError, json.JSONDecodeError, ConversationStoreError) as error:
            raise ConversationStoreError(f"无法读取已保存的会话：{error}") from error


def save_conversations(kind: str, conversations: Any) -> list[dict[str, Any]]:
    validated = _validate(conversations)
    path = _path(kind)
    payload = {"schema_version": 1, "kind": kind, "conversations": validated}
    with _LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{kind}-", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as error:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise ConversationStoreError(f"无法保存会话：{error}") from error
    return validated
