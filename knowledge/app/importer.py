"""Transactional, bounded ingestion of untrusted documents into the Markdown vault."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import UploadFile
import httpx

from .config import Settings
from .documents import (
    ConditionalWriteUnavailableError,
    MarkdownRepository,
    _rename_noreplace,
    slugify,
    utc_now,
)
from .models import ImportResult, NodeKind, NodeSummary

ACCEPTED: dict[str, tuple[str, frozenset[str]]] = {
    ".md": ("text/markdown", frozenset({"text/markdown", "text/plain", "application/octet-stream"})),
    ".txt": ("text/plain", frozenset({"text/plain", "application/octet-stream"})),
    ".csv": ("text/csv", frozenset({"text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"})),
    ".json": ("application/json", frozenset({"application/json", "text/json", "text/plain", "application/octet-stream"})),
    ".html": ("text/html", frozenset({"text/html", "text/plain", "application/octet-stream"})),
    ".htm": ("text/html", frozenset({"text/html", "text/plain", "application/octet-stream"})),
    ".pdf": ("application/pdf", frozenset({"application/pdf", "application/octet-stream"})),
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", frozenset({"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"})),
    ".pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", frozenset({"application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip", "application/octet-stream"})),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", frozenset({"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip", "application/octet-stream"})),
    ".png": ("image/png", frozenset({"image/png", "application/octet-stream"})),
    ".jpg": ("image/jpeg", frozenset({"image/jpeg", "image/jpg", "application/octet-stream"})),
    ".jpeg": ("image/jpeg", frozenset({"image/jpeg", "image/jpg", "application/octet-stream"})),
    ".webp": ("image/webp", frozenset({"image/webp", "application/octet-stream"})),
    ".tif": ("image/tiff", frozenset({"image/tiff", "application/octet-stream"})),
    ".tiff": ("image/tiff", frozenset({"image/tiff", "application/octet-stream"})),
    ".bmp": ("image/bmp", frozenset({"image/bmp", "image/x-ms-bmp", "application/octet-stream"})),
}
TEXT_EXTENSIONS = frozenset({".md", ".txt", ".csv", ".json", ".html", ".htm"})
OOXML_REQUIRED = {
    ".docx": "word/document.xml",
    ".pptx": "ppt/presentation.xml",
    ".xlsx": "xl/workbook.xml",
}
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"})
MAX_ARCHIVE_MEMBERS = 5_000
MAX_ARCHIVE_UNCOMPRESSED = 256 * 1024 * 1024
MAX_ARCHIVE_MEMBER = 64 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
PARSER_VERSION = "hermess-safe-extract/1.1.0"
SAFE_FILENAME = re.compile(r"[^\w .()\[\]-]+", re.UNICODE)
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")
PENDING_DIRECTORY = re.compile(r"\.pending-[0-9a-f]{64}-[0-9a-f]{32}\Z")
STAGING_DIRECTORY = re.compile(r"batch-[A-Za-z0-9_-]{6,}\Z")
SPOOL_ENTRY = re.compile(r"tmp[A-Za-z0-9_.-]{3,}\Z")


class ImportError(Exception):
    def __init__(self, detail: str, status_code: int = 422):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(slots=True)
class Staged:
    ordinal: int
    filename: str
    extension: str
    declared_type: str
    media_type: str
    path: Path
    size: int
    sha256: str


@dataclass(slots=True)
class Extracted:
    staged: Staged
    title: str
    content: str
    extractor: str
    warnings: list[str]


def accepted_extensions() -> list[str]:
    return sorted(ACCEPTED)


def accepted_media_types() -> list[str]:
    return sorted({spec[0] for spec in ACCEPTED.values()})


def _safe_filename(value: str | None, ordinal: int) -> tuple[str, str]:
    if not value or "\x00" in value or "/" in value or "\\" in value:
        raise ImportError(f"file {ordinal + 1} has an unsafe filename", 422)
    normalized = unicodedata.normalize("NFC", value).strip()
    if normalized in {"", ".", ".."} or len(normalized.encode("utf-8")) > 240:
        raise ImportError(f"file {ordinal + 1} has an unsafe filename", 422)
    extension = Path(normalized).suffix.casefold()
    if extension not in ACCEPTED:
        raise ImportError(f"unsupported file extension: {extension or '(none)'}", 415)
    display = SAFE_FILENAME.sub("-", normalized).strip(" .-")
    if not display:
        display = f"document-{ordinal + 1}{extension}"
    return display[:240], extension


def _validate_text(path: Path, extension: str) -> None:
    raw = path.read_bytes()
    if b"\x00" in raw:
        raise ImportError(f"{extension} file contains binary data", 415)
    try:
        raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImportError(f"{extension} file must be UTF-8", 415) from exc


def _validate_ooxml(path: Path, extension: str) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ImportError("Office document has too many archive members", 422)
            names: set[str] = set()
            folded_names: set[str] = set()
            total = 0
            for member in members:
                name = member.filename.replace("\\", "/")
                parts = Path(name).parts
                if name.startswith("/") or ".." in parts or "\x00" in name:
                    raise ImportError("Office document contains an unsafe archive path", 422)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise ImportError("Office document contains an archive symlink", 422)
                if member.flag_bits & 0x1:
                    raise ImportError("encrypted Office documents are not supported", 422)
                total += member.file_size
                if member.file_size > MAX_ARCHIVE_MEMBER or total > MAX_ARCHIVE_UNCOMPRESSED:
                    raise ImportError("Office document expands beyond safe limits", 413)
                ratio = member.file_size / max(member.compress_size, 1)
                if ratio > MAX_COMPRESSION_RATIO:
                    raise ImportError("Office document has a suspicious compression ratio", 422)
                folded = name.casefold()
                if (
                    folded.endswith("vbaproject.bin")
                    or "/embeddings/" in f"/{folded}"
                    or "/activex/" in f"/{folded}"
                    or "oleobject" in folded
                    or folded.endswith((".exe", ".dll", ".com", ".js", ".vbs"))
                ):
                    raise ImportError("active or embedded Office content is not accepted", 415)
                if name in names or name.casefold() in folded_names:
                    raise ImportError("Office document contains duplicate archive members", 422)
                names.add(name)
                folded_names.add(name.casefold())
            if "[Content_Types].xml" not in names or OOXML_REQUIRED[extension] not in names:
                raise ImportError(f"file is not a valid {extension} document", 415)
            for member in members:
                folded = member.filename.casefold()
                if folded.endswith((".xml", ".rels")):
                    if member.file_size > 8 * 1024 * 1024:
                        raise ImportError("Office XML part exceeds safe inspection size", 422)
                    xml = archive.read(member)
                    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", xml, re.I):
                        raise ImportError("Office document contains forbidden XML declarations", 415)
                if folded.endswith(".rels"):
                    if re.search(br"TargetMode\s*=\s*['\"]External['\"]", xml, re.I):
                        raise ImportError("Office document contains external relationships", 415)
    except zipfile.BadZipFile as exc:
        raise ImportError(f"file is not a valid {extension} document", 415) from exc


def _validate_container(staged: Staged) -> None:
    declared = (staged.declared_type or "application/octet-stream").split(";", 1)[0].strip().casefold()
    if declared not in ACCEPTED[staged.extension][1]:
        raise ImportError(
            f"declared media type {declared or '(empty)'} does not match {staged.extension}",
            415,
        )
    with staged.path.open("rb") as handle:
        magic = handle.read(16)
    if staged.extension in TEXT_EXTENSIONS:
        _validate_text(staged.path, staged.extension)
    elif staged.extension == ".pdf":
        if not magic.startswith(b"%PDF-"):
            raise ImportError("file is not a valid PDF", 415)
    elif staged.extension in IMAGE_EXTENSIONS:
        signatures = {
            ".png": magic.startswith(b"\x89PNG\r\n\x1a\n"),
            ".jpg": magic.startswith(b"\xff\xd8\xff"),
            ".jpeg": magic.startswith(b"\xff\xd8\xff"),
            ".webp": magic.startswith(b"RIFF") and magic[8:12] == b"WEBP",
            ".tif": magic.startswith((b"II*\x00", b"MM\x00*")),
            ".tiff": magic.startswith((b"II*\x00", b"MM\x00*")),
            ".bmp": magic.startswith(b"BM"),
        }
        if not signatures[staged.extension]:
            raise ImportError(f"file is not a valid {staged.extension} image", 415)
    else:
        if not magic.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            raise ImportError(f"file is not a valid {staged.extension} container", 415)
        _validate_ooxml(staged.path, staged.extension)


def _normalize_extracted(staged: Staged, settings: Settings, payload: object) -> Extracted:
    if not isinstance(payload, dict):
        raise ImportError("extractor returned invalid JSON", 503)
    try:
        content = str(payload["content"])
        extractor = str(payload["extractor"])
        raw_warnings = payload.get("warnings", [])
        warnings = [str(value)[:300] for value in raw_warnings[:20]] if isinstance(raw_warnings, list) else []
        extracted_title = str(payload.get("title") or "").strip()
    except (ValueError, KeyError, TypeError) as exc:
        raise ImportError(f"extractor returned an invalid result for {staged.filename}", 422) from exc
    if not content.strip() or len(content.encode("utf-8")) > settings.import_max_extracted_bytes:
        raise ImportError(f"extractor returned invalid text for {staged.filename}", 422)
    fallback = Path(staged.filename).stem.replace("_", " ").replace("-", " ")
    title = CONTROL.sub("", " ".join((extracted_title or fallback).split()))[:240].strip()
    return Extracted(staged, title or "Imported document", content, extractor, warnings)


def _extract_local(staged: Staged, settings: Settings, working: Path, timeout: float) -> Extracted:
    output_path = working / f"extract-{staged.ordinal}.json"
    error_path = working / f"extract-{staged.ordinal}.err"
    worker = Path(__file__).with_name("extract_worker.py")
    with error_path.open("wb") as error:
        process = subprocess.Popen(
            [
                sys.executable,
                str(worker),
                str(staged.path),
                staged.extension,
                str(output_path),
                str(settings.import_max_extracted_bytes),
                str(settings.import_parser_timeout_seconds),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=error,
            close_fds=True,
            start_new_session=True,
            env={"PATH": "/usr/bin:/bin", "PYTHONHASHSEED": "0", "LANG": "C.UTF-8"},
        )
        try:
            return_code = process.wait(timeout=max(0.1, timeout))
        except subprocess.TimeoutExpired as exc:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise ImportError(f"extraction timed out for {staged.filename}", 422) from exc
    if return_code != 0:
        message = error_path.read_text(encoding="utf-8", errors="replace")[:1000].strip()
        raise ImportError(message or f"could not extract {staged.filename}", 422)
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise ImportError(f"extractor returned an invalid result for {staged.filename}", 422) from exc
    return _normalize_extracted(staged, settings, payload)


async def _extract_remote(
    staged: Staged, settings: Settings, timeout: float
) -> Extracted:
    if not settings.extractor_url.startswith(("http://", "https://")):
        raise ImportError("document extractor service is not configured", 503)
    try:
        with staged.path.open("rb") as handle:
            async with asyncio.timeout(timeout):
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(
                        timeout, connect=min(timeout, 5.0)
                    ),
                    follow_redirects=False,
                    trust_env=False,
                ) as client:
                    async with client.stream(
                        "POST",
                        settings.extractor_url.rstrip("/") + "/extract",
                        files={
                            "file": (
                                staged.filename,
                                handle,
                                staged.media_type,
                            )
                        },
                        data={
                            "extension": staged.extension,
                            "max_output_bytes": str(
                                settings.import_max_extracted_bytes
                            ),
                            "timeout_seconds": str(
                                max(
                                    1,
                                    min(
                                        settings.import_parser_timeout_seconds,
                                        int(timeout),
                                    ),
                                )
                            ),
                        },
                        headers={"Accept-Encoding": "identity"},
                    ) as response:
                        body = bytearray()
                        maximum = settings.import_max_extracted_bytes + 128 * 1024
                        content_encoding = (
                            response.headers.get("content-encoding", "")
                            .strip()
                            .casefold()
                        )
                        if content_encoding not in {"", "identity"}:
                            raise ImportError(
                                "extractor returned an unsupported content encoding",
                                503,
                            )
                        content_length = response.headers.get("content-length")
                        if (
                            content_length
                            and content_length.isdigit()
                            and int(content_length) > maximum
                        ):
                            raise ImportError(
                                "extractor response exceeds configured maximum", 503
                            )
                        async for chunk in response.aiter_raw(64 * 1024):
                            if len(body) + len(chunk) > maximum:
                                raise ImportError(
                                    "extractor response exceeds configured maximum",
                                    503,
                                )
                            body.extend(chunk)
                        response_status = response.status_code
    except (TimeoutError, httpx.TimeoutException, httpx.NetworkError) as exc:
        raise ImportError("document extractor service is unavailable", 503) from exc
    if response_status == 429:
        raise ImportError("document extractor is busy; retry shortly", 429)
    if response_status != 200:
        try:
            parsed = json.loads(body)
            detail = str(parsed.get("detail") or "document extraction failed")[:1000]
        except (ValueError, AttributeError):
            detail = "document extraction failed"
        raise ImportError(detail, 422 if response_status < 500 else 503)
    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise ImportError("extractor returned invalid JSON", 503) from exc
    return _normalize_extracted(staged, settings, payload)


class ImportService:
    def __init__(self, settings: Settings, repository: MarkdownRepository):
        self.settings = settings
        self.repository = repository

    def cleanup_stale(self, minimum_age_seconds: int = 24 * 60 * 60) -> None:
        """Remove only old, importer-owned hidden staging; never notes/originals."""
        cutoff = time.time() - minimum_age_seconds
        roots = (
            (self.settings.state_dir / "import-staging", STAGING_DIRECTORY),
            (self.settings.state_dir / "import-spool", SPOOL_ENTRY),
            (self.settings.knowledge_root / "inbox" / "imports", PENDING_DIRECTORY),
            (self.settings.knowledge_root / "permanent" / "imports", PENDING_DIRECTORY),
        )
        for root, pattern in roots:
            try:
                children = list(root.iterdir())
            except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
                continue
            for path in children:
                if pattern.fullmatch(path.name) is None:
                    continue
                try:
                    entry = path.stat(follow_symlinks=False)
                    if entry.st_mtime >= cutoff:
                        continue
                    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode):
                        path.unlink()
                    else:
                        shutil.rmtree(path)
                except (FileNotFoundError, PermissionError, OSError):
                    continue

    async def ingest(
        self,
        files: list[UploadFile],
        *,
        tags: list[str],
        permanent: bool,
        disconnected: Callable[[], Awaitable[bool]],
    ) -> tuple[list[ImportResult], bool]:
        tags = [CONTROL.sub("", " ".join(value.split()))[:100] for value in tags]
        tags = list(dict.fromkeys(value for value in tags if value))
        if len(tags) > 100:
            raise ImportError("too many tags", 422)
        await asyncio.to_thread(self.cleanup_stale)
        if not files:
            raise ImportError("at least one file is required", 422)
        if len(files) > self.settings.import_max_files:
            raise ImportError("too many files in one import", 413)
        started = time.monotonic()
        staging_root = self.settings.state_dir / "import-staging"
        staging_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        working = Path(tempfile.mkdtemp(prefix="batch-", dir=staging_root))
        os.chmod(working, 0o700)
        try:
            staged = await self._stage(files, working)
            extracted: list[Extracted] = []
            for item in staged:
                remaining = self.settings.import_batch_deadline_seconds - (time.monotonic() - started)
                timeout = min(float(self.settings.import_parser_timeout_seconds), remaining)
                if timeout <= 0:
                    raise ImportError("import batch deadline exceeded", 422)
                if self.settings.extractor_url == "local://":
                    result = await asyncio.to_thread(
                        _extract_local, item, self.settings, working, timeout
                    )
                else:
                    result = await _extract_remote(item, self.settings, timeout)
                extracted.append(result)
            if time.monotonic() - started >= self.settings.import_batch_deadline_seconds:
                raise ImportError("import batch deadline exceeded", 422)
            if await disconnected():
                raise ImportError("client disconnected before import commit", 499)
            results, changed = await asyncio.to_thread(
                self._commit, extracted, tags, permanent
            )
            return results, changed
        finally:
            for upload in files:
                await upload.close()
            shutil.rmtree(working, ignore_errors=True)

    async def _stage(self, files: list[UploadFile], working: Path) -> list[Staged]:
        staged: list[Staged] = []
        total = 0
        for ordinal, upload in enumerate(files):
            filename, extension = _safe_filename(upload.filename, ordinal)
            path = working / f"upload-{ordinal}{extension}"
            digest = hashlib.sha256()
            size = 0
            with path.open("xb") as handle:
                os.chmod(path, 0o600)
                while True:
                    chunk = await upload.read(256 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    total += len(chunk)
                    if size > self.settings.import_max_file_bytes:
                        raise ImportError(f"{filename} exceeds per-file size limit", 413)
                    if total > self.settings.import_max_total_bytes:
                        raise ImportError("import exceeds total size limit", 413)
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if size == 0:
                raise ImportError(f"{filename} is empty", 422)
            staged_item = Staged(
                ordinal=ordinal,
                filename=filename,
                extension=extension,
                declared_type=upload.content_type or "application/octet-stream",
                media_type=ACCEPTED[extension][0],
                path=path,
                size=size,
                sha256=digest.hexdigest(),
            )
            _validate_container(staged_item)
            staged.append(staged_item)
        self._check_storage(total, staged)
        return staged

    def _check_storage(self, batch_bytes: int, staged: list[Staged]) -> None:
        state = self.settings.state_dir
        usage = shutil.disk_usage(state)
        # Staging already consumes batch_bytes. Reserve room for originals,
        # derived Markdown/index updates, and the operator's configured floor.
        required = batch_bytes + min(batch_bytes, self.settings.import_max_total_bytes)
        if usage.free - required < self.settings.import_free_space_reserve_bytes:
            raise ImportError("insufficient reserved storage for document import", 507)
        originals = state / "originals"
        current = 0
        for directory, _, names in os.walk(originals, followlinks=False):
            for name in names:
                path = Path(directory) / name
                try:
                    entry = path.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISREG(entry.st_mode):
                    current += entry.st_size
                if current > self.settings.import_original_quota_bytes:
                    break
        new_sizes: dict[str, int] = {}
        for item in staged:
            destination = originals / item.sha256 / f"source{item.extension}"
            if not destination.exists():
                new_sizes.setdefault(item.sha256, item.size)
        additional = sum(new_sizes.values())
        if current + additional > self.settings.import_original_quota_bytes:
            raise ImportError("private original storage quota would be exceeded", 507)

    def _commit(
        self, extracted: list[Extracted], tags: list[str], permanent: bool
    ) -> tuple[list[ImportResult], bool]:
        existing_documents, _ = self.repository.load()
        existing = {
            str(document.metadata.get("import_sha256")): document
            for document in existing_documents
            if document.source == "vault" and document.metadata.get("import_sha256")
        }
        results_by_ordinal: dict[int, ImportResult] = {}
        new_by_digest: dict[str, Extracted] = {}
        for item in extracted:
            duplicate = existing.get(item.staged.sha256)
            if duplicate is not None:
                results_by_ordinal[item.staged.ordinal] = self._result(
                    item, "duplicate", duplicate.summary()
                )
            elif item.staged.sha256 in new_by_digest:
                continue
            else:
                new_by_digest[item.staged.sha256] = item
        if not new_by_digest:
            return [results_by_ordinal[item.staged.ordinal] for item in extracted], False

        parent = self.settings.knowledge_root / ("permanent" if permanent else "inbox") / "imports"
        parent.mkdir(parents=True, exist_ok=True)
        self.repository._sync_directory(parent.parent)  # noqa: SLF001
        batch_material = "\n".join(sorted(new_by_digest)).encode("ascii")
        batch_id = hashlib.sha256(batch_material).hexdigest()
        destination = parent / f"batch-{batch_id}"
        pending = parent / f".pending-{batch_id}-{uuid.uuid4().hex}"
        pending.mkdir(mode=0o700)
        try:
            for digest, item in sorted(new_by_digest.items()):
                note_name = f"{slugify(item.title)}-{digest}.md"
                note_path = pending / note_name
                now = utc_now()
                identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, f"hermess-knowledge:import:{digest}"))
                metadata = {
                    "import_sha256": digest,
                    "import_original_filename": item.staged.filename,
                    "import_media_type": item.staged.media_type,
                    "import_size_bytes": item.staged.size,
                    "import_extractor": item.extractor,
                    "import_parser_version": PARSER_VERSION,
                    "import_warnings": item.warnings,
                    "import_malware_scanned": False,
                    "import_original_retention": "private-state-not-vault",
                }
                idempotency_digest = hashlib.sha256(f"import:{digest}".encode()).hexdigest()
                self.repository._write(  # noqa: SLF001 - same-package transaction
                    note_path,
                    identifier=identifier,
                    title=item.title,
                    kind=NodeKind.note,
                    tags=tags,
                    links=[],
                    permanent=permanent,
                    created_at=now,
                    updated_at=now,
                    metadata=metadata,
                    content=item.content,
                    idempotency_digest=idempotency_digest,
                    idempotency_payload_digest=digest,
                    create_only=True,
                )
            # Validate/persist every inert private original before the single
            # visible vault commit. Failure cannot expose a partial note batch.
            for item in new_by_digest.values():
                self._commit_original(item.staged)
            self.repository._sync_directory(pending)  # noqa: SLF001
            try:
                _rename_noreplace(pending, destination)
            except FileExistsError:
                # A concurrent/retried identical transaction already committed.
                shutil.rmtree(pending, ignore_errors=True)
            except ConditionalWriteUnavailableError as exc:
                raise ImportError(
                    "atomic vault imports are unavailable on this filesystem", 503
                ) from exc
            self.repository._sync_directory(parent)  # noqa: SLF001
        finally:
            shutil.rmtree(pending, ignore_errors=True)

        durable, _ = self.repository.load()
        by_digest = {
            str(document.metadata.get("import_sha256")): document
            for document in durable
            if document.source == "vault" and document.metadata.get("import_sha256")
        }
        for item in extracted:
            if item.staged.ordinal in results_by_ordinal:
                continue
            document = by_digest.get(item.staged.sha256)
            if document is None:
                raise ImportError("committed import could not be verified", 500)
            first = new_by_digest.get(item.staged.sha256) is item
            results_by_ordinal[item.staged.ordinal] = self._result(
                item, "imported" if first else "duplicate", document.summary()
            )
        return [results_by_ordinal[item.staged.ordinal] for item in extracted], True

    def _commit_original(self, staged: Staged) -> tuple[Path, bool]:
        directory = self.settings.state_dir / "originals" / staged.sha256
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.repository._sync_directory(directory.parent)  # noqa: SLF001
        os.chmod(directory, 0o700)
        destination = directory / f"source{staged.extension}"
        if destination.exists():
            if destination.is_symlink() or not destination.is_file():
                raise ImportError("private original store contains an unsafe entry", 409)
            digest = hashlib.sha256(destination.read_bytes()).hexdigest()
            if digest != staged.sha256:
                raise ImportError("private original hash collision", 409)
            return destination, False
        descriptor, temporary = tempfile.mkstemp(prefix=".source-", dir=directory)
        temporary_path = Path(temporary)
        try:
            with os.fdopen(descriptor, "wb") as target, staged.path.open("rb") as source:
                shutil.copyfileobj(source, target, 256 * 1024)
                target.flush()
                os.fsync(target.fileno())
            os.chmod(temporary_path, 0o600)
            os.link(temporary_path, destination)
            self.repository._sync_directory(directory)  # noqa: SLF001
        finally:
            temporary_path.unlink(missing_ok=True)
        return destination, True

    @staticmethod
    def _result(item: Extracted, status: str, node: NodeSummary) -> ImportResult:
        return ImportResult(
            filename=item.staged.filename,
            status=status,
            node=node,
            sha256=item.staged.sha256,
            media_type=item.staged.media_type,
            extractor=item.extractor,
        )
