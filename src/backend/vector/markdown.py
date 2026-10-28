from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path


HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
HTML_TAG = re.compile(r"<[^>]+>")
LOCATOR_TOKEN = re.compile(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9][A-Za-z0-9._/-]*")


@dataclass(frozen=True)
class SourceSection:
    heading: str
    heading_path: str
    body: str
    char_start: int
    line_start: int


@dataclass(frozen=True)
class PaperChunk:
    id: str
    text: str
    source_path: str
    category: str
    book: str
    chapter: str
    heading_path: str
    line_start: int
    line_end: int
    char_start: int
    char_end: int
    chunk_index: int
    document_hash: str

    def payload(self) -> dict:
        return {
            "content": self.text,
            "source_path": self.source_path,
            "category": self.category,
            "book": self.book,
            "chapter": self.chapter,
            "heading_path": self.heading_path,
            "line_start": self.line_start,
            "line_end": self.line_end,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "chunk_index": self.chunk_index,
            "document_hash": self.document_hash,
        }


def discover_markdown_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.md") if path.is_file())


def _clean_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = IMAGE.sub("", text)
    text = LINK.sub(r"\1", text)
    text = HTML_TAG.sub(" ", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+[.)、]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def sections_with_locations(markdown: str, fallback: str) -> list[SourceSection]:
    normalized = markdown.replace("\r\n", "\n")
    lines = normalized.splitlines(keepends=True)
    sections: list[SourceSection] = []
    heading_stack: list[str] = []
    heading = fallback
    heading_path = fallback
    body_start = 0
    body_line_start = 1
    offset = 0

    def append_section(end: int) -> None:
        body = normalized[body_start:end]
        if _clean_markdown(body):
            sections.append(SourceSection(heading, heading_path, body, body_start, body_line_start))

    for line_number, line in enumerate(lines, start=1):
        match = HEADING.match(line.rstrip("\n"))
        if match:
            append_section(offset)
            level = len(match.group(1))
            title = match.group(2).strip()
            heading_stack[:] = heading_stack[: level - 1]
            heading_stack.append(title)
            heading = title
            heading_path = " > ".join(heading_stack)
            body_start = offset + len(line)
            body_line_start = line_number + 1
        offset += len(line)
    append_section(len(normalized))
    return sections or [SourceSection(fallback, fallback, normalized, 0, 1)]


def locate_source_span(
    raw_body: str,
    indexed_text: str,
    *,
    body_char_start: int,
    body_line_start: int,
    search_from: int = 0,
) -> tuple[int, int, int, int, int]:
    """Return Unicode character and line offsets for a cleaned text block.

    Markdown cleanup can remove syntax, so a stable first/last lexical anchor
    is used instead of assuming that the embedded text is byte-identical to the
    source. If an anchor cannot be found, the complete source section remains a
    safe, explicit fallback.
    """
    tokens = LOCATOR_TOKEN.findall(indexed_text)
    start = -1
    for token in tokens:
        start = raw_body.find(token, search_from)
        if start >= 0:
            break
    if start < 0:
        for token in tokens:
            start = raw_body.find(token)
            if start >= 0:
                break
    if start < 0:
        start = 0

    end = start
    for token in reversed(tokens):
        token_start = raw_body.rfind(token, start)
        if token_start >= 0:
            end = token_start + len(token)
            break
    if end <= start:
        end = min(len(raw_body), start + max(1, len(indexed_text)))

    line_start = body_line_start + raw_body[:start].count("\n")
    line_end = body_line_start + raw_body[:end].count("\n")
    return body_char_start + start, body_char_start + end, line_start, line_end, end


def _split_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    cleaned = _clean_markdown(text)
    if not cleaned:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", cleaned) if part.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        remaining = paragraph
        while remaining:
            separator = "\n\n" if current else ""
            available = chunk_size - len(current) - len(separator)
            if available >= len(remaining):
                current = f"{current}{separator}{remaining}"
                break
            if available > 120:
                boundary = max(remaining.rfind(mark, 0, available) for mark in ("。", "！", "？", ". ", "; ", " "))
                cut = boundary + 1 if boundary > available // 2 else available
                current = f"{current}{separator}{remaining[:cut].strip()}"
                remaining = remaining[cut:].lstrip()
            if current:
                chunks.append(current)
            tail = current[-overlap:].strip() if overlap else ""
            current = tail
            if len(current) >= chunk_size:
                current = ""
    if current:
        chunks.append(current)
    return chunks


def chunks_for_file(path: Path, root: Path, *, chunk_size: int, overlap: int) -> list[PaperChunk]:
    raw = path.read_text(encoding="utf-8")
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    relative = path.relative_to(root).as_posix()
    parts = path.relative_to(root).parts
    category = parts[0] if parts else "未分类"
    book = parts[1] if len(parts) > 1 else path.parent.name
    chunks: list[PaperChunk] = []
    for section in sections_with_locations(raw, path.stem):
        cursor = 0
        prefix = f"章节：{section.heading_path}\n\n"
        for content in _split_text(section.body, chunk_size, overlap):
            char_start, char_end, line_start, line_end, cursor = locate_source_span(
                section.body,
                content,
                body_char_start=section.char_start,
                body_line_start=section.line_start,
                search_from=cursor,
            )
            text = f"{prefix}{content}".strip()
            index = len(chunks)
            point_id = hashlib.sha256(f"{relative}:{index}:{text}".encode("utf-8")).hexdigest()
            chunks.append(PaperChunk(
                point_id, text, relative, category, book, section.heading, section.heading_path,
                line_start, line_end, char_start, char_end, index, digest,
            ))
    return chunks
