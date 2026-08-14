from __future__ import annotations

import heapq
import logging
import os
import re
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import Settings
from .documents import KnowledgeDocument, MarkdownRepository, dump_manifest
from .embeddings import Embedder, build_embedder, query_terms
from .models import (
    ActivatedNode,
    ActivationResponse,
    Connection,
    GraphEdge,
    GraphNode,
    GraphResponse,
    IndexReport,
    InsightCandidate,
    NodeKind,
    SearchHit,
    StatsResponse,
)

logger = logging.getLogger(__name__)

MAX_GRAPH_TAGS_PER_NODE = 64
MAX_GRAPH_TAG_NEIGHBORS = 25
MAX_GRAPH_TAG_EDGES = 20_000
TAG_RING_FANOUT = 2
LEGACY_SYSTEM_SEED_IDS = frozenset(
    {"memory-operator-preferences", "skill-daily-synthesis", "welcome-to-hermes-knowledge"}
)


class VectorStore:
    def __init__(self, vectors: list[list[float]]):
        self.vectors = vectors
        self.backend = "python"
        self._faiss: Any = None
        self._numpy: Any = None
        if not vectors:
            return
        try:
            import faiss
            import numpy as np

            matrix = np.asarray(vectors, dtype="float32")
            index = faiss.IndexFlatIP(matrix.shape[1])
            index.add(matrix)
            self._faiss = index
            self._numpy = np
            self.backend = "faiss"
        except Exception as exc:  # noqa: BLE001 - optional native backend may fail in many ways
            logger.info("FAISS unavailable; using exact Python cosine search: %s", exc)

    def search(
        self, vector: list[float], limit: int, *, exclude: int | None = None
    ) -> list[tuple[int, float]]:
        if not self.vectors or limit <= 0:
            return []
        count = min(len(self.vectors), limit + (1 if exclude is not None else 0))
        if self._faiss is not None:
            query = self._numpy.asarray([vector], dtype="float32")
            scores, indices = self._faiss.search(query, count)
            found = [
                (int(index), float(score))
                for index, score in zip(indices[0], scores[0])
                if index >= 0 and index != exclude
            ]
            return found[:limit]
        scored = (
            (index, sum(left * right for left, right in zip(vector, candidate)))
            for index, candidate in enumerate(self.vectors)
            if index != exclude
        )
        return heapq.nlargest(limit, scored, key=lambda item: (item[1], -item[0]))

    def persist_faiss(self, path: Path) -> None:
        if self._faiss is None:
            return
        import faiss

        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        faiss.write_index(self._faiss, str(temporary))
        os.replace(temporary, path)


@dataclass(frozen=True, slots=True)
class Snapshot:
    generation: int
    documents: tuple[KnowledgeDocument, ...]
    by_id: dict[str, KnowledgeDocument]
    positions: dict[str, int]
    vectors: tuple[list[float], ...]
    vector_store: VectorStore
    fingerprint: str
    explicit_links: int


def _empty_snapshot() -> Snapshot:
    return Snapshot(0, (), {}, {}, (), VectorStore([]), "", 0)


