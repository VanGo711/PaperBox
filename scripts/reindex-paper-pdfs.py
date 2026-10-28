"""Rebuild SeekDB and PowerContext data for existing PDFs using the current text splitter."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.backend.context.powercontext import PowerContextService
from src.backend.context.runtime import create_embedded_powercontext_app
from src.backend.papers.service import PaperImportError, reindex_pdf
from src.backend.vector.config import VectorSettings
from src.backend.vector.service import PaperVectorService


async def rebuild(paths: list[Path], root: Path) -> list[dict[str, object]]:
    settings = VectorSettings.from_environment()
    context_app = create_embedded_powercontext_app(settings)
    results: list[dict[str, object]] = []
    async with context_app.router.lifespan_context(context_app):
        vectors = PaperVectorService(settings)
        context = PowerContextService(context_app, settings)
        for number, path in enumerate(paths, start=1):
            try:
                result = reindex_pdf(path, root, vectors, context)
                results.append({"path": path.relative_to(root).as_posix(), "ok": True, "title": result["title"], "pages": result["pages"], "chunks": result["index"].get("chunks_indexed", 0)})
                print(f"[{number}/{len(paths)}] 已重建：{result['title']}", flush=True)
            except PaperImportError as error:
                results.append({"path": path.relative_to(root).as_posix(), "ok": False, "error": str(error)})
                print(f"[{number}/{len(paths)}] 失败：{path.name}：{error}", flush=True)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="仅重建包含该相对路径片段的一篇 PDF。")
    arguments = parser.parse_args()
    root = PROJECT_ROOT / "data" / "papers"
    paths = sorted(path for path in root.rglob("*.pdf") if path.is_file())
    if arguments.only:
        paths = [path for path in paths if arguments.only in path.relative_to(root).as_posix()]
    if not paths:
        raise SystemExit("没有找到匹配的论文 PDF。")
    results = asyncio.run(rebuild(paths, root))
    print(json.dumps({"processed": len(results), "succeeded": sum(item["ok"] for item in results), "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
