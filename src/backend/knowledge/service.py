from __future__ import annotations

import json
import re
from pathlib import Path

from src.backend.vector.service import PaperVectorService
from src.backend.context.powercontext import PowerContextService


class KnowledgeService:
    """Parse domain terms and build cited RAG context from paper evidence."""

    def __init__(self, vectors: PaperVectorService, context: PowerContextService) -> None:
        self.vectors = vectors
        self.context_service = context
        self._paper_root = Path(getattr(getattr(vectors, "settings", None), "paper_root", Path(__file__).resolve().parents[3] / "data" / "papers"))

    def _taxonomy_terms(self) -> list[tuple[str, str]]:
        """Read the current paper taxonomy, including LLM-driven merge/rename results."""
        terms: dict[str, str] = {}
        for metadata_file in self._paper_root.rglob(".paperbox.json"):
            try:
                metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(metadata, dict):
                continue
            hierarchy = metadata.get("hierarchy")
            if isinstance(hierarchy, dict):
                for value in hierarchy.values():
                    if isinstance(value, str) and value.strip():
                        terms.setdefault(value.strip().casefold(), value.strip())
                    elif isinstance(value, list):
                        for item in value:
                            if isinstance(item, str) and item.strip():
                                terms.setdefault(item.strip().casefold(), item.strip())
            for value in metadata.get("tags", []) if isinstance(metadata.get("tags"), list) else []:
                if isinstance(value, str) and value.strip():
                    terms.setdefault(value.strip().casefold(), value.strip())
        return sorted(terms.items(), key=lambda item: len(item[0]), reverse=True)

    def parse(self, question: str) -> dict[str, list[str]]:
        normalized = question.casefold()
        concepts: list[str] = []
        for needle, display in self._taxonomy_terms():
            if needle in normalized and display not in concepts:
                concepts.append(display)
            if len(concepts) >= 12:
                break
        entities = []
        for value in re.findall(r"(?<![A-Za-z0-9])[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)*(?![A-Za-z0-9])", question):
            if value not in entities:
                entities.append(value)
        return {"concepts": concepts, "entities": entities[:12]}

    def _paper_abstract(self, source_path: str) -> tuple[str, str] | None:
        """Return metadata only for a paper represented by a retrieved chunk."""
        try:
            relative_source = Path(source_path)
            if not source_path or relative_source.is_absolute():
                return None
            source_file = (self._paper_root / relative_source).resolve()
            source_file.relative_to(self._paper_root)
            metadata_file = source_file.parent / ".paperbox.json"
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return None
        if not isinstance(metadata, dict):
            return None
        abstract = re.sub(r"\s+", " ", str(metadata.get("abstract") or "")).strip()
        if not abstract or abstract == "PDF 中未提取到摘要。":
            return None
        title = re.sub(r"\s+", " ", str(metadata.get("title") or source_file.stem)).strip()
        return title or source_file.stem, abstract

    def retrieve(self, question: str, limit: int = 20, previous_questions: list[str] | None = None) -> dict:
        # Previous user questions resolve follow-ups such as “它的设计压力呢？”.
        # Assistant answers are deliberately excluded from retrieval evidence.
        recent_questions = [item.strip()[:1000] for item in (previous_questions or [])[-3:] if item.strip()]
        history = "\n".join(recent_questions)
        parsed = self.parse(f"{question}\n{history}")
        # The original wording remains first so semantic retrieval answers the
        # user's question rather than merely doing a concept-name lookup.
        retrieval_query = " ".join([question, *parsed["concepts"], *parsed["entities"], history]).strip()
        hits = self.vectors.search(query=retrieval_query, limit=limit)
        sources: list[dict] = []
        context_parts: list[str] = []
        abstracts: list[tuple[str, str]] = []
        abstract_source_paths: set[str] = set()
        for index, hit in enumerate(hits, start=1):
            content = str(hit.get("content", "")).strip()
            if not content:
                continue
            source_path = str(hit.get("source_path", ""))
            if source_path not in abstract_source_paths:
                abstract_source_paths.add(source_path)
                paper_abstract = self._paper_abstract(source_path)
                if paper_abstract:
                    abstracts.append(paper_abstract)
            source = {
                "id": f"S{index}",
                "score": round(float(hit.get("score", 0)), 4),
                "source_path": source_path,
                "category": str(hit.get("category", "")),
                "book": str(hit.get("book", "")),
                "chapter": str(hit.get("chapter", "")),
                "heading_path": str(hit.get("heading_path", "")),
                "line_start": int(hit.get("line_start", 0)),
                "line_end": int(hit.get("line_end", 0)),
                "char_start": int(hit.get("char_start", 0)),
                "char_end": int(hit.get("char_end", 0)),
                "content": content,
            }
            sources.append(source)
            location = " > ".join(part for part in (source["chapter"], source["heading_path"]) if part)
            context_parts.append(f"[{source['id']}] {source['book']}｜{location}｜第 {source['line_start']}–{source['line_end']} 行\n{content}")
        abstract_parts = [f"[论文摘要] {title}\n{abstract}" for title, abstract in abstracts]
        powercontext = self.context_service.prepare(question, source_paths=list(abstract_source_paths), max_bytes=8_000)
        prepared_context = str(powercontext.get("content") or "").strip()
        sections = []
        if abstract_parts:
            sections.append("以下摘要仅属于本轮 20 条命中片段对应的论文，用于补充理解，不可替代具体引用证据。\n\n" + "\n\n---\n\n".join(abstract_parts))
        if context_parts:
            sections.append("以下为按相似度召回的 20 条论文原文片段：\n\n" + "\n\n---\n\n".join(context_parts))
        if prepared_context:
            sections.append(f"[命中论文的 PowerContext 辅助上下文]\n{prepared_context}")
        context = "\n\n==========\n\n".join(sections)
        return {
            "question": question,
            "parsed": parsed,
            "retrieval_query": retrieval_query,
            "sources": sources,
            "context": context,
            "powercontext": {key: value for key, value in powercontext.items() if key != "content"},
        }
