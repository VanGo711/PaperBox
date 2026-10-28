from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

import httpx

from src.backend.vector.config import VectorSettings


class PowerContextService:
    """In-process PowerContext client backed by an ASGI transport."""

    def __init__(self, app, settings: VectorSettings | None = None) -> None:
        self.app = app
        self.settings = settings or VectorSettings.from_environment()
        self._scope_ids = self._load_scope_ids()

    @property
    def _scope_file(self) -> Path:
        return self.settings.powercontext_dir / "paper-scopes.json"

    def _load_scope_ids(self) -> dict[str, str]:
        try:
            data = json.loads(self._scope_file.read_text(encoding="utf-8"))
            return {str(key): str(value) for key, value in data.items() if isinstance(key, str) and isinstance(value, str)}
        except (OSError, ValueError):
            return {}

    def _save_scope_ids(self) -> None:
        self._scope_file.parent.mkdir(parents=True, exist_ok=True)
        self._scope_file.write_text(json.dumps(self._scope_ids, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    async def _client(self):
        from powercontext.client import PowerContextClient

        http_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://127.0.0.1")
        client = PowerContextClient("http://127.0.0.1", http_client=http_client, trust_transport_security=True)
        return client, http_client

    def _run(self, operation):
        return asyncio.run(operation())

    @staticmethod
    def _within_budget(text: str, budget: int) -> str:
        return text.encode("utf-8")[:budget].decode("utf-8", errors="ignore")

    async def _ensure_scope(self, client, source_path: str, title: str):
        from powercontext.http import CreateScopeRequest

        if source_path in self._scope_ids:
            return self._scope_ids[source_path]
        scope = await client.create_scope(CreateScopeRequest(
            title=title[:200], summary="PaperBox 单篇论文的持久上下文",
            idempotency_key="paperbox-paper-" + hashlib.sha256(source_path.encode("utf-8")).hexdigest()[:48],
        ))
        self._scope_ids[source_path] = scope.scope_id
        self._save_scope_ids()
        return scope.scope_id

    def capture_document(self, *, source_path: str, title: str, content: str, metadata: dict[str, Any]) -> dict[str, Any]:
        async def capture():
            from powercontext.http import CaptureContentSourceRequest, RememberMemoryRequest

            client, http_client = await self._client()
            try:
                scope_id = await self._ensure_scope(client, source_path, title)
                source_id = "paper-" + hashlib.sha256(source_path.encode("utf-8")).hexdigest()[:48]
                response = await client.capture_content_source(CaptureContentSourceRequest(
                    scope_id=scope_id, source_id=source_id, content=content[:200000],
                    metadata={"kind": "paper_pdf", "title": title, "source_path": source_path, **metadata},
                ))
                memory_text = f"论文：{title}\n来源：{source_path}\n\n{content[:7000]}".strip()
                await client.remember_memory(RememberMemoryRequest(
                    scope_id=scope_id, kind="paper_pdf", text=memory_text,
                    reason="导入论文后建立可立即召回的上下文。",
                ))
                return {"embedded": True, "captured": True, "scope_id": scope_id, "source_id": source_id, "receipt": response.model_dump(mode="json")}
            finally:
                await http_client.aclose()

        try:
            return self._run(capture)
        except Exception as error:
            return {"embedded": True, "captured": False, "reason": str(error)}

    def delete_document(self, source_path: str) -> dict[str, Any]:
        scope_id = self._scope_ids.pop(source_path, None)
        if not scope_id:
            return {"embedded": True, "deleted": False, "reason": "未找到论文上下文。"}

        async def clear_scope():
            from powercontext.http import FlushMemoryRequest

            client, http_client = await self._client()
            try:
                await client.flush_memory(FlushMemoryRequest(scope_id=scope_id))
            finally:
                await http_client.aclose()

        try:
            self._run(clear_scope)
        except Exception as error:
            self._scope_ids[source_path] = scope_id
            return {"embedded": True, "deleted": False, "reason": str(error)}
        self._save_scope_ids()
        return {"embedded": True, "deleted": True}

    def prepare(self, question: str, *, source_paths: list[str] | None = None, max_bytes: int = 8000) -> dict[str, Any]:
        """Prepare context globally or only from explicitly retrieved papers."""
        if source_paths is None:
            scope_ids = list(self._scope_ids.values())
        else:
            scope_ids = list(dict.fromkeys(
                self._scope_ids[source_path]
                for source_path in source_paths
                if source_path in self._scope_ids
            ))
        if not scope_ids:
            return {"embedded": True, "used": False, "content": ""}

        async def prepare():
            from powercontext.http import PrepareContextRequest, SearchMemoryRequest
            from powercontext.http._generated.models import ListAtomicMemoryRequest

            client, http_client = await self._client()
            try:
                remaining = max_bytes
                parts = []
                status = ""
                for scope_id in scope_ids:
                    if remaining <= 0:
                        break
                    result = await client.prepare_context(PrepareContextRequest(scope_id=scope_id, query=question, max_bytes=remaining, explain=True))
                    content = result.content or ""
                    if not content:
                        hits = await client.search_memory(SearchMemoryRequest(scope_id=scope_id, query=question, limit=8))
                        records = [hit.memory for hit in hits.hits]
                        if not records:
                            listed = await client.list_atomic_memories(ListAtomicMemoryRequest(scope_id=scope_id, limit=8))
                            records = listed.items
                        content = "\n\n".join(record.text.strip() for record in records if record.text.strip())
                    excerpt = self._within_budget(content, remaining)
                    if excerpt:
                        parts.append(excerpt)
                        remaining -= len(excerpt.encode("utf-8"))
                    status = str(result.status)
                content = "\n\n---\n\n".join(parts)
                return {"embedded": True, "used": bool(content), "content": content, "status": status, "reason": None}
            finally:
                await http_client.aclose()

        try:
            return self._run(prepare)
        except Exception as error:
            return {"embedded": True, "used": False, "content": "", "reason": str(error)}
