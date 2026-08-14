from __future__ import annotations

import ctypes
import errno
import glob
import hashlib
import json
import os
import re
import secrets
import stat
import tempfile
import time
import unicodedata
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlencode

import yaml

from .config import Settings
from .models import NodeDetail, NodeKind, NodeSummary

FRONT_MATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
WIKI_LINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
MARKDOWN_LINK = re.compile(
    r"(?<!!)\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]+)?\)", re.IGNORECASE
)
WORDS = re.compile(r"[\w][\w'-]{1,}", re.UNICODE)
RESERVED_METADATA = {
    "id",
    "title",
    "type",
    "kind",
    "tags",
    "links",
    "permanent",
    "status",
    "created_at",
    "updated_at",
    "hermess_idempotency_key_sha256",
    "hermess_idempotency_payload_sha256",
}
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
TEMPORARY_MARKDOWN_SUFFIXES = (".tmp.md", ".swp.md", ".swo.md")
SYSTEM_MANAGED_NODE_IDS = frozenset(
    {
        "welcome-to-hermes-knowledge",
        "memory-operator-preferences",
        "skill-daily-synthesis",
    }
)


class RevisionConflictError(Exception):
    """Raised when a client tries to replace a note it did not last read."""


class IdempotencyConflictError(Exception):
    """Raised when one durable create key is reused for a different note."""


class ConditionalWriteUnavailableError(Exception):
    """Raised when the host cannot safely perform a revision-checked replace."""


class NoteTooLargeError(OSError):
    """Raised when a note grows beyond the configured safe read bound."""


AT_FDCWD = -100
RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
_RENAMEAT2_UNAVAILABLE = {
    errno.ENOSYS,
    errno.EINVAL,
    errno.EXDEV,
    getattr(errno, "EOPNOTSUPP", errno.ENOSYS),
    getattr(errno, "ENOTSUP", errno.ENOSYS),
}


def _renameat2(source: Path, destination: Path, flags: int) -> None:
    """Invoke Linux renameat2 without shelling out or guessing syscall numbers."""
    if os.name != "posix":
        raise ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this platform"
        )
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameat2
    except (AttributeError, OSError) as exc:
        raise ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this platform"
        ) from exc
    rename.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    rename.restype = ctypes.c_int
    result = rename(
        AT_FDCWD,
        os.fsencode(source),
        AT_FDCWD,
        os.fsencode(destination),
        flags,
    )
    if result == 0:
        return
    error = ctypes.get_errno()
    if error in _RENAMEAT2_UNAVAILABLE:
        raise ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this filesystem"
        )
    raise OSError(error, os.strerror(error), os.fspath(destination))


def _renameat2_at(
    source_directory_fd: int,
    source_name: str,
    destination_directory_fd: int,
    destination_name: str,
    flags: int,
) -> None:
    """renameat2 with already-verified directory handles, closing symlink races."""
    if os.name != "posix":
        raise ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this platform"
        )
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameat2
    except (AttributeError, OSError) as exc:
        raise ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this platform"
        ) from exc
    rename.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    rename.restype = ctypes.c_int
    result = rename(
        source_directory_fd,
        os.fsencode(source_name),
        destination_directory_fd,
        os.fsencode(destination_name),
        flags,
    )
    if result == 0:
        return
    error = ctypes.get_errno()
    if error in _RENAMEAT2_UNAVAILABLE:
        raise ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this filesystem"
        )
    raise OSError(error, os.strerror(error), destination_name)


def _rename_exchange(source: Path, destination: Path) -> None:
    _renameat2(source, destination, RENAME_EXCHANGE)


def _rename_noreplace(source: Path, destination: Path) -> None:
    _renameat2(source, destination, RENAME_NOREPLACE)


def utc_now() -> datetime:
    return datetime.now(UTC)


def _datetime(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), tzinfo=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return (
                parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)
            )
        except ValueError:
            pass
    return fallback