class KnowledgeIndex:
    """Thread-safe, atomically replaced in-memory knowledge index."""

    def __init__(
        self,
        settings: Settings,
        repository: MarkdownRepository | None = None,
        embedder: Embedder | None = None,
    ):
        self.settings = settings
        self.repository = repository or MarkdownRepository(settings)
        self.embedder = embedder or build_embedder(settings)
        self._snapshot = _empty_snapshot()
        self._personal_snapshot: Snapshot | None = None
        self._state_lock = threading.RLock()
        self._reindex_lock = threading.Lock()
        self._embedding_lock = threading.Lock()
        self._indexing = False
        self._last_indexed_at: datetime | None = None
        self._last_duration_ms: int | None = None
        self._last_error: str | None = None
        self._tombstones: dict[str, int] = {}
        self._tombstone_epoch = 0

    @property
    def snapshot(self) -> Snapshot:
        with self._state_lock:
            return self._snapshot

    @property
    def ready(self) -> bool:
        return self.snapshot.generation > 0

    @property
    def indexing(self) -> bool:
        with self._state_lock:
            return self._indexing

    @property
    def last_error(self) -> str | None:
        with self._state_lock:
            return self._last_error

    def needs_reindex(self) -> bool:
        try:
            return self.repository.fingerprint() != self.snapshot.fingerprint
        except Exception as exc:  # noqa: BLE001 - scanner errors must surface via health
            with self._state_lock:
                self._last_error = f"scan failed: {exc}"
            return False

    @staticmethod
    def _is_personal(document: KnowledgeDocument) -> bool:
        marker = document.metadata.get("system_seed", document.metadata.get("system_managed", False))
        marked = marker is True or str(marker).strip().casefold() in {"1", "true", "yes", "on"}
        return (
            document.source == "vault"
            and document.id not in LEGACY_SYSTEM_SEED_IDS
            and not marked
        )

    def _scoped_snapshot(self, include_system: bool) -> Snapshot:
        with self._state_lock:
            snapshot = self._snapshot
            if include_system:
                return snapshot
            if (
                self._personal_snapshot is not None
                and self._personal_snapshot.generation == snapshot.generation
                and self._personal_snapshot.fingerprint == snapshot.fingerprint
            ):
                return self._personal_snapshot
        documents = tuple(
            document for document in snapshot.documents if self._is_personal(document)
        )
        document_ids = {document.id for document in documents}
        vectors = tuple(snapshot.vectors[snapshot.positions[document.id]] for document in documents)
        personal = Snapshot(
            generation=snapshot.generation,
            documents=documents,
            by_id={document.id: document for document in documents},
            positions={document.id: position for position, document in enumerate(documents)},
            vectors=vectors,
            vector_store=VectorStore(list(vectors)),
            fingerprint=snapshot.fingerprint,
            explicit_links=sum(
                target in document_ids
                for document in documents
                for target in document.resolved_links
            ),
        )
        with self._state_lock:
            if self._snapshot is snapshot:
                self._personal_snapshot = personal
        return personal

    def reindex(self) -> IndexReport:
        with self._reindex_lock:
            with self._state_lock:
                self._indexing = True
                scan_tombstone_epoch = self._tombstone_epoch
            started = time.monotonic()
            try:
                documents, fingerprint = self.repository.load()
                vectors = self._encode(
                    [document.embedding_text for document in documents]
                )
                if len(vectors) != len(documents):
                    raise RuntimeError(
                        "embedding backend returned the wrong number of vectors"
                    )
                if vectors and any(
                    len(vector) != self.embedder.dimension for vector in vectors
                ):
                    raise RuntimeError(
                        "embedding backend returned an unexpected dimension"
                    )
                store = VectorStore(vectors)
                old = self.snapshot
                snapshot = Snapshot(
                    generation=old.generation + 1,
                    documents=tuple(documents),
                    by_id={document.id: document for document in documents},
                    positions={
                        document.id: index for index, document in enumerate(documents)
                    },
                    vectors=tuple(vectors),
                    vector_store=store,
                    fingerprint=fingerprint,
                    explicit_links=sum(
                        len(document.resolved_links) for document in documents
                    ),
                )
                duration_ms = int((time.monotonic() - started) * 1000)
                indexed_at = datetime.now(UTC)
                with self._state_lock:
                    # This repository scan is authoritative for tombstones
                    # that predate it: an absent node confirms deletion, while
                    # a present node is an operator restore from trash. Only
                    # tombstones created during this scan must be re-applied.
                    self._tombstones = {
                        identifier: epoch
                        for identifier, epoch in self._tombstones.items()
                        if epoch > scan_tombstone_epoch
                    }
                    active_tombstones = set(self._tombstones)
                    if active_tombstones:
                        kept = [
                            position
                            for position, document in enumerate(snapshot.documents)
                            if document.id not in active_tombstones
                        ]
                        filtered_documents = tuple(
                            snapshot.documents[position] for position in kept
                        )
                        filtered_vectors = tuple(snapshot.vectors[position] for position in kept)
                        filtered_ids = {
                            document.id for document in filtered_documents
                        }
                        snapshot = Snapshot(
                            generation=snapshot.generation,
                            documents=filtered_documents,
                            by_id={
                                document.id: document
                                for document in filtered_documents
                            },
                            positions={
                                document.id: position
                                for position, document in enumerate(filtered_documents)
                            },
                            vectors=filtered_vectors,
                            vector_store=VectorStore(list(filtered_vectors)),
                            fingerprint=snapshot.fingerprint,
                            explicit_links=sum(
                                target in filtered_ids
                                for document in filtered_documents
                                for target in document.resolved_links
                            ),
                        )
                    self._snapshot = snapshot
                    self._personal_snapshot = None
                    self._last_indexed_at = indexed_at
                    self._last_duration_ms = duration_ms
                    self._last_error = None
                self._persist(snapshot, duration_ms, indexed_at)
                return IndexReport(
                    generation=snapshot.generation,
                    nodes=len(documents),
                    links=snapshot.explicit_links,
                    duration_ms=duration_ms,
                    backend=self.embedder.name,
                    fingerprint=fingerprint,
                )
            except Exception as exc:
                logger.exception("knowledge reindex failed")
                with self._state_lock:
                    self._last_error = str(exc)
                raise
            finally:
                with self._state_lock:
                    self._indexing = False

    def _encode(self, texts: list[str]) -> list[list[float]]:
        # Some tokenizer/model versions reuse mutable inference buffers.
        with self._embedding_lock:
            return self.embedder.encode(texts)

    def _persist(
        self, snapshot: Snapshot, duration_ms: int, indexed_at: datetime
    ) -> None:
        manifest = {
            "schema": 1,
            "generation": snapshot.generation,
            "fingerprint": snapshot.fingerprint,
            "indexed_at": indexed_at.isoformat(),
            "duration_ms": duration_ms,
            "embedding_backend": self.embedder.name,
            "vector_backend": snapshot.vector_store.backend,
            "dimension": self.embedder.dimension,
            "nodes": [
                {
                    "id": document.id,
                    "kind": document.kind.value,
                    "title": document.title,
                    "path": document.display_path,
                    "updated_at": document.updated_at.isoformat(),
                }
                for document in snapshot.documents
            ],
        }
        try:
            dump_manifest(self.settings.state_dir / "index-manifest.json", manifest)
            snapshot.vector_store.persist_faiss(
                self.settings.state_dir / "vectors.faiss"
            )
        except Exception as exc:  # noqa: BLE001 - native FAISS persistence is best-effort
            # The live index remains valid even if an optional state mount turns read-only.
            logger.warning("could not persist knowledge index: %s", exc)

    def get(self, node_id: str) -> KnowledgeDocument:
        document = self.snapshot.by_id.get(node_id)
        if document is None:
            raise KeyError(node_id)
        return document

    def hide_node(self, node_id: str) -> bool:
        """Immediately tombstone a durably trashed node from every read surface."""
        with self._state_lock:
            self._tombstone_epoch += 1
            self._tombstones[node_id] = self._tombstone_epoch
            snapshot = self._snapshot
            if node_id not in snapshot.by_id:
                return False
            kept_positions = [
                position
                for position, document in enumerate(snapshot.documents)
                if document.id != node_id
            ]
            documents = tuple(snapshot.documents[position] for position in kept_positions)
            vectors = tuple(snapshot.vectors[position] for position in kept_positions)
            document_ids = {document.id for document in documents}
            self._snapshot = Snapshot(
                generation=snapshot.generation + 1,
                documents=documents,
                by_id={document.id: document for document in documents},
                positions={
                    document.id: position
                    for position, document in enumerate(documents)
                },
                vectors=vectors,
                vector_store=VectorStore(list(vectors)),
                # Preserve the old fingerprint so needs_reindex remains true
                # until a complete background rebuild observes durable trash.
                fingerprint=snapshot.fingerprint,
                explicit_links=sum(
                    target in document_ids
                    for document in documents
                    for target in document.resolved_links
                ),
            )
            self._personal_snapshot = None
            return True

    def list_nodes(
        self,
        *,
        kinds: Iterable[NodeKind] | None = None,
        tag: str | None = None,
        permanent: bool | None = None,
        limit: int = 500,
        offset: int = 0,
        documents: Iterable[KnowledgeDocument] | None = None,
    ) -> list[KnowledgeDocument]:
        allowed = set(kinds) if kinds else None
        normalized_tag = tag.casefold() if tag else None
        with self._state_lock:
            active_tombstones = set(self._tombstones)
        nodes = [
            document
            for document in (
                self.snapshot.documents if documents is None else documents
            )
            if document.id not in active_tombstones
            if (allowed is None or document.kind in allowed)
            and (
                normalized_tag is None
                or normalized_tag in {item.casefold() for item in document.tags}
            )
            and (permanent is None or document.permanent is permanent)
        ]
        nodes.sort(
            key=lambda item: (item.updated_at, item.title.casefold()), reverse=True
        )
        return nodes[offset : offset + limit]

    def search(
        self,
        query: str,
        limit: int,
        kinds: Iterable[NodeKind] | None = None,
        tags: Iterable[str] | None = None,
    ) -> list[SearchHit]:
        snapshot = self.snapshot
        if not snapshot.documents:
            return []
        query_vector = self._encode([query])[0]
        allowed = set(kinds) if kinds else None
        required_tags = {tag.casefold() for tag in tags or ()}
        terms = query_terms(query)
        candidate_limit = min(len(snapshot.documents), max(100, limit * 10))
        candidates = snapshot.vector_store.search(query_vector, candidate_limit)
        results: list[SearchHit] = []
        for position, raw_semantic in candidates:
            document = snapshot.documents[position]
            if allowed is not None and document.kind not in allowed:
                continue
            document_tags = {tag.casefold() for tag in document.tags}
            if required_tags and not required_tags.issubset(document_tags):
                continue
            matched = sorted(terms & document.terms)
            lexical = len(matched) / len(terms) if terms else 0.0
            semantic = max(0.0, min(1.0, raw_semantic))
            score = min(1.0, semantic * 0.82 + lexical * 0.18)
            results.append(
                SearchHit(
                    node=document.summary(),
                    score=round(score, 6),
                    semantic_score=round(semantic, 6),
                    lexical_score=round(lexical, 6),
                    matched_terms=matched[:20],
                )
            )
        results.sort(key=lambda hit: (hit.score, hit.node.updated_at), reverse=True)
        return results[:limit]

    def _pair_connection(
        self, left: KnowledgeDocument, right: KnowledgeDocument, semantic: float
    ) -> Connection:
        left_tags = {tag.casefold(): tag for tag in left.tags}
        right_tags = {tag.casefold(): tag for tag in right.tags}
        shared_tag_keys = sorted(left_tags.keys() & right_tags.keys())
        shared_tags = [left_tags[key] for key in shared_tag_keys]
        left_terms = query_terms(f"{left.title} {left.content}")
        right_terms = query_terms(f"{right.title} {right.content}")
        shared_terms = sorted(
            left_terms & right_terms, key=lambda value: (-len(value), value)
        )[:10]
        tag_union = len(left_tags.keys() | right_tags.keys())
        term_union = len(left_terms | right_terms)
        tag_score = len(shared_tags) / tag_union if tag_union else 0.0
        term_score = len(shared_terms) / min(term_union, 40) if term_union else 0.0
        score = min(
            1.0, max(0.0, semantic) * 0.78 + tag_score * 0.14 + term_score * 0.08
        )
        evidence: list[str] = []
        if shared_tags:
            evidence.append(f"shared tags: {', '.join(shared_tags[:4])}")
        if shared_terms:
            evidence.append(f"shared concepts: {', '.join(shared_terms[:4])}")
        if not evidence:
            evidence.append("semantic proximity")
        return Connection(
            source=left.summary(),
            target=right.summary(),
            score=round(score, 6),
            semantic_score=round(max(0.0, min(1.0, semantic)), 6),
            shared_tags=shared_tags,
            shared_terms=shared_terms,
            reason="; ".join(evidence),
        )

    def discover_connections(
        self,
        *,
        node_id: str | None,
        limit: int,
        min_score: float,
        kinds: Iterable[NodeKind] | None = None,
        include_system: bool = False,
    ) -> list[Connection]:
        snapshot = self._scoped_snapshot(include_system)
        allowed = set(kinds) if kinds else None
        if node_id is not None and node_id not in snapshot.by_id:
            raise KeyError(node_id)
        sources = [snapshot.by_id[node_id]] if node_id else list(snapshot.documents)
        seen: set[tuple[str, str]] = set()
        connections: list[Connection] = []
        for source in sources:
            source_position = snapshot.positions[source.id]
            nearby = snapshot.vector_store.search(
                snapshot.vectors[source_position],
                self.settings.semantic_neighbors * (3 if allowed else 1),
                exclude=source_position,
            )
            for target_position, semantic in nearby:
                target = snapshot.documents[target_position]
                if allowed is not None and target.kind not in allowed:
                    continue
                pair = tuple(sorted((source.id, target.id)))
                if (
                    pair in seen
                    or target.id in source.resolved_links
                    or source.id in target.resolved_links
                ):
                    continue
                seen.add(pair)
                connection = self._pair_connection(source, target, semantic)
                if connection.score >= min_score:
                    connections.append(connection)
        connections.sort(
            key=lambda item: (item.score, item.source.id, item.target.id), reverse=True
        )
        return connections[:limit]

    def graph(
        self, include_semantic: bool, min_score: float, limit: int, include_system: bool = False
    ) -> GraphResponse:
        snapshot = self._scoped_snapshot(include_system)
        selected = self._select_graph_documents(snapshot, limit)
        selected_ids = {document.id for document in selected}
        edge_map: dict[tuple[str, str, str], GraphEdge] = {}
        for document in selected:
            for target in document.resolved_links:
                if target not in selected_ids:
                    continue
                edge_map[(document.id, target, "references")] = GraphEdge(
                    source=document.id,
                    target=target,
                    relation="references",
                    weight=1.0,
                    evidence=["markdown link"],
                )
        for edge in self._shared_tag_edges(selected):
            edge_map[(edge.source, edge.target, edge.relation)] = edge
        if include_semantic:
            discoveries = self.discover_connections(
                node_id=None,
                limit=max(limit * self.settings.semantic_neighbors, 10),
                min_score=min_score,
                include_system=include_system,
            )
            for connection in discoveries:
                if (
                    connection.source.id not in selected_ids
                    or connection.target.id not in selected_ids
                ):
                    continue
                source, target = sorted((connection.source.id, connection.target.id))
                edge_map[(source, target, "semantic")] = GraphEdge(
                    source=source,
                    target=target,
                    relation="semantic",
                    weight=connection.score,
                    evidence=[connection.reason],
                )
        degree = {document.id: 0 for document in selected}
        for edge in edge_map.values():
            degree[edge.source] += 1
            degree[edge.target] += 1
        nodes = [
            GraphNode(**document.summary().model_dump(), degree=degree[document.id])
            for document in selected
        ]
        return GraphResponse(
            nodes=nodes,
            edges=sorted(
                edge_map.values(),
                key=lambda edge: (edge.relation, edge.source, edge.target),
            ),
            generation=snapshot.generation,
        )

    def _select_graph_documents(
        self, snapshot: Snapshot, limit: int
    ) -> list[KnowledgeDocument]:
        """Select a bounded representative induced subgraph deterministically."""
        capacity = min(max(limit, 0), len(snapshot.documents))
        if capacity == len(snapshot.documents):
            return list(snapshot.documents)
        if capacity == 0:
            return []

        explicit_pairs: list[tuple[str, str]] = []
        seen_explicit: set[tuple[str, str]] = set()
        for document in snapshot.documents:
            for target in document.resolved_links:
                if target not in snapshot.by_id or target == document.id:
                    continue
                canonical = tuple(sorted((document.id, target)))
                if canonical in seen_explicit:
                    continue
                seen_explicit.add(canonical)
                explicit_pairs.append((document.id, target))

        selected_ids: set[str] = set()
        present_kinds = tuple(
            kind
            for kind in NodeKind
            if any(document.kind is kind for document in snapshot.documents)
        )
        coverage_target = min(capacity, len(present_kinds))

        def group_fits(group: tuple[str, ...]) -> bool:
            missing = {
                identifier
                for identifier in group
                if identifier in snapshot.by_id and identifier not in selected_ids
            }
            kinds_after = {
                snapshot.by_id[identifier].kind for identifier in selected_ids | missing
            }
            reserved_kind_slots = max(0, coverage_target - len(kinds_after))
            return len(selected_ids) + len(missing) + reserved_kind_slots <= capacity

        def add_group(group: tuple[str, ...]) -> bool:
            if not group_fits(group):
                return False
            missing = tuple(
                identifier
                for identifier in dict.fromkeys(group)
                if identifier in snapshot.by_id and identifier not in selected_ids
            )
            selected_ids.update(missing)
            return True

        def add_first_fitting(pairs: list[tuple[str, str]]) -> None:
            for source, target in pairs:
                if add_group((source, target)):
                    return

        # Preserve at least one real edge of each non-semantic relation when
        # the caller's node budget can contain its endpoints without crowding
        # out the maximum possible NodeKind coverage.
        add_first_fitting(explicit_pairs)
        tag_pair = self._first_shared_tag_pair(snapshot, selected_ids, group_fits)
        if tag_pair is not None:
            add_group(tag_pair)

        # Give every represented node kind one stable exemplar when capacity
        # remains. NodeKind declaration order is part of the deterministic tie.
        for kind in present_kinds:
            if any(snapshot.by_id[node_id].kind is kind for node_id in selected_ids):
                continue
            representative = next(
                (document for document in snapshot.documents if document.kind is kind),
                None,
            )
            if representative is not None:
                add_group((representative.id,))

        # Spend the remaining budget on complete edge endpoint pairs before
        # falling back to the stable repository/snapshot ordering.
        for source, target in explicit_pairs:
            if len(selected_ids) >= capacity:
                break
            add_group((source, target))
        for document in snapshot.documents:
            if len(selected_ids) >= capacity:
                break
            add_group((document.id,))

        # Selection priorities must not introduce response-order churn.
        return [
            document for document in snapshot.documents if document.id in selected_ids
        ]

    def _first_shared_tag_pair(
        self,
        snapshot: Snapshot,
        selected_ids: set[str],
        fits: Callable[[tuple[str, ...]], bool],
    ) -> tuple[str, str] | None:
        """Find the first feasible shared-tag pair in one bounded stable scan."""
        # Pair feasibility depends only on whether an endpoint is already
        # selected and which kind it represents. Keeping the first document
        # for each such bucket is therefore sufficient; no all-pairs graph or
        # full-snapshot GraphEdge materialization is needed here.
        seen: dict[str, dict[tuple[NodeKind, bool], str]] = {}
        for document in snapshot.documents:
            for tag in self._normalized_graph_tags(document):
                representatives = seen.setdefault(tag, {})
                for source in representatives.values():
                    candidate = (source, document.id)
                    if fits(candidate):
                        return candidate
                bucket = (document.kind, document.id in selected_ids)
                representatives.setdefault(bucket, document.id)
        return None

    @staticmethod
    def _normalized_graph_tags(document: KnowledgeDocument) -> dict[str, str]:
        normalized = {
            tag.strip().casefold(): tag.strip() for tag in document.tags if tag.strip()
        }
        return dict(sorted(normalized.items())[:MAX_GRAPH_TAGS_PER_NODE])

    def _shared_tag_edges(self, documents: list[KnowledgeDocument]) -> list[GraphEdge]:
        """Build a deterministic, degree-bounded tag co-occurrence subgraph."""
        if len(documents) < 2:
            return []
        tags_by_id: dict[str, dict[str, str]] = {}
        members_by_tag: dict[str, list[str]] = {}
        for document in documents:
            normalized = self._normalized_graph_tags(document)
            tags_by_id[document.id] = normalized
            for tag in normalized:
                members_by_tag.setdefault(tag, []).append(document.id)

        candidates: set[tuple[str, str]] = set()
        for tag in sorted(members_by_tag):
            members = sorted(set(members_by_tag[tag]))
            if len(members) < 2:
                continue
            fanout = min(TAG_RING_FANOUT, len(members) - 1)
            for position, source in enumerate(members):
                for offset in range(1, fanout + 1):
                    target = members[(position + offset) % len(members)]
                    if source != target:
                        candidates.add(tuple(sorted((source, target))))

        ranked: list[tuple[int, str, str, list[str]]] = []
        for source, target in candidates:
            shared = sorted(tags_by_id[source].keys() & tags_by_id[target].keys())
            if shared:
                ranked.append((-len(shared), source, target, shared))
        ranked.sort()

        neighbor_limit = min(
            MAX_GRAPH_TAG_NEIGHBORS, max(1, self.settings.semantic_neighbors)
        )
        edge_limit = min(
            MAX_GRAPH_TAG_EDGES,
            len(documents) * neighbor_limit // 2,
        )
        degree = {document.id: 0 for document in documents}
        edges: list[GraphEdge] = []
        for _, source, target, shared in ranked:
            if len(edges) >= edge_limit:
                break
            if degree[source] >= neighbor_limit or degree[target] >= neighbor_limit:
                continue
            union = tags_by_id[source].keys() | tags_by_id[target].keys()
            weight = len(shared) / len(union) if union else 0.0
            display = [tags_by_id[source][tag] for tag in shared[:8]]
            edges.append(
                GraphEdge(
                    source=source,
                    target=target,
                    relation="tag",
                    weight=round(weight, 6),
                    evidence=[f"shared tag co-occurrence: {', '.join(display)}"],
                )
            )
            degree[source] += 1
            degree[target] += 1
        return edges

    def activate(
        self,
        seed_ids: list[str],
        depth: int,
        decay: float,
        limit: int,
        include_semantic: bool,
        include_system: bool = False,
    ) -> ActivationResponse:
        snapshot = self._scoped_snapshot(include_system)
        missing = [seed for seed in seed_ids if seed not in snapshot.by_id]
        if missing:
            raise KeyError(missing[0])
        adjacency: dict[str, list[tuple[str, float]]] = {
            document.id: [] for document in snapshot.documents
        }
        for document in snapshot.documents:
            for target in document.resolved_links:
                if target in adjacency:
                    adjacency[document.id].append((target, 1.0))
                    adjacency[target].append((document.id, 1.0))
        if include_semantic:
            for document in snapshot.documents:
                position = snapshot.positions[document.id]
                for target_position, score in snapshot.vector_store.search(
                    snapshot.vectors[position],
                    self.settings.semantic_neighbors,
                    exclude=position,
                ):
                    if score >= self.settings.semantic_threshold:
                        adjacency[document.id].append(
                            (snapshot.documents[target_position].id, max(0.0, score))
                        )

        best: dict[str, tuple[float, int, str | None]] = {
            seed: (1.0, 0, None) for seed in seed_ids
        }
        frontier: list[tuple[float, str, int, str | None]] = [
            (-1.0, seed, 0, None) for seed in seed_ids
        ]
        heapq.heapify(frontier)
        while frontier:
            negative_score, current, current_depth, _ = heapq.heappop(frontier)
            score = -negative_score
            if current_depth >= depth or score + 1e-9 < best[current][0]:
                continue
            for target, weight in adjacency[current]:
                propagated = score * decay * weight
                if propagated <= best.get(target, (0.0, 0, None))[0] + 1e-9:
                    continue
                best[target] = (propagated, current_depth + 1, current)
                heapq.heappush(
                    frontier, (-propagated, target, current_depth + 1, current)
                )
        activated = [
            ActivatedNode(
                node=snapshot.by_id[node_id].summary(),
                activation=round(score, 6),
                depth=node_depth,
                via=via,
            )
            for node_id, (score, node_depth, via) in best.items()
        ]
        activated.sort(
            key=lambda item: (item.activation, -item.depth, item.node.id), reverse=True
        )
        return ActivationResponse(seeds=seed_ids, nodes=activated[:limit])

    def stats(self) -> StatsResponse:
        snapshot = self.snapshot
        by_kind = {kind.value: 0 for kind in NodeKind}
        for document in snapshot.documents:
            by_kind[document.kind.value] += 1
        with self._state_lock:
            return StatsResponse(
                generation=snapshot.generation,
                total_nodes=len(snapshot.documents),
                nodes_by_kind=by_kind,
                explicit_links=snapshot.explicit_links,
                permanent_notes=sum(
                    document.permanent for document in snapshot.documents
                ),
                embedding_backend=self.embedder.name,
                vector_backend=snapshot.vector_store.backend,
                dimension=self.embedder.dimension,
                last_indexed_at=self._last_indexed_at,
                last_index_duration_ms=self._last_duration_ms,
                fingerprint=snapshot.fingerprint or None,
                indexing=self._indexing,
                last_error=self._last_error,
            )

    def extract_insights(
        self,
        node_ids: list[str] | None,
        limit: int,
        minimum_words: int,
        include_permanent: bool,
    ) -> list[InsightCandidate]:
        """Rank durable-looking statements locally for later Hermes synthesis.

        This is deliberately extractive: the sidecar never invents or sends note
        content elsewhere. Hermes can use these candidates in a scheduled synthesis.
        """
        snapshot = self.snapshot
        if node_ids:
            missing = [node_id for node_id in node_ids if node_id not in snapshot.by_id]
            if missing:
                raise KeyError(missing[0])
            sources = [snapshot.by_id[node_id] for node_id in node_ids]
        else:
            sources = [
                document
                for document in snapshot.documents
                if document.kind is NodeKind.note
                and (include_permanent or not document.permanent)
            ]
        cue_words = {
            "because",
            "therefore",
            "means",
            "enables",
            "requires",
            "prefer",
            "principle",
            "insight",
            "should",
            "avoid",
            "always",
            "never",
        }
        candidates: list[InsightCandidate] = []
        seen: set[str] = set()
        for source in sources:
            # Headings and list syntax are stripped while sentence boundaries remain.
            cleaned = re.sub(r"```.*?```", " ", source.content, flags=re.DOTALL)
            cleaned = re.sub(r"(?m)^\s*(?:#{1,6}|[-*+] |\d+[.)] )\s*", "", cleaned)
            sentences = re.split(r"(?<=[.!?])\s+|\n{2,}", cleaned)
            for sentence in sentences:
                text = " ".join(sentence.split()).strip(" >\t\r\n")
                terms = query_terms(text)
                if len(text.split()) < minimum_words or len(text) > 500 or not terms:
                    continue
                normalized = text.casefold()
                if normalized in seen:
                    continue
                seen.add(normalized)
                cues = sorted(terms & cue_words)
                specificity = min(1.0, len(terms) / 18)
                cue_score = min(1.0, len(cues) / 2)
                tag_overlap = len({tag.casefold() for tag in source.tags} & terms)
                confidence = min(
                    0.98,
                    0.34
                    + specificity * 0.34
                    + cue_score * 0.24
                    + min(0.08, tag_overlap * 0.04),
                )
                title_words = text.rstrip(".!?").split()[:9]
                suggested_title = " ".join(title_words)
                if len(text.rstrip(".!?").split()) > len(title_words):
                    suggested_title += "…"
                rationale = "specific, self-contained statement"
                if cues:
                    rationale += f" with durable-language cue: {', '.join(cues)}"
                candidates.append(
                    InsightCandidate(
                        source=source.summary(),
                        text=text,
                        suggested_title=suggested_title,
                        suggested_tags=source.tags[:8],
                        confidence=round(confidence, 6),
                        rationale=rationale,
                    )
                )
        candidates.sort(
            key=lambda candidate: (
                candidate.confidence,
                candidate.source.updated_at,
                candidate.text,
            ),
            reverse=True,
        )
        return candidates[:limit]
