from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class NodeKind(str, Enum):
    note = "note"
    skill = "skill"
    memory = "memory"
    insight = "insight"
    task = "task"


class NodeSummary(BaseModel):
    id: str
    kind: NodeKind
    title: str
    path: str
    excerpt: str = ""
    tags: list[str] = Field(default_factory=list)
    permanent: bool = False
    created_at: datetime
    updated_at: datetime
    revision: str
    editable: bool = False
    deletable: bool = False
    source: Literal["vault", "hermes-skill", "hermes-memory"] = "vault"
    # A safe desktop deep-link for files in the editable Obsidian vault. Hermes
    # skills/memories mounted from other roots deliberately have no URI.
    obsidian_uri: str | None = None


class NodeDetail(NodeSummary):
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    outgoing_links: list[str] = Field(default_factory=list)
    index_state: Literal["ready", "pending"] = "ready"


class DeleteNodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
    )


class DeleteNodeResponse(BaseModel):
    id: str
    status: Literal["trashed"] = "trashed"
    recovery: Literal["available"] = "available"
    trashed_path: str = Field(max_length=4_096)
    index_state: Literal["ready", "pending"] = "ready"
    original_trashed: bool = False


class SearchHit(BaseModel):
    node: NodeSummary
    score: float
    semantic_score: float
    lexical_score: float = 0.0
    matched_terms: list[str] = Field(default_factory=list)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=10, ge=1, le=100)
    kinds: list[NodeKind] | None = None
    tags: list[str] | None = None


class GraphNode(NodeSummary):
    degree: int = 0


class GraphEdge(BaseModel):
    source: str
    target: str
    relation: Literal["references", "semantic", "tag", "derived-from"]
    weight: float = Field(ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    generation: int


class Connection(BaseModel):
    source: NodeSummary
    target: NodeSummary
    score: float
    semantic_score: float
    shared_tags: list[str] = Field(default_factory=list)
    shared_terms: list[str] = Field(default_factory=list)
    reason: str


class DiscoverRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str | None = None
    limit: int = Field(default=10, ge=1, le=100)
    min_score: float = Field(default=0.36, ge=0.0, le=1.0)
    kinds: list[NodeKind] | None = None


class ActivationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed_ids: list[str] = Field(min_length=1, max_length=20)
    depth: int = Field(default=3, ge=1, le=8)
    decay: float = Field(default=0.65, gt=0.0, le=1.0)
    limit: int = Field(default=30, ge=1, le=200)
    semantic: bool = True


class ActivatedNode(BaseModel):
    node: NodeSummary
    activation: float
    depth: int
    via: str | None = None


class ActivationResponse(BaseModel):
    seeds: list[str]
    nodes: list[ActivatedNode]


class CreateNoteRequest(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(default="", max_length=2_000_000)
    tags: list[str] = Field(default_factory=list, max_length=100)
    kind: NodeKind = NodeKind.note
    links: list[str] = Field(default_factory=list, max_length=200)
    permanent: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def safe_title(cls, value: str) -> str:
        title = " ".join(value.split()).strip()
        if not title or any(char in title for char in "\x00\r\n"):
            raise ValueError("title must be a single non-empty line")
        return title

    @field_validator("tags", "links")
    @classmethod
    def clean_values(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))

    @field_validator("idempotency_key")
    @classmethod
    def safe_idempotency_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned or any(ord(character) < 32 for character in cleaned):
            raise ValueError("idempotency_key must not contain control characters")
        return cleaned


class UpdateNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=240)
    content: str | None = Field(default=None, max_length=2_000_000)
    tags: list[str] | None = Field(default=None, max_length=100)
    links: list[str] | None = Field(default=None, max_length=200)
    permanent: bool | None = None
    metadata: dict[str, Any] | None = None
    expected_revision: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")

    @field_validator("title")
    @classmethod
    def safe_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        title = " ".join(value.split()).strip()
        if not title or any(char in title for char in "\x00\r\n"):
            raise ValueError("title must be a single non-empty line")
        return title

    @field_validator("tags", "links")
    @classmethod
    def clean_values(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))

    @model_validator(mode="after")
    def non_empty(self) -> UpdateNoteRequest:
        if not (self.model_fields_set - {"expected_revision"}):
            raise ValueError("at least one field is required")
        return self


class PromoteNoteRequest(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    title: str | None = Field(default=None, min_length=1, max_length=240)
    summary: str | None = Field(default=None, max_length=20_000)
    tags: list[str] | None = Field(default=None, max_length=100)

    @field_validator("title")
    @classmethod
    def safe_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        title = " ".join(value.split()).strip()
        if not title or any(char in title for char in "\x00\r\n"):
            raise ValueError("title must be a single non-empty line")
        return title

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class IngestRequest(CreateNoteRequest):
    source: str | None = Field(default=None, max_length=2_000)


class InsightRequest(BaseModel):
    node_ids: list[str] | None = Field(default=None, max_length=100)
    limit: int = Field(default=10, ge=1, le=100)
    minimum_words: int = Field(default=6, ge=3, le=50)
    include_permanent: bool = False


class InsightCandidate(BaseModel):
    source: NodeSummary
    text: str
    suggested_title: str
    suggested_tags: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str


class IndexReport(BaseModel):
    generation: int
    nodes: int
    links: int
    duration_ms: int
    backend: str
    fingerprint: str


class StatsResponse(BaseModel):
    generation: int
    total_nodes: int
    nodes_by_kind: dict[str, int]
    explicit_links: int
    permanent_notes: int
    embedding_backend: str
    vector_backend: str
    dimension: int
    last_indexed_at: datetime | None
    last_index_duration_ms: int | None
    fingerprint: str | None
    indexing: bool
    last_error: str | None


class VaultInfo(BaseModel):
    """Public vault metadata that intentionally omits the server filesystem path."""

    name: str
    format: Literal["obsidian-markdown"] = "obsidian-markdown"
    obsidian_uri: str
    mutation_mode: Literal["api-only"] = "api-only"
    auto_index: bool
    scan_interval_seconds: int


class HealthResponse(BaseModel):
    status: Literal["ok", "starting", "degraded"]
    service: str = "hermes-knowledge"
    ready: bool
    auth_configured: bool
    generation: int
    nodes: int
    embedding_backend: str
    last_error: str | None = None


class ImportCapabilities(BaseModel):
    max_files: int
    max_file_bytes: int
    max_total_bytes: int
    accepted_extensions: list[str]
    accepted_media_types: list[str]
    malware_scan: bool = False


class ImportResult(BaseModel):
    filename: str
    status: Literal["imported", "duplicate"]
    node: NodeSummary
    sha256: str
    media_type: str
    extractor: str


class ImportResponse(BaseModel):
    results: list[ImportResult]
    index_state: Literal["ready", "pending"] = "ready"
