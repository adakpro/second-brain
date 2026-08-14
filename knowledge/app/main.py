from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings
from .documents import (
    ConditionalWriteUnavailableError,
    IdempotencyConflictError,
    MarkdownRepository,
    RevisionConflictError,
    obsidian_uri,
)
from .index import KnowledgeIndex
from .importer import (
    ImportError as DocumentImportError,
    ImportService,
    accepted_extensions,
    accepted_media_types,
)
from .models import (
    ActivationRequest,
    ActivationResponse,
    Connection,
    CreateNoteRequest,
    DeleteNodeRequest,
    DeleteNodeResponse,
    DiscoverRequest,
    GraphResponse,
    HealthResponse,
    ImportCapabilities,
    ImportResponse,
    IndexReport,
    IngestRequest,
    InsightCandidate,
    InsightRequest,
    NodeDetail,
    NodeKind,
    NodeSummary,
    PromoteNoteRequest,
    SearchHit,
    SearchRequest,
    StatsResponse,
    UpdateNoteRequest,
    VaultInfo,
)
from .security import api_key_dependency

__version__ = "1.2.0"
logger = logging.getLogger(__name__)


class _ImportBodyTooLarge(Exception):
    pass


class ImportBodyLimitMiddleware:
    """Bound chunked multipart bodies before Starlette spools/parses them."""

    def __init__(self, app: Any, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") != "/imports":
            await self.app(scope, receive, send)
            return
        seen = 0

        async def limited_receive() -> Any:
            nonlocal seen
            message = await receive()
            if message.get("type") == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _ImportBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _ImportBodyTooLarge:
            body = b'{"detail":"import request exceeds total size limit"}'
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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    logging.basicConfig(level=getattr(logging, settings.log_level, logging.INFO))
    repository = MarkdownRepository(settings)
    index = KnowledgeIndex(settings, repository=repository)
    importer = ImportService(settings, repository)
    mutation_lock = asyncio.Lock()
    import_lock = asyncio.Lock()
    background_reindex_task: asyncio.Task[None] | None = None
    background_reindex_epoch = 0

    async def background_reindex() -> None:
        nonlocal background_reindex_task
        try:
            # Coalesce every mutation that arrived during one scan into one
            # follow-up. If another mutation arrives during that follow-up,
            # continue until one full pass observes a stable epoch.
            while True:
                observed = background_reindex_epoch
                try:
                    await asyncio.to_thread(index.reindex)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("queued knowledge reindex failed")
                if observed == background_reindex_epoch:
                    break
        finally:
            background_reindex_task = None

    def queue_background_reindex() -> None:
        nonlocal background_reindex_epoch, background_reindex_task
        background_reindex_epoch += 1
        if background_reindex_task is None or background_reindex_task.done():
            background_reindex_task = asyncio.create_task(
                background_reindex(), name="knowledge-mutation-reindex"
            )

    async def periodic_indexer() -> None:
        while True:
            await asyncio.sleep(settings.scan_interval_seconds)
            try:
                changed = await asyncio.to_thread(index.needs_reindex)
                if changed:
                    await asyncio.to_thread(index.reindex)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("background knowledge indexing failed")

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        settings.prepare_directories()
        await asyncio.to_thread(importer.cleanup_stale)
        try:
            await asyncio.to_thread(index.reindex)
        except Exception:
            # Keep the process alive so /health reports a useful degraded state.
            logger.exception("initial knowledge indexing failed")
        task = (
            asyncio.create_task(periodic_indexer(), name="knowledge-periodic-index")
            if settings.auto_index
            else None
        )
        application.state.index = index
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            if background_reindex_task:
                background_reindex_task.cancel()
                with suppress(asyncio.CancelledError):
                    await background_reindex_task

    docs_url = "/docs" if settings.docs_enabled else None
    app = FastAPI(
        title="Hermes Knowledge Sidecar",
        description="Fully local Markdown search and second-brain graph service.",
        version=__version__,
        docs_url=docs_url,
        redoc_url="/redoc" if settings.docs_enabled else None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.index = index
    app.state.mutation_lock = mutation_lock

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials="*" not in settings.cors_origins,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=[
                "Authorization",
                "Content-Type",
                "X-API-Key",
                "X-Request-ID",
            ],
            expose_headers=["X-Knowledge-Generation"],
        )
    app.add_middleware(
        ImportBodyLimitMiddleware,
        max_bytes=settings.import_max_total_bytes + 1024 * 1024,
    )

    auth = api_key_dependency(settings)
    protected = [Depends(auth)]

    @app.middleware("http")
    async def response_headers(request: Any, call_next: Any) -> Response:
        origin = request.headers.get("origin")
        allowed_mutation_origins = {
            value.rstrip("/") for value in settings.cors_origins if value != "*"
        }
        content_length = request.headers.get("content-length")
        if (
            request.method == "POST"
            and request.url.path == "/imports"
            and content_length
            and content_length.isdigit()
            and int(content_length) > settings.import_max_total_bytes + 1024 * 1024
        ):
            response = Response(
                content='{"detail":"import request exceeds total size limit"}',
                status_code=413,
                media_type="application/json",
            )
        elif (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and origin
            and origin.rstrip("/") not in allowed_mutation_origins
        ):
            response = Response(
                content='{"detail":"origin is not allowed for mutations"}',
                status_code=403,
                media_type="application/json",
            )
        else:
            # Origin-less requests remain available to authenticated internal
            # services and CLI clients; browsers must match the explicit list.
            response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers["X-Knowledge-Generation"] = str(index.snapshot.generation)
        return response

    @app.get("/health", response_model=HealthResponse, tags=["operations"])
    async def health(response: Response) -> HealthResponse:
        auth_configured = settings.auth_configured
        ready = index.ready and index.last_error is None and auth_configured
        if ready:
            service_status = "ok"
        elif not index.ready and not index.last_error:
            service_status = "starting"
        else:
            service_status = "degraded"
        if not ready:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        snapshot = index.snapshot
        return HealthResponse(
            status=service_status,
            ready=ready,
            auth_configured=auth_configured,
            generation=snapshot.generation,
            nodes=len(snapshot.documents),
            embedding_backend=index.embedder.name,
            last_error=index.last_error,
        )

    @app.get("/health/live", tags=["operations"])
    async def live() -> dict[str, str]:
        return {"status": "ok", "service": "hermes-knowledge"}

    @app.get("/health/ready", response_model=HealthResponse, tags=["operations"])
    async def ready(response: Response) -> HealthResponse:
        return await health(response)

    @app.get("/", dependencies=protected, tags=["operations"])
    async def root() -> dict[str, Any]:
        return {
            "service": "hermes-knowledge",
            "version": __version__,
            "generation": index.snapshot.generation,
            "endpoints": [
                "/search",
                "/graph",
                "/notes",
                "/vault",
                "/skills",
                "/connections/discover",
            ],
        }

    @app.get(
        "/vault",
        response_model=VaultInfo,
        dependencies=protected,
        tags=["operations"],
    )
    async def vault() -> VaultInfo:
        # Never return knowledge_root: browser clients only need the configured
        # Obsidian label and vault-relative URIs.
        return VaultInfo(
            name=settings.vault_name,
            obsidian_uri=obsidian_uri(settings.vault_name),
            auto_index=settings.auto_index,
            scan_interval_seconds=settings.scan_interval_seconds,
        )

    @app.get(
        "/stats",
        response_model=StatsResponse,
        dependencies=protected,
        tags=["operations"],
    )
    async def stats() -> StatsResponse:
        return index.stats()

    @app.post(
        "/index",
        response_model=IndexReport,
        dependencies=protected,
        tags=["operations"],
    )
    async def rebuild_index() -> IndexReport:
        try:
            return await asyncio.to_thread(index.reindex)
        except Exception as exc:
            raise HTTPException(
                status_code=500, detail=f"indexing failed: {exc}"
            ) from exc

    def require_mutation_slot() -> None:
        if mutation_lock.locked():
            raise HTTPException(
                status_code=429,
                detail="another knowledge mutation is in progress; retry shortly",
                headers={"Retry-After": "2"},
            )

    async def mutate_and_reindex(callback: Any) -> NodeDetail:
        # Import extraction can hold this lock for most of the batch deadline.
        # Fail before queueing so a timed-out browser request can never commit
        # later, after the user has already received an ambiguous failure.
        require_mutation_slot()
        async with mutation_lock:
            try:
                committed = await asyncio.to_thread(callback)
                # Embedding a mature vault can take longer than the browser's
                # mutation timeout. The Markdown commit is already durable, so
                # enqueue one coalesced rebuild and acknowledge it immediately.
                # The queue epoch guarantees a scan already in flight performs
                # a follow-up pass that observes this mutation.
                queue_background_reindex()
                return committed.model_copy(update={"index_state": "pending"})
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="node not found") from exc
            except PermissionError as exc:
                raise HTTPException(status_code=403, detail=str(exc)) from exc
            except RevisionConflictError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except IdempotencyConflictError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except ConditionalWriteUnavailableError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except OSError as exc:
                raise HTTPException(
                    status_code=500, detail=f"could not persist note: {exc}"
                ) from exc

    async def list_current_nodes(
        *,
        kinds: list[NodeKind] | None = None,
        tag: str | None = None,
        permanent: bool | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[NodeSummary]:
        # While an embedding rebuild is pending, Markdown remains the durable
        # authority. Listing it directly preserves read-after-write without
        # making the request wait behind the reindex lock.
        documents = None
        if await asyncio.to_thread(index.needs_reindex):
            documents, _ = await asyncio.to_thread(repository.load)
        return [
            document.summary()
            for document in index.list_nodes(
                kinds=kinds,
                tag=tag,
                permanent=permanent,
                limit=limit,
                offset=offset,
                documents=documents,
            )
        ]

    @app.get(
        "/nodes",
        response_model=list[NodeSummary],
        dependencies=protected,
        tags=["knowledge"],
    )
    async def nodes(
        kind: Annotated[list[NodeKind] | None, Query()] = None,
        tag: str | None = None,
        permanent: bool | None = None,
        limit: Annotated[int, Query(ge=1, le=2_000)] = 500,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> list[NodeSummary]:
        return await list_current_nodes(
            kinds=kind,
            tag=tag,
            permanent=permanent,
            limit=limit,
            offset=offset,
        )

    @app.get(
        "/notes",
        response_model=list[NodeSummary],
        dependencies=protected,
        tags=["knowledge"],
    )
    async def notes(
        tag: str | None = None,
        permanent: bool | None = None,
        limit: Annotated[int, Query(ge=1, le=2_000)] = 500,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> list[NodeSummary]:
        return await list_current_nodes(
            kinds=[NodeKind.note],
            tag=tag,
            permanent=permanent,
            limit=limit,
            offset=offset,
        )

    @app.get(
        "/skills",
        response_model=list[NodeSummary],
        dependencies=protected,
        tags=["knowledge"],
    )
    async def skills(
        limit: Annotated[int, Query(ge=1, le=2_000)] = 500,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> list[NodeSummary]:
        return await list_current_nodes(
            kinds=[NodeKind.skill], limit=limit, offset=offset
        )

    @app.get(
        "/memories",
        response_model=list[NodeSummary],
        dependencies=protected,
        tags=["knowledge"],
    )
    async def memories(
        limit: Annotated[int, Query(ge=1, le=2_000)] = 500,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> list[NodeSummary]:
        return await list_current_nodes(
            kinds=[NodeKind.memory], limit=limit, offset=offset
        )

    @app.get(
        "/nodes/{node_id}",
        response_model=NodeDetail,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def get_node(node_id: str) -> NodeDetail:
        try:
            if await asyncio.to_thread(index.needs_reindex):
                return (await asyncio.to_thread(repository.get, node_id)).detail()
            return index.get(node_id).detail()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="node not found") from exc

    @app.delete(
        "/nodes/{node_id}",
        response_model=DeleteNodeResponse,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def delete_node(
        node_id: str,
        payload: DeleteNodeRequest,
    ) -> DeleteNodeResponse:
        require_mutation_slot()
        async with mutation_lock:
            try:
                document = await asyncio.to_thread(repository.get, node_id)
                receipt = await asyncio.to_thread(
                    repository.trash,
                    document,
                    expected_revision=payload.expected_revision,
                )
                await asyncio.to_thread(index.hide_node, node_id)
                queue_background_reindex()
                return DeleteNodeResponse(
                    id=receipt.node_id,
                    trashed_path=receipt.trashed_path,
                    index_state="pending",
                    original_trashed=receipt.original_trashed,
                )
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="node not found") from exc
            except PermissionError as exc:
                raise HTTPException(status_code=403, detail=str(exc)) from exc
            except RevisionConflictError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except ConditionalWriteUnavailableError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except OSError as exc:
                raise HTTPException(
                    status_code=500, detail="could not move node to recoverable trash"
                ) from exc

    @app.post(
        "/notes",
        response_model=NodeDetail,
        status_code=status.HTTP_201_CREATED,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def create_note(payload: CreateNoteRequest) -> NodeDetail:
        return await mutate_and_reindex(
            lambda: repository.create(
                title=payload.title,
                content=payload.content,
                tags=payload.tags,
                kind=payload.kind,
                links=payload.links,
                permanent=payload.permanent,
                metadata=payload.metadata,
                idempotency_key=payload.idempotency_key,
            )
        )

    @app.post(
        "/ingest",
        response_model=NodeDetail,
        status_code=status.HTTP_201_CREATED,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def ingest(payload: IngestRequest) -> NodeDetail:
        metadata = {**payload.metadata}
        if payload.source:
            metadata["source"] = payload.source
        return await mutate_and_reindex(
            lambda: repository.create(
                title=payload.title,
                content=payload.content,
                tags=payload.tags,
                kind=payload.kind,
                links=payload.links,
                permanent=payload.permanent,
                metadata=metadata,
                idempotency_key=payload.idempotency_key,
            )
        )

    @app.get(
        "/imports/capabilities",
        response_model=ImportCapabilities,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def import_capabilities() -> ImportCapabilities:
        return ImportCapabilities(
            max_files=settings.import_max_files,
            max_file_bytes=settings.import_max_file_bytes,
            max_total_bytes=settings.import_max_total_bytes,
            accepted_extensions=accepted_extensions(),
            accepted_media_types=accepted_media_types(),
            malware_scan=False,
        )

    @app.post(
        "/imports",
        response_model=ImportResponse,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def import_files(
        request: Request,
        response: Response,
        files: Annotated[list[UploadFile], File()],
        tags: Annotated[str, Form(max_length=5_000)] = "",
        target: Annotated[str, Form(pattern=r"^(inbox|permanent)$")] = "inbox",
    ) -> ImportResponse:
        normalized_tags = [value.strip() for value in tags.split(",") if value.strip()]
        if import_lock.locked():
            raise HTTPException(
                status_code=429,
                detail="another document import is already running; retry shortly",
            )
        async with import_lock, mutation_lock:
            try:
                results, changed = await importer.ingest(
                    files,
                    tags=normalized_tags,
                    permanent=target == "permanent",
                    disconnected=request.is_disconnected,
                )
            except DocumentImportError as exc:
                raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
            except (ValueError, UnicodeError) as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except OSError as exc:
                raise HTTPException(status_code=500, detail="could not commit import") from exc
            index_state = "ready"
            if changed:
                # Extraction plus a full embedding pass can exceed the BFF's
                # total deadline after the batch is already durable. Return
                # the atomic commit receipt and converge via the same bounded,
                # coalesced queue used by note mutations.
                queue_background_reindex()
                index_state = "pending"
            response.status_code = 201 if changed else 200
            return ImportResponse(results=results, index_state=index_state)

    async def update_note_impl(node_id: str, payload: UpdateNoteRequest) -> NodeDetail:
        changes = payload.model_dump(exclude_unset=True)
        expected_revision = changes.pop("expected_revision")
        return await mutate_and_reindex(
            lambda: repository.update(
                repository.get(node_id), changes, expected_revision=expected_revision
            )
        )

    @app.put(
        "/notes/{node_id}",
        response_model=NodeDetail,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def update_note(node_id: str, payload: UpdateNoteRequest) -> NodeDetail:
        return await update_note_impl(node_id, payload)

    @app.patch(
        "/notes/{node_id}",
        response_model=NodeDetail,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def patch_note(node_id: str, payload: UpdateNoteRequest) -> NodeDetail:
        return await update_note_impl(node_id, payload)

    @app.post(
        "/notes/{node_id}/promote",
        response_model=NodeDetail,
        dependencies=protected,
        tags=["knowledge"],
    )
    async def promote_note(
        node_id: str, payload: PromoteNoteRequest
    ) -> NodeDetail:
        return await mutate_and_reindex(
            lambda: repository.promote(
                repository.get(node_id),
                payload.title,
                payload.summary,
                payload.tags,
                payload.expected_revision,
            )
        )

    @app.get(
        "/search",
        response_model=list[SearchHit],
        dependencies=protected,
        tags=["discovery"],
    )
    async def search(
        q: Annotated[str, Query(min_length=1, max_length=2_000)],
        limit: Annotated[int, Query(ge=1, le=100)] = 10,
        kind: Annotated[list[NodeKind] | None, Query()] = None,
        tag: Annotated[list[str] | None, Query()] = None,
    ) -> list[SearchHit]:
        return await asyncio.to_thread(index.search, q, limit, kind, tag)

    @app.post(
        "/search",
        response_model=list[SearchHit],
        dependencies=protected,
        tags=["discovery"],
    )
    async def search_post(payload: SearchRequest) -> list[SearchHit]:
        return await asyncio.to_thread(
            index.search, payload.query, payload.limit, payload.kinds, payload.tags
        )

    @app.get(
        "/graph",
        response_model=GraphResponse,
        dependencies=protected,
        tags=["discovery"],
    )
    async def graph(
        semantic: bool = True,
        min_score: Annotated[float, Query(ge=0.0, le=1.0)] | None = None,
        limit: Annotated[int, Query(ge=1, le=5_000)] = 1_000,
    ) -> GraphResponse:
        threshold = settings.semantic_threshold if min_score is None else min_score
        return await asyncio.to_thread(
            index.graph, semantic, threshold, limit, False
        )

    @app.post(
        "/connections/discover",
        response_model=list[Connection],
        dependencies=protected,
        tags=["discovery"],
    )
    async def discover(payload: DiscoverRequest) -> list[Connection]:
        try:
            return await asyncio.to_thread(
                index.discover_connections,
                node_id=payload.node_id,
                limit=payload.limit,
                min_score=payload.min_score,
                kinds=payload.kinds,
                include_system=False,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="node not found") from exc

    @app.get(
        "/nodes/{node_id}/connections",
        response_model=list[Connection],
        dependencies=protected,
        tags=["discovery"],
    )
    async def node_connections(
        node_id: str,
        limit: Annotated[int, Query(ge=1, le=100)] = 10,
        min_score: Annotated[float, Query(ge=0.0, le=1.0)] | None = None,
    ) -> list[Connection]:
        try:
            return await asyncio.to_thread(
                index.discover_connections,
                node_id=node_id,
                limit=limit,
                min_score=settings.semantic_threshold
                if min_score is None
                else min_score,
                include_system=False,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="node not found") from exc

    @app.post(
        "/activation",
        response_model=ActivationResponse,
        dependencies=protected,
        tags=["discovery"],
    )
    async def activation(payload: ActivationRequest) -> ActivationResponse:
        try:
            return await asyncio.to_thread(
                index.activate,
                payload.seed_ids,
                payload.depth,
                payload.decay,
                payload.limit,
                payload.semantic,
                False,
            )
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail=f"seed node not found: {exc.args[0]}"
            ) from exc

    @app.post(
        "/insights/extract",
        response_model=list[InsightCandidate],
        dependencies=protected,
        tags=["discovery"],
    )
    async def extract_insights(payload: InsightRequest) -> list[InsightCandidate]:
        try:
            return await asyncio.to_thread(
                index.extract_insights,
                payload.node_ids,
                payload.limit,
                payload.minimum_words,
                payload.include_permanent,
            )
        except KeyError as exc:
            raise HTTPException(
                status_code=404, detail=f"node not found: {exc.args[0]}"
            ) from exc

    return app


app = create_app()
