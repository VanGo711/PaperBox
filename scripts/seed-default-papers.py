"""Seed and index the curated Text2SQL papers used by a fresh PaperBox install."""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.backend.context.powercontext import PowerContextService
from src.backend.context.runtime import create_embedded_powercontext_app
from src.backend.papers.service import index_pdf
from src.backend.vector.config import VectorSettings
from src.backend.vector.service import PaperVectorService


DEFAULT_PAPERS = (
    ("01_rat_sql", "RAT-SQL - Relation-Aware Schema Encoding and Linking for Text-to-SQL Parsers.pdf", "RAT-SQL: Relation-Aware Schema Encoding and Linking for Text-to-SQL Parsers"),
    ("02_alpha_sql", "Alpha-SQL - Zero-Shot Text-to-SQL using Monte Carlo Tree Search.pdf", "Alpha-SQL: Zero-Shot Text-to-SQL using Monte Carlo Tree Search"),
    ("03_text2sql_survey", "A Survey of Text-to-SQL in the Era of LLMs - Where Are We, and Where Are We Going -.pdf", "A Survey of Text-to-SQL in the Era of LLMs: Where Are We, and Where Are We Going?"),
    ("04_schema_rag", "SchemaRAG - A Schema-aware Retrieval-Augmented Generation Framework for Text-to-SQL.pdf", "SchemaRAG: A Schema-aware Retrieval-Augmented Generation Framework for Text-to-SQL"),
    ("05_cred_sql", "CRED-SQL - Enhancing Real-world Large Scale Database Text-to-SQL Parsing through Cluster Retrieval and Execution Description.pdf", "CRED-SQL: Enhancing Real-world Large Scale Database Text-to-SQL Parsing through Cluster Retrieval and Execution Description"),
    ("06_mac_sql", "MAC-SQL - A Multi-Agent Collaborative Framework for Text-to-SQL.pdf", "MAC-SQL: A Multi-Agent Collaborative Framework for Text-to-SQL"),
    ("07_sql_o1", "SQL-o1 - A Self-Reward Heuristic Dynamic Search Method for Text-to-SQL.pdf", "SQL-o1: A Self-Reward Heuristic Dynamic Search Method for Text-to-SQL"),
    ("08_deepeye_sql", "DeepEye-SQL - A Software-Engineering-Inspired Text-to-SQL Framework.pdf", "DeepEye-SQL: A Software-Engineering-Inspired Text-to-SQL Framework"),
    ("09_text2sql_eval", "Text-to-SQL Evaluation Toolkit.pdf", "Text-to-SQL Evaluation Toolkit"),
    ("10_benchmark_analysis", "Analysis of Text-to-SQL Benchmarks - Limitations, Challenges and Opportunities.pdf", "Analysis of Text-to-SQL Benchmarks: Limitations, Challenges and Opportunities"),
)


def project_root() -> Path:
    return PROJECT_ROOT


def copy_papers(root: Path) -> list[tuple[Path, str]]:
    source_root = root / "backup" / "paper-text2sql"
    destination_root = root / "data" / "papers" / "1_Text2SQL"
    destination_root.mkdir(parents=True, exist_ok=True)
    copied: list[tuple[Path, str]] = []
    for slug, filename, title in DEFAULT_PAPERS:
        source = source_root / filename
        if not source.is_file():
            raise FileNotFoundError(f"默认论文不存在：{source}")
        folder = destination_root / slug
        folder.mkdir(parents=True, exist_ok=True)
        destination = folder / "paper.pdf"
        shutil.copy2(source, destination)
        copied.append((destination, title))
    return copied


async def index_papers(copied: list[tuple[Path, str]], root: Path) -> list[dict]:
    settings = VectorSettings.from_environment()
    context_app = create_embedded_powercontext_app(settings)
    context = PowerContextService(context_app, settings)
    results: list[dict] = []
    async with context_app.router.lifespan_context(context_app):
        vectors = PaperVectorService(settings)
        for number, (path, title) in enumerate(copied, start=1):
            print(f"[{number}/{len(copied)}] 正在处理：{title}", flush=True)
            result = index_pdf(path, root / "data" / "papers", vectors, context, title=title)
            results.append({
                "title": title,
                "pages": result["pages"],
                "chunks": result["index"].get("chunks_indexed", 0),
                "llm_error": result.get("llm_error", ""),
            })
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy-only", action="store_true", help="只写入默认 PDF，不执行 LLM、向量和上下文处理。")
    parser.add_argument("--only", choices=[item[0] for item in DEFAULT_PAPERS], help="只处理指定默认论文，用于可恢复的单篇重试。")
    arguments = parser.parse_args()
    root = project_root()
    copied = copy_papers(root)
    if arguments.only:
        copied = [(path, title) for path, title in copied if path.parent.name == arguments.only]
    if arguments.copy_only:
        print(json.dumps({"copied": len(copied), "indexed": False}, ensure_ascii=False))
        return
    results = asyncio.run(index_papers(copied, root))
    print(json.dumps({"copied": len(copied), "indexed": len(results), "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
