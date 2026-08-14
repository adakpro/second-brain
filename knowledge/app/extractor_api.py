"""Internal-only, secretless document extraction service."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import subprocess
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .config import Settings
from .importer import (
    ACCEPTED,
    ImportError,
    Staged,
    _extract_local,
    _safe_filename,
    _validate_container,
)

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 1_900_000
MAX_TIMEOUT_SECONDS = 30


class ExtractResponse(BaseModel):
    content: str
    title: str | None = None
    extractor: str
    warnings: list[str] = Field(default_factory=list)


app = FastAPI(
    title="Hermess document extractor",
    description="Internal, secretless, resource-confined document-to-text worker.",
    version="1.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
extract_lock = asyncio.Lock()


class _BodyTooLarge(Exception):
    pass


class ExtractBodyLimitMiddleware:
    def __init__(self, app: Any, max_bytes: int):
        self.application = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("method") != "POST":
            await self.application(scope, receive, send)
            return
        seen = 0

        async def bounded_receive() -> Any:
            nonlocal seen
            message = await receive()
            if message.get("type") == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _BodyTooLarge
            return message

        try:
            await self.application(scope, bounded_receive, send)
        except _BodyTooLarge:
            body = b'{"detail":"extractor request exceeds input limit"}'
            await send(
                {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode("ascii")),
                        (b"x-content-type-options", b"nosniff"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})


app.add_middleware(ExtractBodyLimitMiddleware, max_bytes=MAX_INPUT_BYTES + 1024 * 1024)


@app.middleware("http")
async def safe_headers(request: Any, call_next: Any):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok", "service": "hermess-extractor"}


@app.get("/health/ready")
async def ready() -> dict[str, str]:
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["/usr/bin/tesseract", "--list-langs"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=503, detail="OCR runtime is unavailable") from exc
    languages = set(result.stdout.splitlines()) | set(result.stderr.splitlines())
    if result.returncode != 0 or not {"fas", "eng"}.issubset(languages):
        raise HTTPException(status_code=503, detail="Persian/English OCR data is unavailable")
    return await live()


@app.post("/extract", response_model=ExtractResponse)
async def extract(
    file: Annotated[UploadFile, File()],
    extension: Annotated[str, Form(pattern=r"^\.[a-z0-9]{1,8}$")],
    max_output_bytes: Annotated[int, Form(ge=1024, le=MAX_OUTPUT_BYTES)],
    timeout_seconds: Annotated[int, Form(ge=1, le=MAX_TIMEOUT_SECONDS)],
) -> ExtractResponse:
    acquired = False
    try:
        await asyncio.wait_for(extract_lock.acquire(), timeout=0.001)
        acquired = True
    except TimeoutError:
        raise HTTPException(status_code=429, detail="extractor is busy; retry shortly")
    try:
        extension = extension.casefold()
        if extension not in ACCEPTED:
            raise HTTPException(status_code=415, detail="unsupported file extension")
        filename, filename_extension = _safe_filename(file.filename, 0)
        if filename_extension != extension:
            raise ImportError("filename and requested extension do not match", 415)
        with tempfile.TemporaryDirectory(prefix="hermess-extract-") as temporary:
            working = Path(temporary)
            source = working / f"source{extension}"
            digest = hashlib.sha256()
            size = 0
            with source.open("xb") as handle:
                os.chmod(source, 0o600)
                while True:
                    chunk = await file.read(256 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_INPUT_BYTES:
                        raise ImportError("file exceeds extractor input limit", 413)
                    digest.update(chunk)
                    handle.write(chunk)
            if size == 0:
                raise ImportError("file is empty", 422)
            staged = Staged(
                ordinal=0,
                filename=filename,
                extension=extension,
                declared_type=file.content_type or "application/octet-stream",
                media_type=ACCEPTED[extension][0],
                path=source,
                size=size,
                sha256=digest.hexdigest(),
            )
            _validate_container(staged)
            settings = Settings(
                import_max_extracted_bytes=max_output_bytes,
                import_parser_timeout_seconds=timeout_seconds,
            )
            try:
                result = await asyncio.to_thread(
                    _extract_local,
                    staged,
                    settings,
                    working,
                    float(timeout_seconds),
                )
            except ImportError as exc:
                # Parser internals can contain private temporary paths. Keep
                # validation errors specific, but make extraction failures opaque.
                raise HTTPException(
                    status_code=422,
                    detail="document could not be safely extracted",
                ) from exc
            return ExtractResponse(
                content=result.content,
                title=result.title,
                extractor=result.extractor,
                warnings=result.warnings,
            )
    except ImportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    finally:
        if acquired:
            extract_lock.release()
        await file.close()
