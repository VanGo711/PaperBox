from __future__ import annotations

from powercontext.builtin.persistence.sqlite.profile import SQLiteConfig
from powercontext.server.factory import create_server_app
from powercontext.server.settings import DashboardConfig, McpConfig, MetricsConfig, ServerLoggingConfig, ServerSettings

from src.backend.vector.config import VectorSettings


def create_embedded_powercontext_app(settings: VectorSettings):
    """Build a child app whose lifespan is owned by the PaperBox backend."""
    return create_server_app(settings=ServerSettings(
        workspace=settings.project_root,
        # PowerContext stays fully in-process. SeekDB is reserved for the
        # paper vector index; SQLite avoids a second embedded database daemon.
        database=SQLiteConfig(url=f"sqlite+aiosqlite:///{settings.powercontext_dir / 'powercontext.db'}"),
        mcp=McpConfig(enabled=False),
        dashboard=DashboardConfig(enabled=False),
        metrics=MetricsConfig(enabled=False),
        logging=ServerLoggingConfig(access=False, file=False),
    ))