def _plain(value: Any) -> Any:
    """Convert PyYAML scalar types into JSON-safe values."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        # Preserve wikilinks containing spaces while supporting comma-separated tags.
        values = value.split(",") if "," in value else [value]
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        values = [value]
    return list(
        dict.fromkeys(str(item).strip() for item in values if str(item).strip())
    )


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().casefold() in {"1", "true", "yes", "on", "permanent"}


def normalize_lookup(value: str) -> str:
    """Normalize a vault-relative link while preserving folder qualification."""
    value = unquote(value).replace("\\", "/").strip().strip("<>")
    while value.startswith("./"):
        value = value[2:]
    value = value.strip("/")
    if value.lower().endswith(".md"):
        value = value[:-3]
    segments = []
    for segment in unicodedata.normalize("NFKC", value).casefold().split("/"):
        normalized = re.sub(r"[^\w]+", " ", segment).strip()
        if normalized:
            segments.append(normalized)
    return "/".join(segments)


def basename_lookup(value: str) -> str:
    return normalize_lookup(value).rsplit("/", 1)[-1]


def obsidian_uri(vault_name: str, path: str | None = None) -> str:
    values = {"vault": vault_name}
    if path:
        values["file"] = path
    # Obsidian requires reserved characters, including slashes, and spaces to
    # be percent-encoded. quote_plus' `+` form is not used here deliberately.
    return f"obsidian://open?{urlencode(values, quote_via=quote)}"


def slugify(value: str) -> str:
    normalized = (
        unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    )
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return slug[:100] or "untitled"


def excerpt(content: str, length: int = 240) -> str:
    without_code = re.sub(r"```.*?```", " ", content, flags=re.DOTALL)
    without_markup = re.sub(r"[#>*_`~-]+", " ", without_code)
    compact = " ".join(without_markup.split())
    return compact if len(compact) <= length else f"{compact[: length - 1].rstrip()}…"


@dataclass(slots=True)
class KnowledgeDocument:
    id: str
    kind: NodeKind
    title: str
    display_path: str
    source_path: Path
    editable: bool
    source: str
    content: str
    tags: list[str]
    link_targets: list[str]
    resolved_links: list[str] = field(default_factory=list)
    permanent: bool = False
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)
    metadata: dict[str, Any] = field(default_factory=dict)
    revision: str = ""
    obsidian_uri: str | None = None
    idempotency_digest: str | None = None
    idempotency_payload_digest: str | None = None
    source_identifier: str | None = None

    @property
    def embedding_text(self) -> str:
        tags = " ".join(self.tags)
        # Bound tokenizer work for unusually large notes. The API and lexical
        # matching still use the complete Markdown body.
        return f"{self.title}\n{tags}\n{self.content[:50_000]}".strip()

    @property
    def terms(self) -> set[str]:
        return {
            word.casefold() for word in WORDS.findall(f"{self.title} {self.content}")
        }

    @property
    def deletable(self) -> bool:
        return (
            self.source == "vault"
            and self.editable
            and self.id not in SYSTEM_MANAGED_NODE_IDS
            and not _truthy(self.metadata.get("system_managed"))
            and not _truthy(self.metadata.get("system_seed"))
        )

    def summary(self) -> NodeSummary:
        return NodeSummary(
            id=self.id,
            kind=self.kind,
            title=self.title,
            path=self.display_path,
            excerpt=excerpt(self.content),
            tags=self.tags,
            permanent=self.permanent,
            created_at=self.created_at,
            updated_at=self.updated_at,
            revision=self.revision,
            editable=self.editable,
            deletable=self.deletable,
            source=self.source,
            obsidian_uri=self.obsidian_uri,
        )

    def detail(self) -> NodeDetail:
        return NodeDetail(
            **self.summary().model_dump(),
            content=self.content,
            metadata=self.metadata,
            outgoing_links=self.resolved_links,
        )


@dataclass(frozen=True, slots=True)
class SourceRoot:
    path: Path
    forced_kind: NodeKind | None
    label: str
    editable: bool
    mode: str = "tree"


@dataclass(frozen=True, slots=True)
class ConditionalExchangeResult:
    matched: bool
    cleanup_temporary: bool
    recovery_retained: bool = False
    restored: bool = True


@dataclass(frozen=True, slots=True)
class TrashReceipt:
    node_id: str
    trashed_path: str
    original_trashed: bool


class MarkdownRepository:
    def __init__(self, settings: Settings):
        self.settings = settings

    def roots(self) -> list[SourceRoot]:
        roots = [SourceRoot(self.settings.knowledge_root, None, "notes", True)]
        homes = self._expanded_hermes_homes()
        home_paths: set[str] = set()
        for ordinal, home in enumerate(homes):
            label = self._hermes_home_label(home, ordinal)
            skills = home / "skills"
            roots.append(
                SourceRoot(skills, NodeKind.skill, f"{label}-skills", False)
            )
            roots.append(
                SourceRoot(
                    home,
                    NodeKind.memory,
                    f"{label}-memories",
                    False,
                    mode="hermes-memory",
                )
            )
            try:
                home_paths.add(str(home.resolve()))
            except OSError:
                home_paths.add(str(home.absolute()))

        for ordinal, path in enumerate(self.settings.skill_roots):
            if self._covered_by_home(path, "skills", home_paths):
                continue
            roots.append(
                SourceRoot(
                    path,
                    NodeKind.skill,
                    self._legacy_root_label(path, NodeKind.skill, ordinal),
                    False,
                )
            )
        for ordinal, path in enumerate(self.settings.memory_roots):
            if self._covered_by_home(path, "memories", home_paths):
                continue
            roots.append(
                SourceRoot(
                    path,
                    NodeKind.memory,
                    self._legacy_root_label(path, NodeKind.memory, ordinal),
                    False,
                )
            )
        unique: dict[str, SourceRoot] = {}
        for root in roots:
            try:
                resolved = str(root.path.resolve())
            except OSError:
                resolved = str(root.path.absolute())
            key = f"{resolved}\0{root.forced_kind}\0{root.mode}"
            unique.setdefault(key, root)
        return list(unique.values())

    def _expanded_hermes_homes(self) -> list[Path]:
        expanded: dict[str, Path] = {}
        for pattern in self.settings.hermes_homes:
            value = str(pattern)
            matches = sorted(glob.glob(value), key=str.casefold)
            if not matches and not glob.has_magic(value):
                matches = [value]
            for match in matches:
                path = Path(match).expanduser()
                if not path.is_dir():
                    continue
                try:
                    key = str(path.resolve())
                except OSError:
                    key = str(path.absolute())
                expanded.setdefault(key, path)
        return list(expanded.values())

    @staticmethod
    def _hermes_home_label(home: Path, ordinal: int) -> str:
        if home.parent.name.casefold() == "profiles":
            return f"hermes-profile-{slugify(home.name)}"
        if home.name.casefold() in {"hermes", ".hermes"}:
            return "hermes"
        path_digest = hashlib.sha256(str(home.absolute()).encode("utf-8")).hexdigest()[:8]
        return f"hermes-home-{slugify(home.name)}-{path_digest or ordinal + 1}"

    @staticmethod
    def _covered_by_home(path: Path, expected_name: str, homes: set[str]) -> bool:
        if path.name.casefold() != expected_name:
            return False
        try:
            parent = str(path.parent.resolve())
        except OSError:
            parent = str(path.parent.absolute())
        return parent in homes

    @staticmethod
    def _legacy_root_label(path: Path, kind: NodeKind, ordinal: int) -> str:
        plural = "skills" if kind is NodeKind.skill else "memories"
        parts = list(path.parts)
        folded = [part.casefold() for part in parts]
        if "profiles" in folded:
            position = folded.index("profiles")
            if position + 1 < len(parts):
                return f"hermes-profile-{slugify(parts[position + 1])}-{plural}"
        return f"hermes-{plural}" if ordinal == 0 else f"hermes-{plural}-{ordinal + 1}"

    def _ignored_directory(self, name: str) -> bool:
        ignored = {value.casefold() for value in self.settings.ignored_directories}
        return name.startswith(".") or name.casefold() in ignored

    @staticmethod
    def _temporary_markdown(name: str) -> bool:
        lowered = name.casefold()
        return (
            name.startswith(".")
            or name.startswith("~$")
            or name.endswith("~")
            or lowered.endswith(TEMPORARY_MARKDOWN_SUFFIXES)
        )

    def _walk_markdown(self, base: Path) -> Iterable[Path]:
        if not base.is_dir():
            return
        # os.walk lets us prune Obsidian metadata/trash before descending;
        # rglob would still traverse those often-large hidden trees.
        for directory, directories, filenames in os.walk(base, followlinks=False):
            current = Path(directory)
            directories[:] = sorted(
                (
                    name
                    for name in directories
                    if not self._ignored_directory(name)
                    and not (current / name).is_symlink()
                ),
                key=str.casefold,
            )
            for filename in sorted(filenames, key=str.casefold):
                if (
                    Path(filename).suffix.casefold() == ".md"
                    and not self._temporary_markdown(filename)
                ):
                    yield current / filename

    def _root_candidates(self, root: SourceRoot) -> Iterable[Path]:
        if root.mode != "hermes-memory":
            yield from self._walk_markdown(root.path)
            return

        # A Hermes home contains sensitive state. Deliberately select only its
        # documented Markdown memory surfaces and the optional memories tree.
        try:
            children = {child.name.casefold(): child for child in root.path.iterdir()}
        except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
            return
        for name in ("memory.md", "user.md"):
            candidate = children.get(name)
            if candidate is not None and candidate.is_file() and not candidate.is_symlink():
                yield candidate
        yield from self._walk_markdown(root.path / "memories")

    def markdown_files(self) -> list[tuple[SourceRoot, Path]]:
        found: list[tuple[SourceRoot, Path]] = []
        seen_files: set[str] = set()
        for root in self.roots():
            if not root.path.exists():
                continue
            try:
                resolved_root = root.path.resolve()
            except OSError:
                continue
            for path in self._root_candidates(root):
                try:
                    relative = path.relative_to(root.path)
                    resolved_path = path.resolve()
                except (ValueError, OSError):
                    continue
                resolved_key = str(resolved_path)
                if (
                    resolved_key in seen_files
                    or any(self._ignored_directory(part) for part in relative.parts[:-1])
                    or path.is_symlink()
                    or not path.is_file()
                    or (
                        resolved_path != resolved_root
                        and resolved_root not in resolved_path.parents
                    )
                ):
                    continue
                seen_files.add(resolved_key)
                found.append((root, path))
        found.sort(key=lambda item: (item[0].label, item[1].as_posix().casefold()))
        if len(found) > self.settings.max_nodes:
            raise RuntimeError(
                f"knowledge base exceeds KNOWLEDGE_MAX_NODES={self.settings.max_nodes}"
            )
        return found

    def _read_stable(self, path: Path) -> tuple[bytes, os.stat_result]:
        """Read one complete version, retrying through an external atomic save."""
        for attempt in range(3):
            try:
                with path.open("rb") as handle:
                    before = os.fstat(handle.fileno())
                    if before.st_size > self.settings.max_note_bytes:
                        raise NoteTooLargeError(
                            f"note exceeds KNOWLEDGE_MAX_NOTE_BYTES: {path.name}"
                        )
                    raw = handle.read(self.settings.max_note_bytes + 1)
                    after = os.fstat(handle.fileno())
            except FileNotFoundError:
                if attempt == 2:
                    raise
                time.sleep(0.005)
                continue
            if len(raw) > self.settings.max_note_bytes:
                raise NoteTooLargeError(
                    f"note exceeds KNOWLEDGE_MAX_NOTE_BYTES: {path.name}"
                )
            stable = (
                before.st_dev == after.st_dev
                and before.st_ino == after.st_ino
                and before.st_size == after.st_size == len(raw)
                and before.st_mtime_ns == after.st_mtime_ns
                and before.st_ctime_ns == after.st_ctime_ns
            )
            if stable:
                return raw, after
            if attempt < 2:
                time.sleep(0.005)
        raise OSError(f"note kept changing while it was read: {path.name}")

    @staticmethod
    def _digest_entry(
        digest: Any, root: SourceRoot, path: Path, raw: bytes
    ) -> None:
        relative = unicodedata.normalize("NFC", path.relative_to(root.path).as_posix())
        digest.update(root.label.encode("utf-8"))
        digest.update(b"\0")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(raw).digest())

    def fingerprint(self) -> str:
        digest = hashlib.sha256()
        for root, path in self.markdown_files():
            try:
                raw, _ = self._read_stable(path)
            except (FileNotFoundError, UnicodeDecodeError, PermissionError, OSError):
                continue
            self._digest_entry(digest, root, path, raw)
        return digest.hexdigest()

    def load(self) -> tuple[list[KnowledgeDocument], str]:
        documents: list[KnowledgeDocument] = []
        identifiers: set[str] = set()
        digest = hashlib.sha256()
        for root, path in self.markdown_files():
            try:
                raw_bytes, stat = self._read_stable(path)
                raw = raw_bytes.decode("utf-8-sig")
            except (FileNotFoundError, UnicodeDecodeError, PermissionError, OSError):
                continue
            self._digest_entry(digest, root, path, raw_bytes)
            document = self._parse(
                root,
                path,
                raw,
                stat.st_mtime,
                revision=hashlib.sha256(raw_bytes).hexdigest(),
            )
            if document.id in identifiers:
                raise RuntimeError(f"duplicate knowledge node id: {document.id}")
            identifiers.add(document.id)
            documents.append(document)
        self._resolve_links(documents)
        return documents, digest.hexdigest()

    def get(self, node_id: str) -> KnowledgeDocument:
        """Resolve a node from durable Markdown, independent of index freshness."""
        documents, _ = self.load()
        for document in documents:
            if document.id == node_id:
                return document
        raise KeyError(node_id)

    def _parse(
        self,
        root: SourceRoot,
        path: Path,
        raw: str,
        mtime: float,
        *,
        revision: str | None = None,
    ) -> KnowledgeDocument:
        match = FRONT_MATTER.match(raw)
        metadata: dict[str, Any] = {}
        content = raw
        frontmatter_valid = not raw.startswith(("---\n", "---\r\n")) or match is not None
        if match:
            try:
                loaded = yaml.safe_load(match.group(1)) or {}
                if isinstance(loaded, dict):
                    metadata = {
                        str(key): _plain(value) for key, value in loaded.items()
                    }
                else:
                    frontmatter_valid = False
            except yaml.YAMLError:
                metadata = {}
                frontmatter_valid = False
            content = raw[match.end() :]

        relative = path.relative_to(root.path)
        kind = root.forced_kind or self._infer_kind(relative, metadata)
        display_path = (
            relative.as_posix()
            if root.label == "notes"
            else f"{root.label}/{relative.as_posix()}"
        )
        fallback_time = datetime.fromtimestamp(mtime, tz=UTC)
        declared_identifier = str(metadata.get("id") or "").strip()
        identifier = declared_identifier
        if SAFE_ID.fullmatch(identifier) and root.label != "notes":
            # IDs inside independent Hermes homes are only locally meaningful.
            # Namespace them by deterministic source label so a copied skill or
            # MEMORY.md cannot take down the global graph with a duplicate ID.
            identifier = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"hermes-knowledge:source:{root.label}:{identifier}",
                )
            )
        elif not SAFE_ID.fullmatch(identifier):
            identifier = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL, f"hermes-knowledge:{kind.value}:{display_path}"
                )
            )
        title = str(metadata.get("title") or "").strip() or self._title_from_content(
            content, path
        )
        tags = _strings(metadata.get("tags"))
        front_links = [
            self._clean_link(value) for value in _strings(metadata.get("links"))
        ]
        body_links = [self._clean_link(value) for value in WIKI_LINK.findall(content)]
        body_links.extend(
            self._clean_link(value) for value in MARKDOWN_LINK.findall(content)
        )
        permanent = (
            _truthy(metadata.get("permanent", False))
            or str(metadata.get("status", "")).lower() == "permanent"
        )
        if "permanent" in relative.parts:
            permanent = True
        custom = {
            key: value
            for key, value in metadata.items()
            if key not in RESERVED_METADATA
        }
        return KnowledgeDocument(
            id=identifier,
            kind=kind,
            title=title,
            display_path=display_path,
            source_path=path,
            editable=root.editable and frontmatter_valid,
            source=(
                "vault"
                if root.label == "notes"
                else (
                    "hermes-skill"
                    if root.forced_kind is NodeKind.skill
                    else "hermes-memory"
                )
            ),
            content=content.strip(),
            tags=tags,
            link_targets=list(dict.fromkeys(front_links + body_links)),
            permanent=permanent,
            created_at=_datetime(metadata.get("created_at"), fallback_time),
            updated_at=_datetime(metadata.get("updated_at"), fallback_time),
            metadata=custom,
            revision=revision or hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            obsidian_uri=(
                obsidian_uri(self.settings.vault_name, display_path)
                if root.label == "notes" and root.editable and frontmatter_valid
                else None
            ),
            idempotency_digest=(
                str(metadata.get("hermess_idempotency_key_sha256") or "").strip()
                or None
            ),
            idempotency_payload_digest=(
                str(metadata.get("hermess_idempotency_payload_sha256") or "").strip()
                or None
            ),
            source_identifier=(
                declared_identifier
                if root.label != "notes" and SAFE_ID.fullmatch(declared_identifier)
                else None
            ),
        )

    def _written_detail(self, path: Path) -> NodeDetail:
        """Read back the atomically committed note without depending on the index."""
        raw_bytes, stat = self._read_stable(path)
        raw = raw_bytes.decode("utf-8-sig")
        root = SourceRoot(self.settings.knowledge_root, None, "notes", True)
        return self._parse(
            root,
            path,
            raw,
            stat.st_mtime,
            revision=hashlib.sha256(raw_bytes).hexdigest(),
        ).detail()

    @staticmethod
    def _infer_kind(relative: Path, metadata: dict[str, Any]) -> NodeKind:
        declared = str(metadata.get("type") or metadata.get("kind") or "").lower()
        if declared in {kind.value for kind in NodeKind}:
            return NodeKind(declared)
        lowered = {part.casefold() for part in relative.parts}
        if "skills" in lowered or relative.name.casefold() == "skill.md":
            return NodeKind.skill
        if "memories" in lowered or relative.name.casefold() in {
            "memory.md",
            "memories.md",
        }:
            return NodeKind.memory
        if "insights" in lowered:
            return NodeKind.insight
        if "tasks" in lowered:
            return NodeKind.task
        return NodeKind.note

    @staticmethod
    def _title_from_content(content: str, path: Path) -> str:
        heading = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
        if heading:
            return heading.group(1).strip()
        if path.name.casefold() == "skill.md" and path.parent.name:
            return path.parent.name.replace("-", " ").replace("_", " ").title()
        return path.stem.replace("-", " ").replace("_", " ").title()

    @staticmethod
    def _clean_link(value: str) -> str:
        value = unquote(value).strip().strip("<>")
        if value.startswith("[[") and value.endswith("]]"):
            value = value[2:-2].split("|", 1)[0]
        return value.split("#", 1)[0].strip()

    @staticmethod
    def _resolve_links(documents: list[KnowledgeDocument]) -> None:
        path_lookup: dict[str, list[str]] = {}
        name_lookup: dict[str, list[str]] = {}
        by_id = {document.id: document.id for document in documents}
        for document in documents:
            path_candidates = {
                document.display_path,
                document.display_path.removesuffix(".md"),
            }
            name_candidates = {
                document.id,
                document.title,
                document.source_path.stem,
            }
            if document.source_identifier:
                name_candidates.add(document.source_identifier)
            name_candidates.update(_strings(document.metadata.get("aliases")))
            for candidate in path_candidates:
                key = normalize_lookup(candidate)
                if key:
                    path_lookup.setdefault(key, []).append(document.id)
            for candidate in name_candidates:
                key = basename_lookup(candidate)
                if key:
                    name_lookup.setdefault(key, []).append(document.id)
        for document in documents:
            resolved: list[str] = []
            for target in document.link_targets:
                if target in by_id:
                    resolved.append(target)
                    continue
                normalized = normalize_lookup(target)
                matches = path_lookup.get(normalized, [])
                if not matches and "/" not in normalized:
                    matches = name_lookup.get(basename_lookup(target), [])
                if matches:
                    # Folder-qualified links never fall back to a different
                    # same-named note. Unqualified ambiguity is deterministic.
                    resolved.append(min(matches))
            document.resolved_links = list(
                dict.fromkeys(item for item in resolved if item != document.id)
            )

    def create(
        self,
        *,
        title: str,
        content: str,
        tags: list[str],
        kind: NodeKind,
        links: list[str],
        permanent: bool,
        metadata: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> NodeDetail:
        normalized_metadata = {
            key: _plain(value)
            for key, value in metadata.items()
            if key not in RESERVED_METADATA
        }
        normalized_tags = list(
            dict.fromkeys(str(tag).strip() for tag in tags if str(tag).strip())
        )
        normalized_links = list(
            dict.fromkeys(str(link).strip() for link in links if str(link).strip())
        )
        idempotency_digest = (
            hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
            if idempotency_key
            else None
        )
        payload_digest = None
        if idempotency_digest:
            canonical_payload = json.dumps(
                {
                    "title": title,
                    "content": content.strip(),
                    "tags": normalized_tags,
                    "kind": kind.value,
                    "links": normalized_links,
                    "permanent": permanent,
                    "metadata": normalized_metadata,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            payload_digest = hashlib.sha256(canonical_payload).hexdigest()
            documents, _ = self.load()
            existing = [
                document
                for document in documents
                if document.idempotency_digest == idempotency_digest
            ]
            if existing:
                durable = min(existing, key=lambda document: document.display_path)
                if not secrets.compare_digest(
                    durable.idempotency_payload_digest or "", payload_digest
                ):
                    raise IdempotencyConflictError(
                        "idempotency key already belongs to a different note payload"
                    )
                return durable.detail()

        directory_name = {
            NodeKind.note: "permanent" if permanent else "inbox",
            NodeKind.skill: "skills",
            NodeKind.memory: "memories",
            NodeKind.insight: "insights",
            NodeKind.task: "tasks",
        }[kind]
        directory = self.settings.knowledge_root / directory_name
        directory.mkdir(parents=True, exist_ok=True)
        base = slugify(title)
        identifier = (
            str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"hermess-knowledge:create:{idempotency_digest}",
                )
            )
            if idempotency_digest
            else str(uuid.uuid4())
        )
        now = utc_now()
        counter = 1
        while True:
            suffix = "" if counter == 1 else f"-{counter}"
            path = directory / f"{base}{suffix}.md"
            try:
                self._write(
                    path,
                    identifier=identifier,
                    title=title,
                    kind=kind,
                    tags=normalized_tags,
                    links=normalized_links,
                    permanent=permanent,
                    created_at=now,
                    updated_at=now,
                    metadata=normalized_metadata,
                    content=content,
                    idempotency_digest=idempotency_digest,
                    idempotency_payload_digest=payload_digest,
                    create_only=True,
                )
                break
            except FileExistsError:
                # Another API request or Obsidian may have won the filename
                # between discovery and commit. Never replace it.
                counter += 1
                if counter > 10_000:
                    raise OSError("could not reserve a unique note filename")
        return self._written_detail(path)

    def update(
        self,
        document: KnowledgeDocument,
        changes: dict[str, Any],
        *,
        expected_revision: str,
    ) -> NodeDetail:
        if not document.editable:
            if document.source == "vault":
                raise PermissionError(
                    "vault note has invalid YAML frontmatter; fix it in Obsidian first"
                )
            raise PermissionError("mounted Hermes source is read-only")
        try:
            current_bytes, _ = self._read_stable(document.source_path)
            current_revision = hashlib.sha256(current_bytes).hexdigest()
        except (FileNotFoundError, NoteTooLargeError, OSError) as exc:
            raise RevisionConflictError("note changed or moved since it was loaded") from exc
        if not secrets.compare_digest(current_revision, expected_revision):
            raise RevisionConflictError("note changed since it was loaded; refresh before saving")
        title = changes.get("title", document.title)
        content = changes.get("content", document.content)
        tags = changes.get("tags", document.tags)
        links = changes.get("links", document.link_targets)
        permanent = changes.get("permanent", document.permanent)
        custom = changes.get("metadata", document.metadata)
        if custom is None:
            custom = document.metadata
        should_move = (
            document.kind is NodeKind.note
            and permanent
            and not document.permanent
            and document.source_path.parent
            != self.settings.knowledge_root / "permanent"
        )
        # First commit at the path whose revision the caller supplied. That
        # makes the conditional replace one atomic exchange; promotion is a
        # separate no-clobber rename after the content commit linearizes.
        self._write(
            document.source_path,
            identifier=document.id,
            title=title,
            kind=document.kind,
            tags=tags,
            links=links,
            permanent=bool(permanent),
            created_at=document.created_at,
            updated_at=utc_now(),
            metadata=custom,
            content=content,
            idempotency_digest=document.idempotency_digest,
            idempotency_payload_digest=document.idempotency_payload_digest,
            expected_revision=expected_revision,
        )
        destination = (
            self._move_to_permanent(document.source_path, document.id)
            if should_move
            else document.source_path
        )
        return self._written_detail(destination)

    def trash(
        self,
        document: KnowledgeDocument,
        *,
        expected_revision: str,
    ) -> TrashReceipt:
        """CAS-move one editable vault note to recoverable, ignored trash."""
        if not document.deletable:
            if document.source == "vault":
                if document.editable:
                    raise PermissionError(
                        "system-managed knowledge cannot be trashed"
                    )
                raise PermissionError(
                    "vault note has invalid YAML frontmatter; fix it in Obsidian first"
                )
            raise PermissionError("mounted Hermes source is read-only")

        root = self.settings.knowledge_root
        try:
            relative = document.source_path.relative_to(root)
        except ValueError as exc:
            raise PermissionError("delete target is outside the knowledge root") from exc
        if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
            raise PermissionError("delete target has an unsafe vault path")

        trash_id = uuid.uuid4().hex
        final_relative = Path(".trash") / "hermess" / trash_id / relative
        final_text = final_relative.as_posix()
        if (
            not final_text
            or final_text != final_text.strip()
            or final_text.startswith("/")
            or len(final_text) > 4_096
            or len(final_text.encode("utf-8")) > 4_096
            or any(character in final_text for character in ("\\", "\x00", "\r", "\n"))
            or any(part in {"", ".", ".."} for part in final_text.split("/"))
        ):
            raise ValueError("recoverable trash path exceeds maximum length")

        root_fd = self._open_root_directory(root)
        source_parent_fd = -1
        trash_parent_fd = -1
        try:
            try:
                source_parent_fd = self._open_directory_chain(
                    root_fd,
                    relative.parts[:-1],
                    create=False,
                    mode=0o700,
                )
            except FileNotFoundError as exc:
                raise RevisionConflictError(
                    "note changed or moved since it was loaded"
                ) from exc
            try:
                current_raw = self._read_regular_at(
                    source_parent_fd,
                    relative.name,
                    maximum=self.settings.max_note_bytes,
                )
            except (FileNotFoundError, NoteTooLargeError, OSError) as exc:
                raise RevisionConflictError(
                    "note changed or moved since it was loaded"
                ) from exc
            if not secrets.compare_digest(
                hashlib.sha256(current_raw).hexdigest(), expected_revision
            ):
                raise RevisionConflictError(
                    "note changed since it was loaded; refresh before deleting"
                )

            trash_parent_fd = self._open_directory_chain(
                root_fd,
                (
                    ".trash",
                    "hermess",
                    trash_id,
                    *relative.parts[:-1],
                ),
                create=True,
                mode=0o700,
            )
            try:
                _renameat2_at(
                    source_parent_fd,
                    relative.name,
                    trash_parent_fd,
                    relative.name,
                    RENAME_NOREPLACE,
                )
            except FileNotFoundError as exc:
                raise RevisionConflictError(
                    "note changed or moved during delete"
                ) from exc

            try:
                moved_raw = self._read_regular_at(
                    trash_parent_fd,
                    relative.name,
                    maximum=self.settings.max_note_bytes,
                    sync=True,
                )
            except OSError as exc:
                os.fsync(source_parent_fd)
                os.fsync(trash_parent_fd)
                raise RevisionConflictError(
                    "note changed during delete; a recovery entry was retained"
                ) from exc
            moved_revision = hashlib.sha256(moved_raw).hexdigest()
            if not secrets.compare_digest(moved_revision, expected_revision):
                try:
                    _renameat2_at(
                        trash_parent_fd,
                        relative.name,
                        source_parent_fd,
                        relative.name,
                        RENAME_NOREPLACE,
                    )
                except FileExistsError as exc:
                    os.fsync(source_parent_fd)
                    os.fsync(trash_parent_fd)
                    raise RevisionConflictError(
                        "note changed during delete; the active and recovery versions were retained"
                    ) from exc
                except (
                    FileNotFoundError,
                    ConditionalWriteUnavailableError,
                    OSError,
                ) as exc:
                    os.fsync(source_parent_fd)
                    os.fsync(trash_parent_fd)
                    raise RevisionConflictError(
                        "note changed during delete; a recovery entry was retained"
                    ) from exc
                os.fsync(source_parent_fd)
                os.fsync(trash_parent_fd)
                raise RevisionConflictError(
                    "note changed since it was loaded; refresh before deleting"
                )

            # If Obsidian recreated the public name after the atomic move,
            # retain both versions and surface the race rather than claiming
            # that the node is simply absent.
            try:
                os.stat(
                    relative.name,
                    dir_fd=source_parent_fd,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                pass
            else:
                os.fsync(source_parent_fd)
                os.fsync(trash_parent_fd)
                raise RevisionConflictError(
                    "note was recreated during delete; the active and recovery versions were retained"
                )

            os.fsync(source_parent_fd)
            os.fsync(trash_parent_fd)
        finally:
            if trash_parent_fd >= 0:
                os.close(trash_parent_fd)
            if source_parent_fd >= 0:
                os.close(source_parent_fd)
            os.close(root_fd)

        original_trashed = self._trash_private_original(
            document,
            trash_id=trash_id,
        )
        return TrashReceipt(
            node_id=document.id,
            trashed_path=final_relative.as_posix(),
            original_trashed=original_trashed,
        )

    def _trash_private_original(
        self,
        document: KnowledgeDocument,
        *,
        trash_id: str,
    ) -> bool:
        digest = str(document.metadata.get("import_sha256") or "").strip()
        if re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            return False
        try:
            active_documents, _ = self.load()
        except (OSError, RuntimeError):
            return False
        if any(
            candidate.source == "vault"
            and str(candidate.metadata.get("import_sha256") or "").strip()
            == digest
            for candidate in active_documents
        ):
            return False

        state_fd = -1
        originals_fd = -1
        digest_fd = -1
        trash_parent_fd = -1
        try:
            state_fd = self._open_root_directory(self.settings.state_dir)
            originals_fd = self._open_directory_chain(
                state_fd, ("originals",), create=False, mode=0o700
            )
            digest_fd = self._open_directory_chain(
                originals_fd, (digest,), create=False, mode=0o700
            )
            children = os.listdir(digest_fd)
            if not children:
                return False
            for name in children:
                if not name.startswith("source."):
                    return False
                raw = self._read_regular_at(
                    digest_fd,
                    name,
                    maximum=self.settings.import_max_file_bytes,
                )
                if not secrets.compare_digest(
                    hashlib.sha256(raw).hexdigest(), digest
                ):
                    return False
            trash_parent_fd = self._open_directory_chain(
                state_fd,
                ("trash", "hermess", trash_id, "originals"),
                create=True,
                mode=0o700,
            )
            _renameat2_at(
                originals_fd,
                digest,
                trash_parent_fd,
                digest,
                RENAME_NOREPLACE,
            )
            os.fsync(originals_fd)
            os.fsync(trash_parent_fd)
            return True
        except (
            FileExistsError,
            FileNotFoundError,
            PermissionError,
            ConditionalWriteUnavailableError,
            OSError,
        ):
            return False
        finally:
            for descriptor in (
                trash_parent_fd,
                digest_fd,
                originals_fd,
                state_fd,
            ):
                if descriptor >= 0:
                    os.close(descriptor)

    @classmethod
    def _open_root_directory(cls, root: Path) -> int:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        try:
            descriptor = os.open(root, flags)
        except OSError as exc:
            raise PermissionError("storage root is not a safe directory") from exc
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            os.close(descriptor)
            raise PermissionError("storage root is not a safe directory")
        return descriptor

    @classmethod
    def _open_directory_chain(
        cls,
        root_fd: int,
        parts: Iterable[str],
        *,
        create: bool,
        mode: int,
    ) -> int:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_CLOEXEC", 0)
        )
        current = os.dup(root_fd)
        try:
            for part in parts:
                if part in {"", ".", ".."} or "/" in part or "\x00" in part:
                    raise PermissionError("storage path contains an unsafe component")
                created = False
                if create:
                    try:
                        os.mkdir(part, mode=mode, dir_fd=current)
                        os.fsync(current)
                        created = True
                    except FileExistsError:
                        pass
                try:
                    next_fd = os.open(part, flags, dir_fd=current)
                except OSError as exc:
                    if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                        raise PermissionError(
                            "storage path contains a symlink or non-directory"
                        ) from exc
                    raise
                if created:
                    os.fsync(next_fd)
                os.close(current)
                current = next_fd
            return current
        except Exception:
            os.close(current)
            raise

    @staticmethod
    def _read_regular_at(
        directory_fd: int,
        name: str,
        *,
        maximum: int,
        sync: bool = False,
    ) -> bytes:
        if name in {"", ".", ".."} or "/" in name or "\x00" in name:
            raise OSError("unsafe regular-file name")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(
            os, "O_CLOEXEC", 0
        )
        descriptor = os.open(name, flags, dir_fd=directory_fd)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                raise OSError("entry is not a regular file")
            if before.st_size > maximum:
                raise NoteTooLargeError("entry exceeds configured maximum")
            chunks: list[bytes] = []
            remaining = maximum + 1
            while remaining:
                chunk = os.read(descriptor, min(256 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw = b"".join(chunks)
            after = os.fstat(descriptor)
            if len(raw) > maximum:
                raise NoteTooLargeError("entry exceeds configured maximum")
            if (
                before.st_dev != after.st_dev
                or before.st_ino != after.st_ino
                or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns
                or after.st_size != len(raw)
            ):
                raise OSError("entry changed while it was read")
            if sync:
                os.fsync(descriptor)
            return raw
        finally:
            os.close(descriptor)

    def promote(
        self,
        document: KnowledgeDocument,
        title: str | None,
        summary: str | None,
        tags: list[str] | None,
        expected_revision: str,
    ) -> NodeDetail:
        if document.kind is not NodeKind.note:
            raise ValueError("only notes can be promoted")
        content = document.content
        if summary:
            content = (
                f"> [!abstract] Permanent insight\n> {summary.strip()}\n\n{content}"
            )
        metadata = {**document.metadata, "promoted_at": utc_now().isoformat()}
        return self.update(
            document,
            {
                "title": title or document.title,
                "content": content,
                "tags": tags if tags is not None else document.tags,
                "permanent": True,
                "metadata": metadata,
            },
            expected_revision=expected_revision,
        )

    def _move_to_permanent(self, source: Path, identifier: str) -> Path:
        """Organize a committed permanent note without overwriting a peer save."""
        directory = self.settings.knowledge_root / "permanent"
        directory.mkdir(parents=True, exist_ok=True)
        for counter in range(10_000):
            if counter == 0:
                name = source.name
            elif counter == 1:
                name = f"{source.stem}-{identifier[:8]}.md"
            else:
                name = f"{source.stem}-{identifier[:8]}-{counter}.md"
            destination = directory / name
            try:
                _rename_noreplace(source, destination)
            except FileExistsError:
                continue
            except ConditionalWriteUnavailableError:
                # The content and permanent frontmatter are already committed.
                # Leaving it at the original path is safer than emulating a
                # no-clobber rename with a check-then-rename race.
                return source
            self._sync_directory(source.parent)
            if source.parent != destination.parent:
                self._sync_directory(destination.parent)
            return destination
        raise OSError("could not reserve a unique permanent note filename")

    @staticmethod
    def _same_file(first: os.stat_result, second: os.stat_result) -> bool:
        return first.st_dev == second.st_dev and first.st_ino == second.st_ino

    def _read_exchange_entry(self, path: Path) -> tuple[bytes, os.stat_result]:
        """Read a regular directory entry without following a raced symlink."""
        for _ in range(3):
            before = path.stat(follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise OSError("conditional write encountered a non-regular note")
            raw, opened = self._read_stable(path)
            after = path.stat(follow_symlinks=False)
            if self._same_file(before, opened) and self._same_file(opened, after):
                return raw, opened
        raise OSError("conditional write entry kept changing")

    def _preserve_recovery_bytes(self, raw: bytes) -> None:
        """Retain a raced version outside the vault before dropping a directory entry."""
        directory = self.settings.state_dir / "write-conflicts"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(directory, 0o700)
        digest = hashlib.sha256(raw).hexdigest()
        destination = directory / f"{digest}.md"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_CLOEXEC", 0)
        try:
            descriptor = os.open(destination, flags, 0o600)
        except FileExistsError:
            try:
                if hashlib.sha256(destination.read_bytes()).hexdigest() == digest:
                    return
            except OSError:
                pass
            destination = directory / f"{digest}-{uuid.uuid4().hex}.md"
            descriptor = os.open(destination, flags, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        self._sync_directory(directory)

    def _restore_rejected_exchange(
        self,
        path: Path,
        temporary: Path,
        *,
        candidate_revision: str,
        displaced_raw: bytes | None,
    ) -> ConditionalExchangeResult:
        """Undo a rejected exchange, retaining every raced version before cleanup."""
        try:
            _rename_exchange(temporary, path)
        except (ConditionalWriteUnavailableError, OSError):
            # The displaced entry remains at the hidden temporary path. Never
            # remove it when rollback itself could not be completed.
            return ConditionalExchangeResult(False, False, restored=False)

        try:
            captured_raw, _ = self._read_exchange_entry(temporary)
        except OSError:
            # The original entry is back at its public path, but the object
            # captured from that path cannot be classified safely.
            return ConditionalExchangeResult(False, False)
        captured_revision = hashlib.sha256(captured_raw).hexdigest()
        if secrets.compare_digest(captured_revision, candidate_revision):
            return ConditionalExchangeResult(False, True)

        # A second external writer changed or replaced the candidate between
        # validation and rollback. Preserve both known external versions, then
        # exchange once more so the later captured version is public again.
        if displaced_raw is None:
            return ConditionalExchangeResult(False, False, restored=False)
        try:
            self._preserve_recovery_bytes(displaced_raw)
            self._preserve_recovery_bytes(captured_raw)
            _rename_exchange(temporary, path)
            remaining_raw, _ = self._read_exchange_entry(temporary)
            remaining_revision = hashlib.sha256(remaining_raw).hexdigest()
            if not any(
                secrets.compare_digest(remaining_revision, known)
                for known in (
                    hashlib.sha256(displaced_raw).hexdigest(),
                    hashlib.sha256(captured_raw).hexdigest(),
                )
            ):
                self._preserve_recovery_bytes(remaining_raw)
        except (ConditionalWriteUnavailableError, OSError):
            # Keep the hidden entry as an additional recovery copy if another
            # race or I/O failure prevents a fully verified cleanup.
            return ConditionalExchangeResult(
                False, False, recovery_retained=True, restored=False
            )
        return ConditionalExchangeResult(False, True, recovery_retained=True)

    def _verify_exchanged_revision(
        self,
        path: Path,
        temporary: Path,
        *,
        expected_revision: str,
        candidate_revision: str,
    ) -> ConditionalExchangeResult:
        try:
            displaced_raw, _ = self._read_exchange_entry(temporary)
        except OSError:
            displaced_raw = None
        if displaced_raw is not None:
            displaced_revision = hashlib.sha256(displaced_raw).hexdigest()
            if secrets.compare_digest(displaced_revision, expected_revision):
                return ConditionalExchangeResult(True, True)
        return self._restore_rejected_exchange(
            path,
            temporary,
            candidate_revision=candidate_revision,
            displaced_raw=displaced_raw,
        )

    def _write(
        self,
        path: Path,
        *,
        identifier: str,
        title: str,
        kind: NodeKind,
        tags: Iterable[str],
        links: Iterable[str],
        permanent: bool,
        created_at: datetime,
        updated_at: datetime,
        metadata: dict[str, Any],
        content: str,
        idempotency_digest: str | None = None,
        idempotency_payload_digest: str | None = None,
        expected_revision: str | None = None,
        create_only: bool = False,
    ) -> None:
        root = self.settings.knowledge_root.resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        resolved_parent = path.parent.resolve()
        if root != resolved_parent and root not in resolved_parent.parents:
            raise PermissionError("write target is outside the knowledge root")
        custom = {
            key: _plain(value)
            for key, value in metadata.items()
            if key not in RESERVED_METADATA
        }
        front = {
            "id": identifier,
            "title": title,
            "type": kind.value,
            "tags": list(
                dict.fromkeys(str(tag).strip() for tag in tags if str(tag).strip())
            ),
            "links": list(
                dict.fromkeys(str(link).strip() for link in links if str(link).strip())
            ),
            "permanent": permanent,
            "status": "permanent" if permanent else "inbox",
            "created_at": created_at.astimezone(UTC).isoformat(),
            "updated_at": updated_at.astimezone(UTC).isoformat(),
            **custom,
        }
        if idempotency_digest:
            front["hermess_idempotency_key_sha256"] = idempotency_digest
        if idempotency_payload_digest:
            front["hermess_idempotency_payload_sha256"] = idempotency_payload_digest
        serialized = yaml.safe_dump(front, sort_keys=False, allow_unicode=True).strip()
        body = f"---\n{serialized}\n---\n\n{content.strip()}\n"
        encoded = body.encode("utf-8")
        if len(encoded) > self.settings.max_note_bytes:
            raise ValueError("note exceeds configured maximum size")
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary_path = Path(temporary)
        cleanup_temporary = True
        directory_changed = False
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            if create_only:
                # Linking a fully fsynced temporary file is an atomic no-clobber
                # create. Unlike replace(), it cannot erase an Obsidian note that
                # appeared after the filename was selected.
                os.link(temporary_path, path)
                directory_changed = True
            elif expected_revision is not None:
                candidate_revision = hashlib.sha256(encoded).hexdigest()
                try:
                    _rename_exchange(temporary_path, path)
                except FileNotFoundError as exc:
                    raise RevisionConflictError(
                        "note changed or moved since it was loaded"
                    ) from exc
                # After a successful exchange the temporary name is the exact
                # entry displaced at the commit point. Do not clean it up until
                # it is verified or safely restored/preserved.
                cleanup_temporary = False
                directory_changed = True
                result = self._verify_exchanged_revision(
                    path,
                    temporary_path,
                    expected_revision=expected_revision,
                    candidate_revision=candidate_revision,
                )
                cleanup_temporary = result.cleanup_temporary
                if not result.matched:
                    if result.recovery_retained or not result.restored:
                        message = (
                            "note changed during save; the write was rejected and "
                            "a recovery version was retained for operator review"
                        )
                    else:
                        message = (
                            "note changed since it was loaded; refresh before saving"
                        )
                    raise RevisionConflictError(message)
            else:
                os.replace(temporary_path, path)
                cleanup_temporary = False
                directory_changed = True
        finally:
            if cleanup_temporary:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass
            if directory_changed:
                self._sync_directory(path.parent)

    @staticmethod
    def _sync_directory(directory: Path) -> None:
        """Make a committed rename/link durable where directory fsync is supported."""
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        try:
            descriptor = os.open(directory, flags)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def dump_manifest(path: Path, value: dict[str, Any]) -> None:
    """Persist state with replace semantics so readers never observe half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
