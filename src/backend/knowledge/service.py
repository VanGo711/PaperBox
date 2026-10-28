from __future__ import annotations

import json
import re
from pathlib import Path

from src.backend.vector.service import PaperVectorService
from src.backend.context.powercontext import PowerContextService


class KnowledgeService:
    """Parse domain terms and build a bounded, cited RAG context."""

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

    def _expanded_excerpt(self, hit: dict, max_chars: int) -> tuple[str, int, int, int, int] | None:
        root = getattr(getattr(self.vectors, "settings", None), "paper_root", None)
        source_path = str(hit.get("source_path", "")).strip()
        try:
            if not root or not source_path or Path(source_path).is_absolute():
                return None
            paper_root = Path(root).resolve()
            source_file = (paper_root / source_path).resolve()
            source_file.relative_to(paper_root)
            document = source_file.read_text(encoding="utf-8").replace("\r\n", "\n")
            match_start = int(hit["char_start"])
            match_end = int(hit["char_end"])
        except (KeyError, OSError, TypeError, ValueError):
            return None
        if match_start < 0 or match_end <= match_start or match_end > len(document):
            return None

        section_start = 0
        section_end = len(document)
        heading_pattern = re.compile(r"(?m)^#{1,6}[ \t]+[^\n]*(?:\n|$)")
        for heading in heading_pattern.finditer(document):
            if heading.end() <= match_start:
                section_start = heading.end()
            elif heading.start() >= match_end:
                section_end = heading.start()
                break
        section = document[section_start:section_end]
        local_start = match_start - section_start
        local_end = match_end - section_start
        separators = list(re.finditer(r"\n[ \t]*\n+", section))
        before = [item for item in separators if item.end() <= local_start]
        after = [item for item in separators if item.start() >= local_end]
        context_start = before[-2].end() if len(before) >= 2 else 0
        context_end = after[1].start() if len(after) >= 2 else len(section)

        excerpt = section[context_start:context_end]
        relative_match_start = local_start - context_start
        relative_match_end = local_end - context_start
        if len(excerpt) > max_chars:
            match_length = relative_match_end - relative_match_start
            if match_length >= max_chars:
                trim_start = max(0, min(relative_match_start, len(excerpt) - max_chars))
            else:
                spare = max_chars - match_length
                trim_start = max(0, relative_match_start - spare // 2)
                trim_start = min(trim_start, len(excerpt) - max_chars)
            excerpt = excerpt[trim_start:trim_start + max_chars]
            context_start += trim_start

        left_trim = len(excerpt) - len(excerpt.lstrip())
        excerpt = excerpt.strip()
        excerpt_start = section_start + context_start + left_trim
        excerpt_end = excerpt_start + len(excerpt)
        return (
            excerpt,
            document[:excerpt_start].count("\n") + 1,
            document[:excerpt_end].count("\n") + 1,
            excerpt_start,
            excerpt_end,
        )

    def retrieve(self, question: str, limit: int = 12, previous_questions: list[str] | None = None) -> dict:
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
        remaining = 18_000
        for index, hit in enumerate(hits, start=1):
            content = str(hit.get("content", "")).strip()
            if not content or remaining <= 0:
                continue
            expanded = self._expanded_excerpt(hit, min(remaining, 2_800))
            if expanded:
                excerpt, line_start, line_end, char_start, char_end = expanded
            else:
                excerpt = content[: min(len(content), remaining, 2_800)]
                line_start = int(hit.get("line_start", 0))
                line_end = int(hit.get("line_end", 0))
                char_start = int(hit.get("char_start", 0))
                char_end = int(hit.get("char_end", 0))
            remaining -= len(excerpt)
            source = {
                "id": f"S{index}",
                "score": round(float(hit.get("score", 0)), 4),
                "source_path": str(hit.get("source_path", "")),
                "category": str(hit.get("category", "")),
                "book": str(hit.get("book", "")),
                "chapter": str(hit.get("chapter", "")),
                "heading_path": str(hit.get("heading_path", "")),
                "line_start": line_start,
                "line_end": line_end,
                "char_start": char_start,
                "char_end": char_end,
                "content": excerpt,
            }
            sources.append(source)
            location = " > ".join(part for part in (source["chapter"], source["heading_path"]) if part)
            context_parts.append(f"[{source['id']}] {source['book']}｜{location}｜第 {source['line_start']}–{source['line_end']} 行\n{excerpt}")
        powercontext = self.context_service.prepare(question, max_bytes=8000)
        prepared_context = str(powercontext.get("content") or "").strip()
        if prepared_context:
            context_parts.insert(0, f"[PowerContext]\n{prepared_context}")
        return {
            "question": question,
            "parsed": parsed,
            "retrieval_query": retrieval_query,
            "sources": sources,
            "context": "\n\n---\n\n".join(context_parts),
            "powercontext": {key: value for key, value in powercontext.items() if key != "content"},
        }
