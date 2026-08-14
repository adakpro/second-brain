from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _float(
    name: str, default: float, minimum: float = 0.0, maximum: float = 1.0
) -> float:
    try:
        return min(maximum, max(minimum, float(os.getenv(name, str(default)))))
    except ValueError:
        return default


def _csv(name: str, default: str = "") -> tuple[str, ...]:
    return tuple(
        item.strip() for item in os.getenv(name, default).split(",") if item.strip()
    )


def _paths(name: str) -> tuple[Path, ...]:
    # Commas are deliberate: unlike os.pathsep, they also work for Windows paths.
    return tuple(Path(value).expanduser() for value in _csv(name))


def _safe_vault_name(value: str, default: str = "HERMESS") -> str:
    """Return an Obsidian vault label, never a filesystem path."""
    value = value.strip()
    if (
        not value
        or len(value) > 200
        or any(character in value for character in ("/", "\\", "\x00", "\r", "\n"))
    ):
        return default
    return value


def _vault_name(name: str, default: str = "HERMESS") -> str:
    return _safe_vault_name(os.getenv(name, default), default)


def _sync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _prepare_directory(directory: Path, mode: int = 0o755) -> None:
    missing: list[Path] = []
    cursor = directory
    while not cursor.exists() and cursor != cursor.parent:
        missing.append(cursor)
        cursor = cursor.parent
    for path in reversed(missing):
        path.mkdir(mode=mode if path == directory else 0o755)
        # Persist each newly-created directory entry, including intermediate
        # ancestors on a fresh custom root, before confirming readiness.
        _sync_directory(path.parent)
        _sync_directory(path)
    _sync_directory(directory)


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime configuration, intentionally independent of pydantic-settings."""

    knowledge_root: Path = Path("/data/notes")
    state_dir: Path = Path("/data/state")
    vault_name: str = "HERMESS"
    ignored_directories: tuple[str, ...] = (
        ".obsidian",
        ".trash",
        ".git",
        ".hg",
        ".svn",
        ".stfolder",
    )
    skill_roots: tuple[Path, ...] = ()
    memory_roots: tuple[Path, ...] = ()
    # Each pattern denotes a Hermes HERMES_HOME. The repository only imports
    # its skills plus MEMORY.md/USER.md; no databases/config/auth are scanned.
    hermes_homes: tuple[Path, ...] = ()
    api_key: str = ""
    allow_insecure: bool = False
    cors_origins: tuple[str, ...] = ("http://localhost:3000",)
    embedding_backend: str = "auto"
    model_name: str = "sentence-transformers/all-MiniLM-L6-v2"
    model_revision: str = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
    model_allow_download: bool = False
    embedding_dimension: int = 384
    auto_index: bool = True
    scan_interval_seconds: int = 60
    semantic_threshold: float = 0.36
    semantic_neighbors: int = 5
    max_note_bytes: int = 2 * 1024 * 1024
    max_nodes: int = 20_000
    import_max_files: int = 12
    import_max_file_bytes: int = 16 * 1024 * 1024
    import_max_total_bytes: int = 64 * 1024 * 1024
    import_max_extracted_bytes: int = 1_800_000
    import_parser_timeout_seconds: int = 30
    import_batch_deadline_seconds: int = 90
    extractor_url: str = ""
    import_original_quota_bytes: int = 4 * 1024 * 1024 * 1024
    import_free_space_reserve_bytes: int = 1024 * 1024 * 1024
    docs_enabled: bool = False
    log_level: str = "INFO"

    def __post_init__(self) -> None:
        # Directly constructed Settings are used by tests and embedders; keep
        # the same path-rejection contract as environment-loaded settings.
        object.__setattr__(self, "vault_name", _safe_vault_name(self.vault_name))
        object.__setattr__(self, "import_max_files", min(12, max(1, self.import_max_files)))
        object.__setattr__(
            self,
            "import_max_file_bytes",
            min(16 * 1024 * 1024, max(1024, self.import_max_file_bytes)),
        )
        object.__setattr__(
            self,
            "import_max_total_bytes",
            min(64 * 1024 * 1024, max(1024, self.import_max_total_bytes)),
        )
        extracted_ceiling = min(1_900_000, max(1024, self.max_note_bytes - 128 * 1024))
        object.__setattr__(
            self,
            "import_max_extracted_bytes",
            min(extracted_ceiling, max(1024, self.import_max_extracted_bytes)),
        )
        object.__setattr__(
            self,
            "import_parser_timeout_seconds",
            min(30, max(1, self.import_parser_timeout_seconds)),
        )
        object.__setattr__(
            self,
            "import_batch_deadline_seconds",
            min(90, max(5, self.import_batch_deadline_seconds)),
        )
        object.__setattr__(
            self,
            "import_original_quota_bytes",
            min(8 * 1024**3, max(64 * 1024**2, self.import_original_quota_bytes)),
        )
        object.__setattr__(
            self,
            "import_free_space_reserve_bytes",
            min(4 * 1024**3, max(64 * 1024**2, self.import_free_space_reserve_bytes)),
        )

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            knowledge_root=Path(
                os.getenv("KNOWLEDGE_ROOT", "/data/notes")
            ).expanduser(),
            state_dir=Path(
                os.getenv("KNOWLEDGE_STATE_DIR", "/data/state")
            ).expanduser(),
            vault_name=_vault_name("KNOWLEDGE_VAULT_NAME"),
            ignored_directories=_csv(
                "KNOWLEDGE_IGNORED_DIRECTORIES",
                ".obsidian,.trash,.git,.hg,.svn,.stfolder",
            ),
            skill_roots=_paths("KNOWLEDGE_SKILLS_PATHS"),
            memory_roots=_paths("KNOWLEDGE_MEMORIES_PATHS"),
            hermes_homes=_paths("KNOWLEDGE_HERMES_HOMES"),
            api_key=os.getenv("KNOWLEDGE_API_KEY", "").strip(),
            allow_insecure=_bool("KNOWLEDGE_ALLOW_INSECURE", False),
            cors_origins=_csv("KNOWLEDGE_CORS_ORIGINS", "http://localhost:3000"),
            embedding_backend=os.getenv("KNOWLEDGE_EMBEDDING_BACKEND", "auto")
            .strip()
            .lower(),
            model_name=os.getenv(
                "KNOWLEDGE_MODEL_NAME", "sentence-transformers/all-MiniLM-L6-v2"
            ).strip(),
            model_revision=os.getenv(
                "KNOWLEDGE_MODEL_REVISION",
                "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
            ).strip(),
            model_allow_download=_bool("KNOWLEDGE_MODEL_ALLOW_DOWNLOAD", False),
            embedding_dimension=_int("KNOWLEDGE_EMBEDDING_DIMENSION", 384, 64),
            auto_index=_bool("KNOWLEDGE_AUTO_INDEX", True),
            scan_interval_seconds=_int("KNOWLEDGE_SCAN_INTERVAL_SECONDS", 60, 5),
            semantic_threshold=_float("KNOWLEDGE_SEMANTIC_THRESHOLD", 0.36),
            semantic_neighbors=_int("KNOWLEDGE_SEMANTIC_NEIGHBORS", 5, 1),
            max_note_bytes=_int("KNOWLEDGE_MAX_NOTE_BYTES", 2 * 1024 * 1024, 1024),
            max_nodes=_int("KNOWLEDGE_MAX_NODES", 20_000, 1),
            import_max_files=_int("KNOWLEDGE_IMPORT_MAX_FILES", 12, 1),
            import_max_file_bytes=_int(
                "KNOWLEDGE_IMPORT_MAX_FILE_BYTES", 16 * 1024 * 1024, 1024
            ),
            import_max_total_bytes=_int(
                "KNOWLEDGE_IMPORT_MAX_TOTAL_BYTES", 64 * 1024 * 1024, 1024
            ),
            import_max_extracted_bytes=_int(
                "KNOWLEDGE_IMPORT_MAX_EXTRACTED_BYTES", 1_800_000, 1024
            ),
            import_parser_timeout_seconds=min(
                90, _int("KNOWLEDGE_IMPORT_PARSER_TIMEOUT_SECONDS", 30, 1)
            ),
            # Must finish before the frontend BFF's fixed 120-second timeout,
            # leaving bounded response and network overhead.
            import_batch_deadline_seconds=min(
                100, _int("KNOWLEDGE_IMPORT_BATCH_DEADLINE_SECONDS", 90, 5)
            ),
            extractor_url=os.getenv("KNOWLEDGE_EXTRACTOR_URL", "").strip(),
            import_original_quota_bytes=_int(
                "KNOWLEDGE_IMPORT_ORIGINAL_QUOTA_BYTES", 4 * 1024**3, 64 * 1024**2
            ),
            import_free_space_reserve_bytes=_int(
                "KNOWLEDGE_IMPORT_FREE_SPACE_RESERVE_BYTES", 1024**3, 64 * 1024**2
            ),
            docs_enabled=_bool("KNOWLEDGE_DOCS_ENABLED", False),
            log_level=os.getenv("KNOWLEDGE_LOG_LEVEL", "INFO").upper(),
        )

    @property
    def auth_configured(self) -> bool:
        return bool(self.api_key) or self.allow_insecure

    def prepare_directories(self) -> None:
        _prepare_directory(self.knowledge_root)
        _prepare_directory(self.state_dir)
        _prepare_directory(self.state_dir / "originals", 0o700)
        _prepare_directory(self.state_dir / "import-staging", 0o700)
        _prepare_directory(self.state_dir / "import-spool", 0o700)
        for name in (
            "inbox",
            "permanent",
            "skills",
            "memories",
            "insights",
            "tasks",
        ):
            directory = self.knowledge_root / name
            _prepare_directory(directory)
            if name in {"inbox", "permanent"}:
                _prepare_directory(directory / "imports")
