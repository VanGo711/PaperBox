from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _url(value: str, default: str) -> str:
    raw = value.strip() or default
    if not raw.startswith(("http://", "https://")):
        raw = f"http://{raw}"
    return raw.rstrip("/")


@dataclass(frozen=True)
class VectorSettings:
    project_root: Path
    paper_root: Path
    state_file: Path
    seekdb_dir: Path
    table_name: str
    ollama_url: str
    embedding_model: str
    chunk_size: int
    chunk_overlap: int
    embedding_batch_size: int
    powercontext_dir: Path

    @classmethod
    def from_environment(cls) -> "VectorSettings":
        project_root = Path(__file__).resolve().parents[3]
        paper_root = Path(os.getenv("PAPER_ROOT", project_root / "data" / "papers")).resolve()
        state_file = Path(os.getenv("VECTOR_STATE_FILE", project_root / "data" / "vector" / "index_state.json")).resolve()
        return cls(
            project_root=project_root,
            paper_root=paper_root,
            state_file=state_file,
            seekdb_dir=Path(os.getenv("SEEKDB_DIR", project_root / "data" / "vector" / "seekdb")).resolve(),
            table_name=os.getenv("SEEKDB_TABLE", "paper_chunks"),
            ollama_url=_url(os.getenv("OLLAMA_URL", os.getenv("OLLAMA_HOST", "")), "http://127.0.0.1:11434"),
            embedding_model=os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:4b"),
            chunk_size=int(os.getenv("VECTOR_CHUNK_SIZE", "1100")),
            chunk_overlap=int(os.getenv("VECTOR_CHUNK_OVERLAP", "160")),
            embedding_batch_size=int(os.getenv("VECTOR_EMBED_BATCH_SIZE", "16")),
            powercontext_dir=Path(os.getenv("POWERCONTEXT_DIR", project_root / "data" / "powercontext")).resolve(),
        )
