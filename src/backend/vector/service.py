from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

from .config import VectorSettings
from .markdown import PaperChunk, chunks_for_file, discover_markdown_files
from .ollama import OllamaEmbeddingClient, OllamaEmbeddingError


class VectorServiceError(RuntimeError):
    pass


class PaperVectorService:
    """SeekDB-backed paper chunk index retaining the existing API surface."""

    SCHEMA_VERSION = 3
    FIELD_ROLES = {
        "id": ("主键", "PRIMARY"), "vector": ("嵌入向量", "HNSW · COSINE"),
        "content": ("原文块", "FULLTEXT"), "source_path": ("来源路径", "INDEX"),
        "category": ("论文分类", "INDEX"), "book": ("论文名称", "INDEX"),
        "chapter": ("页码/章节", "INDEX"), "heading_path": ("完整标题层级", "—"),
        "line_start": ("原文起始行", "—"), "line_end": ("原文结束行", "—"),
        "char_start": ("原文起始字符", "—"), "char_end": ("原文结束字符", "—"),
        "chunk_index": ("块序号", "INDEX"), "document_hash": ("增量索引校验", "INDEX"),
    }

    def __init__(self, settings: VectorSettings | None = None) -> None:
        self.settings = settings or VectorSettings.from_environment()
        self.settings.seekdb_dir.parent.mkdir(parents=True, exist_ok=True)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", self.settings.table_name):
            raise VectorServiceError("SEEKDB_TABLE 只能包含字母、数字和下划线，且不能以数字开头。")
        try:
            import seekdb
            self._instance = seekdb.open(str(self.settings.seekdb_dir))
        except ImportError as error:
            raise VectorServiceError("未安装 seekdb，请执行 pip install -r requirements.txt。") from error
        except Exception as error:
            raise VectorServiceError(f"SeekDB 初始化失败（{self.settings.seekdb_dir}）：{error}") from error
        self.embeddings = OllamaEmbeddingClient(self.settings)

    def _connection(self):
        try:
            return self._instance.connect(database="test", autocommit=True)
        except Exception as error:
            raise VectorServiceError(f"无法连接 SeekDB：{error}") from error

    @staticmethod
    def _sql_literal(value: Any) -> str:
        if value is None:
            return "NULL"
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            if not math.isfinite(value):
                raise VectorServiceError("SQL 参数不能是无穷或 NaN。")
            return repr(value)
        if isinstance(value, str):
            return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"
        raise VectorServiceError(f"不支持的 SQL 参数类型：{type(value).__name__}")

    @classmethod
    def _bind(cls, statement: str, values: tuple[Any, ...]) -> str:
        if statement.count("%s") != len(values):
            raise VectorServiceError("SeekDB SQL 参数数量不匹配。")
        for value in values:
            statement = statement.replace("%s", cls._sql_literal(value), 1)
        return statement

    def _query(self, statement: str, values: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        connection = self._connection()
        try:
            cursor = connection.cursor()
            try:
                cursor.execute(self._bind(statement, values))
                return list(cursor.fetchall())
            finally:
                cursor.close()
        finally:
            connection.close()

    def _table_exists(self) -> bool:
        return bool(self._query("SHOW TABLES LIKE %s", (self.settings.table_name,)))

    def _dimension(self) -> int | None:
        if not self._table_exists():
            return None
        rows = self._query(f"SHOW CREATE TABLE `{self.settings.table_name}`")
        definition = str(rows[0][-1]) if rows else ""
        match = re.search(r"`vector`\s+vector\((\d+)\)", definition, flags=re.IGNORECASE)
        return int(match.group(1)) if match else None

    def _ensure_table(self, dimension: int, *, rebuild: bool = False) -> None:
        if self._table_exists() and rebuild:
            self._query(f"DROP TABLE `{self.settings.table_name}`")
        existing_dimension = self._dimension()
        if existing_dimension is not None:
            if existing_dimension != dimension:
                raise VectorServiceError(f"SeekDB 表向量维度为 {existing_dimension}，当前嵌入模型返回 {dimension}；请重建索引。")
            return
        self._query(
            f"""CREATE TABLE `{self.settings.table_name}` (
                id VARCHAR(64) PRIMARY KEY, vector VECTOR({dimension}) NOT NULL,
                content LONGTEXT NOT NULL, source_path VARCHAR(1024) NOT NULL,
                category VARCHAR(256) NOT NULL, book VARCHAR(512) NOT NULL,
                chapter VARCHAR(1024) NOT NULL, heading_path VARCHAR(2048) NOT NULL,
                line_start BIGINT NOT NULL, line_end BIGINT NOT NULL,
                char_start BIGINT NOT NULL, char_end BIGINT NOT NULL,
                chunk_index BIGINT NOT NULL, document_hash VARCHAR(64) NOT NULL,
                VECTOR INDEX vector_hnsw(vector) WITH (distance=cosine, type=hnsw, lib=vsag),
                INDEX source_path_index(source_path), INDEX category_index(category),
                INDEX book_index(book), INDEX chapter_index(chapter),
                INDEX document_hash_index(document_hash), INDEX chunk_index_index(chunk_index)
            )"""
        )

    def _delete_source(self, source_path: str) -> None:
        if self._table_exists():
            self._query(f"DELETE FROM `{self.settings.table_name}` WHERE source_path = %s", (source_path,))

    def delete_source(self, source_path: str) -> None:
        """Delete every vector chunk and index-state entry for one PDF source."""
        try:
            self._delete_source(source_path)
            state = self._state()
            state["documents"].pop(source_path, None)
            self._save_state(state)
        except Exception as error:
            raise VectorServiceError(f"删除 SeekDB 论文向量失败：{error}") from error

    def _upsert(self, chunks: list[PaperChunk]) -> None:
        for start in range(0, len(chunks), self.settings.embedding_batch_size):
            batch = chunks[start : start + self.settings.embedding_batch_size]
            vectors = self.embeddings.embed([chunk.text for chunk in batch])
            self._ensure_table(len(vectors[0]))
            connection = self._connection()
            try:
                cursor = connection.cursor()
                try:
                    statement = f"""INSERT INTO `{self.settings.table_name}`
                        (id, vector, content, source_path, category, book, chapter, heading_path, line_start, line_end, char_start, char_end, chunk_index, document_hash)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE vector=VALUES(vector), content=VALUES(content), category=VALUES(category), book=VALUES(book), chapter=VALUES(chapter), heading_path=VALUES(heading_path), line_start=VALUES(line_start), line_end=VALUES(line_end), char_start=VALUES(char_start), char_end=VALUES(char_end), chunk_index=VALUES(chunk_index), document_hash=VALUES(document_hash)"""
                    for chunk, vector in zip(batch, vectors, strict=True):
                        values = (chunk.id, json.dumps(vector), chunk.text, chunk.source_path, chunk.category, chunk.book, chunk.chapter, chunk.heading_path, chunk.line_start, chunk.line_end, chunk.char_start, chunk.char_end, chunk.chunk_index, chunk.document_hash)
                        cursor.execute(self._bind(statement, values))
                finally:
                    cursor.close()
            finally:
                connection.close()

    def _state(self) -> dict[str, Any]:
        try:
            data = json.loads(self.settings.state_file.read_text(encoding="utf-8"))
            return data if isinstance(data.get("documents"), dict) else {"documents": {}}
        except (FileNotFoundError, ValueError):
            return {"documents": {}}

    def _save_state(self, state: dict[str, Any]) -> None:
        self.settings.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.settings.state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def index_chunks(self, chunks: list[PaperChunk], *, rebuild: bool = False) -> dict[str, Any]:
        if not chunks:
            raise VectorServiceError("没有可嵌入的文本内容。")
        try:
            first_vector = self.embeddings.embed([chunks[0].text])[0]
            self._ensure_table(len(first_vector), rebuild=rebuild)
            self._delete_source(chunks[0].source_path)
            self._upsert(chunks)
            state = self._state()
            state["documents"][chunks[0].source_path] = {"hash": chunks[0].document_hash, "chunks": len(chunks)}
            state.update(schema_version=self.SCHEMA_VERSION, embedding_model=self.settings.embedding_model)
            self._save_state(state)
            return {"table": self.settings.table_name, "files_indexed": 1, "chunks_indexed": len(chunks), "embedding_model": self.settings.embedding_model}
        except OllamaEmbeddingError as error:
            raise VectorServiceError(str(error)) from error
        except VectorServiceError:
            raise
        except Exception as error:
            raise VectorServiceError(f"SeekDB 索引失败：{error}") from error

    def index_papers(self, *, rebuild: bool = False) -> dict[str, Any]:
        files = discover_markdown_files(self.settings.paper_root)
        if not files:
            raise VectorServiceError(f"未在 {self.settings.paper_root} 找到 Markdown 论文。")
        prepared = [(path, chunks_for_file(path, self.settings.paper_root, chunk_size=self.settings.chunk_size, overlap=self.settings.chunk_overlap)) for path in files]
        prepared = [(path, chunks) for path, chunks in prepared if chunks]
        if not prepared:
            raise VectorServiceError("资料没有可嵌入的文本内容。")
        next_documents = {chunks[0].source_path: {"hash": chunks[0].document_hash, "chunks": len(chunks)} for _, chunks in prepared}
        old_documents = {} if rebuild else self._state().get("documents", {})
        try:
            first_vector = self.embeddings.embed([prepared[0][1][0].text])[0]
            self._ensure_table(len(first_vector), rebuild=rebuild)
            removed = set(old_documents) - set(next_documents)
            changed = [(path, chunks) for path, chunks in prepared if rebuild or old_documents.get(chunks[0].source_path, {}).get("hash") != chunks[0].document_hash]
            for source_path in removed:
                self._delete_source(source_path)
            for _, chunks in changed:
                self._delete_source(chunks[0].source_path)
                self._upsert(chunks)
            self._save_state({"schema_version": self.SCHEMA_VERSION, "embedding_model": self.settings.embedding_model, "documents": next_documents})
            return {"table": self.settings.table_name, "files_seen": len(files), "files_indexed": len(changed), "files_removed": len(removed), "chunks_indexed": sum(len(chunks) for _, chunks in changed), "embedding_model": self.settings.embedding_model}
        except OllamaEmbeddingError as error:
            raise VectorServiceError(str(error)) from error
        except Exception as error:
            raise VectorServiceError(f"SeekDB 索引失败：{error}") from error

    def migrate_provenance(self) -> dict[str, Any]:
        return {"table": self.settings.table_name, "migrated": False, "reason": "SeekDB 索引从创建时即保存完整溯源字段，无需迁移。"}

    def filters(self, *, categories: list[str] | None = None, books: list[str] | None = None) -> dict[str, Any]:
        if not self._table_exists():
            return {"collection": self.settings.table_name, "categories": [], "books": [], "chapters": []}
        categories, books = [value for value in categories or [] if value], [value for value in books or [] if value]
        cat_clause = "" if not categories else f" WHERE category IN ({','.join(['%s'] * len(categories))})"
        category_rows = self._query(f"SELECT DISTINCT category FROM `{self.settings.table_name}` ORDER BY category")
        book_rows = self._query(f"SELECT DISTINCT book FROM `{self.settings.table_name}`{cat_clause} ORDER BY book", tuple(categories))
        conditions, values = [], []
        for column, selected in (("category", categories), ("book", books)):
            if selected:
                conditions.append(f"{column} IN ({','.join(['%s'] * len(selected))})")
                values.extend(selected)
        clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        chapter_rows = self._query(f"SELECT DISTINCT chapter FROM `{self.settings.table_name}`{clause} ORDER BY chapter", tuple(values))
        return {"collection": self.settings.table_name, "categories": [str(row[0]) for row in category_rows], "books": [str(row[0]) for row in book_rows], "chapters": [str(row[0]) for row in chapter_rows]}

    @staticmethod
    def _cosine(left: list[float], right: list[float]) -> float:
        denominator = math.sqrt(sum(x * x for x in left)) * math.sqrt(sum(x * x for x in right))
        return 0.0 if not denominator else sum(a * b for a, b in zip(left, right, strict=True)) / denominator

    @staticmethod
    def _lexical_search(rows: list[dict[str, Any]], query: str, limit: int) -> list[dict[str, Any]]:
        terms = list(dict.fromkeys(re.findall(r"[A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]", query.casefold())))
        ranked = []
        for row in rows:
            content = str(row.get("content", "")).casefold()
            score = sum(content.count(term) for term in terms)
            if score:
                row.pop("vector", None)
                row["score"] = score / max(1, len(terms))
                ranked.append(row)
        return sorted(ranked, key=lambda item: float(item["score"]), reverse=True)[:limit]

    def search(self, *, query: str, limit: int, categories: list[str] | None = None, books: list[str] | None = None, chapters: list[str] | None = None) -> list[dict[str, Any]]:
        if not self._table_exists():
            return []
        try:
            conditions, values = [], []
            for column, selected in (("category", categories), ("book", books), ("chapter", chapters)):
                clean = [value for value in selected or [] if value]
                if clean:
                    conditions.append(f"{column} IN ({','.join(['%s'] * len(clean))})")
                    values.extend(clean)
            clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
            columns = ("id", "vector", "content", "source_path", "category", "book", "chapter", "heading_path", "line_start", "line_end", "char_start", "char_end", "chunk_index", "document_hash")
            rows = [dict(zip(columns, raw_row, strict=True)) for raw_row in self._query(f"SELECT {', '.join(columns)} FROM `{self.settings.table_name}`{clause}", tuple(values))]
            try:
                vector = self.embeddings.embed([query])[0]
            except OllamaEmbeddingError:
                return self._lexical_search(rows, query, limit)
            ranked = []
            for row in rows:
                try:
                    score = self._cosine(vector, [float(value) for value in json.loads(row.pop("vector"))])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                row["score"] = score
                ranked.append(row)
            return sorted(ranked, key=lambda item: float(item["score"]), reverse=True)[:limit]
        except Exception as error:
            raise VectorServiceError(f"SeekDB 向量检索失败：{error}") from error

    def status(self) -> dict[str, Any]:
        try:
            created = self._table_exists()
            rows = self._query(f"SELECT COUNT(*) AS rows FROM `{self.settings.table_name}`")[0][0] if created else 0
            return {"collection": self.settings.table_name, "created": created, "rows": int(rows), "embedding_model": self.settings.embedding_model, "paper_root": str(self.settings.paper_root)}
        except Exception as error:
            raise VectorServiceError(f"SeekDB 状态读取失败：{error}") from error

    def schema(self) -> dict[str, Any]:
        try:
            created = self._table_exists()
            fields = []
            if created:
                for row in self._query(f"DESCRIBE `{self.settings.table_name}`"):
                    role, index = self.FIELD_ROLES.get(str(row[0]), ("字段", "—"))
                    fields.append({"name": str(row[0]), "type": str(row[1]).upper(), "role": role, "index": index})
            return {"engine": "SeekDB", "storage": str(self.settings.seekdb_dir), "collection": self.settings.table_name, "created": created, "embedding_model": self.settings.embedding_model, "dimension": self._dimension(), "fields": fields}
        except Exception as error:
            raise VectorServiceError(f"SeekDB 结构读取失败：{error}") from error
