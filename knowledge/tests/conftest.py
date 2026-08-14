from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        knowledge_root=tmp_path / "notes",
        state_dir=tmp_path / "state",
        api_key="test-secret-key",
        cors_origins=("http://localhost:3000",),
        embedding_backend="hash",
        embedding_dimension=128,
        auto_index=False,
        semantic_threshold=0.0,
        semantic_neighbors=10,
        extractor_url="local://",
        import_free_space_reserve_bytes=64 * 1024 * 1024,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def auth() -> dict[str, str]:
    return {"X-API-Key": "test-secret-key"}
