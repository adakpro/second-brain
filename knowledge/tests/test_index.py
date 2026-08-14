from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from app.config import Settings
from app.documents import MarkdownRepository
from app.index import KnowledgeIndex
from app.models import NodeKind


def test_reindex_is_serialized_and_snapshot_replacement_is_atomic(settings) -> None:
    settings.prepare_directories()
    repository = MarkdownRepository(settings)
    for number in range(4):
        repository.create(
            title=f"Note {number}",
            content=f"A deterministic note about topic {number}",
            tags=["test"],
            kind=NodeKind.note,
            links=[],
            permanent=False,
            metadata={},
        )
    index = KnowledgeIndex(settings, repository=repository)
    with ThreadPoolExecutor(max_workers=4) as pool:
        reports = list(pool.map(lambda _: index.reindex(), range(4)))
    assert sorted(report.generation for report in reports) == [1, 2, 3, 4]
    assert index.snapshot.generation == 4
    assert len(index.snapshot.documents) == 4
    assert (settings.state_dir / "index-manifest.json").exists()


def test_inflight_reindex_cannot_resurrect_a_tombstoned_node(
    settings, monkeypatch
) -> None:
    settings.prepare_directories()
    repository = MarkdownRepository(settings)
    created = repository.create(
        title="In-flight tombstone",
        content="Must stay hidden",
        tags=[],
        kind=NodeKind.note,
        links=[],
        permanent=False,
        metadata={},
    )
    index = KnowledgeIndex(settings, repository=repository)
    index.reindex()
    real_encode = index._encode
    started = threading.Event()
    release = threading.Event()

    def blocked_encode(texts):
        started.set()
        assert release.wait(2)
        return real_encode(texts)

    monkeypatch.setattr(index, "_encode", blocked_encode)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(index.reindex)
        assert started.wait(2)
        index.hide_node(created.id)
        release.set()
        pending.result(timeout=3)
    assert created.id not in index.snapshot.by_id


def test_reindex_makes_an_operator_restored_trashed_node_visible(settings) -> None:
    settings.prepare_directories()
    repository = MarkdownRepository(settings)
    created = repository.create(
        title="Restore from trash",
        content="Recoverable content",
        tags=[],
        kind=NodeKind.note,
        links=[],
        permanent=False,
        metadata={},
    )
    index = KnowledgeIndex(settings, repository=repository)
    index.reindex()
    document = repository.get(created.id)
    receipt = repository.trash(
        document,
        expected_revision=created.revision,
    )
    index.hide_node(created.id)
    assert created.id not in index.snapshot.by_id

    trashed = settings.knowledge_root / receipt.trashed_path
    original = settings.knowledge_root / created.path
    os.rename(trashed, original)
    index.reindex()
    assert index.get(created.id).content == "Recoverable content"


def test_content_fingerprint_detects_same_size_edit_with_restored_mtime(
    settings,
) -> None:
    settings.prepare_directories()
    note = settings.knowledge_root / "inbox" / "external.md"
    note.write_text("alpha", encoding="utf-8")
    original_stat = note.stat()
    repository = MarkdownRepository(settings)
    before = repository.fingerprint()

    note.write_text("bravo", encoding="utf-8")
    os.utime(
        note,
        ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
    )

    assert note.stat().st_size == original_stat.st_size
    assert repository.fingerprint() != before


def test_shared_tag_graph_edges_are_deterministic_and_degree_bounded(settings) -> None:
    bounded = replace(settings, semantic_neighbors=2)
    bounded.prepare_directories()
    repository = MarkdownRepository(bounded)
    for number in range(12):
        repository.create(
            title=f"Tagged {number:02d}",
            content="A node in a deliberately popular tag cohort.",
            tags=["popular", f"group-{number % 3}"],
            kind=NodeKind.task if number % 2 else NodeKind.insight,
            links=[],
            permanent=False,
            metadata={},
        )
    index = KnowledgeIndex(bounded, repository=repository)
    index.reindex()

    first = index.graph(include_semantic=False, min_score=0, limit=100)
    second = index.graph(include_semantic=False, min_score=0, limit=100)
    tag_edges = [edge for edge in first.edges if edge.relation == "tag"]
    assert tag_edges
    assert first.edges == second.edges
    assert len(tag_edges) <= 12
    degree: dict[str, int] = {}
    for edge in tag_edges:
        degree[edge.source] = degree.get(edge.source, 0) + 1
        degree[edge.target] = degree.get(edge.target, 0) + 1
        assert edge.evidence[0].startswith("shared tag co-occurrence:")
    assert max(degree.values()) <= 2


def test_graph_limit_selects_representative_edges_and_kinds_beyond_prefix(
    settings,
) -> None:
    settings.prepare_directories()
    filler = settings.knowledge_root / "a-fillers"
    special = settings.knowledge_root / "z-special"
    filler.mkdir(parents=True)
    special.mkdir(parents=True)

    for number in range(12):
        (filler / f"{number:02d}.md").write_text(
            f"---\nid: filler-{number:02d}\nkind: note\n---\n\n# Filler {number:02d}\n",
            encoding="utf-8",
        )

    fixtures = {
        "explicit-note.md": (
            "explicit-note",
            "note",
            "links: [explicit-skill]",
        ),
        "explicit-skill.md": ("explicit-skill", "skill", ""),
        "tagged-insight.md": (
            "tagged-insight",
            "insight",
            "tags: [representative]",
        ),
        "tagged-task.md": (
            "tagged-task",
            "task",
            "tags: [representative]",
        ),
        "memory.md": ("representative-memory", "memory", ""),
    }
    for filename, (identifier, kind, extra) in fixtures.items():
        (special / filename).write_text(
            f"---\nid: {identifier}\nkind: {kind}\n{extra}\n---\n\n# {identifier}\n",
            encoding="utf-8",
        )

    index = KnowledgeIndex(settings, repository=MarkdownRepository(settings))
    index.reindex()
    prefix_ids = {document.id for document in index.snapshot.documents[:5]}
    expected_ids = {
        "explicit-note",
        "explicit-skill",
        "tagged-insight",
        "tagged-task",
        "representative-memory",
    }
    assert prefix_ids.isdisjoint(expected_ids)

    first = index.graph(include_semantic=False, min_score=0, limit=5)
    second = index.graph(include_semantic=False, min_score=0, limit=5)

    assert first == second
    assert len(first.nodes) == 5
    assert {node.id for node in first.nodes} == expected_ids
    assert {node.kind for node in first.nodes} == set(NodeKind)
    assert {edge.relation for edge in first.edges} == {"references", "tag"}
    positions = index.snapshot.positions
    assert [positions[node.id] for node in first.nodes] == sorted(
        positions[node.id] for node in first.nodes
    )
    assert len(index.graph(False, 0, limit=1).nodes) == 1
    assert len(index.graph(False, 0, limit=4).nodes) == 4


def test_graph_pair_seeds_reserve_kind_coverage(settings, monkeypatch) -> None:
    settings.prepare_directories()
    directory = settings.knowledge_root / "fixtures"
    directory.mkdir(parents=True)
    fixtures = {
        "01-note-a.md": ("note-a", "note", "links: [note-b]"),
        "02-note-b.md": ("note-b", "note", ""),
        "03-skill.md": ("only-skill", "skill", ""),
        "04-memory.md": ("only-memory", "memory", ""),
        "05-insight-a.md": ("insight-a", "insight", "tags: [cohort]"),
        "06-insight-b.md": ("insight-b", "insight", "tags: [cohort]"),
        "07-task.md": ("only-task", "task", ""),
    }
    for filename, (identifier, kind, extra) in fixtures.items():
        (directory / filename).write_text(
            f"---\nid: {identifier}\nkind: {kind}\n{extra}\n---\n\n# {identifier}\n",
            encoding="utf-8",
        )

    index = KnowledgeIndex(settings, repository=MarkdownRepository(settings))
    index.reindex()
    shared_tag_calls: list[int] = []
    shared_tag_edges = index._shared_tag_edges

    def track_shared_tag_scope(documents):
        shared_tag_calls.append(len(documents))
        return shared_tag_edges(documents)

    monkeypatch.setattr(index, "_shared_tag_edges", track_shared_tag_scope)

    kinds_first = index.graph(False, 0, limit=5)
    assert len(kinds_first.nodes) == 5
    assert {node.kind for node in kinds_first.nodes} == set(NodeKind)

    edges_fit = index.graph(False, 0, limit=7)
    assert len(edges_fit.nodes) == 7
    assert {node.kind for node in edges_fit.nodes} == set(NodeKind)
    assert {edge.relation for edge in edges_fit.edges} == {"references", "tag"}
    assert all(
        edge.source in {node.id for node in edges_fit.nodes}
        and edge.target in {node.id for node in edges_fit.nodes}
        for edge in edges_fit.edges
    )
    assert shared_tag_calls == [5, 7]


def test_implicit_ids_and_raw_revisions_are_deterministic(settings) -> None:
    settings.prepare_directories()
    note = settings.knowledge_root / "inbox" / "Café idea.md"
    note.write_text("# Café idea\n\nOne version.\n", encoding="utf-8")
    repository = MarkdownRepository(settings)

    first = repository.load()[0][0]
    second = repository.load()[0][0]
    assert first.id == second.id
    assert first.revision == second.revision

    note.write_text("# Café idea\n\nNext version.\n", encoding="utf-8")
    changed = repository.load()[0][0]
    assert changed.id == first.id
    assert changed.revision != first.revision


def test_root_and_named_hermes_homes_get_unique_scoped_nodes(tmp_path: Path) -> None:
    hermes = tmp_path / "hermes"
    codex = hermes / "profiles" / "codex"
    for home in (hermes, codex):
        skill = home / "skills" / "shared"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nid: shared-skill\nname: shared\n---\n\n# Shared skill\n",
            encoding="utf-8",
        )
        (home / "MEMORY.md").write_text(
            "---\nid: shared-memory\n---\n\n# Memory\n\nRemember this.\n"
        )
        (home / "USER.md").write_text("# User\n\nOperator profile.\n")
        (home / "SOUL.md").write_text("# Must never be indexed\n")
        (home / "config.md").write_text("# Also outside the allowlist\n")
        memories = home / "memories"
        memories.mkdir()
        (memories / "episodic.md").write_text("# Episodic\n")

    settings = Settings(
        knowledge_root=tmp_path / "vault",
        state_dir=tmp_path / "state",
        hermes_homes=(hermes, hermes / "profiles" / "*"),
        # Legacy overlap must be de-duplicated by resolved source path.
        skill_roots=(hermes / "skills",),
        memory_roots=(hermes / "memories",),
        embedding_backend="hash",
        auto_index=False,
    )
    settings.prepare_directories()
    documents, _ = MarkdownRepository(settings).load()

    assert len(documents) == 8
    assert len({document.id for document in documents}) == 8
    assert {document.kind for document in documents} == {
        NodeKind.skill,
        NodeKind.memory,
    }
    assert all(document.editable is False for document in documents)
    assert {document.source for document in documents} == {
        "hermes-skill",
        "hermes-memory",
    }
    paths = {document.display_path for document in documents}
    assert "hermes-skills/shared/SKILL.md" in paths
    assert "hermes-profile-codex-skills/shared/SKILL.md" in paths
    assert "hermes-memories/MEMORY.md" in paths
    assert "hermes-profile-codex-memories/MEMORY.md" in paths
    assert not any("SOUL.md" in path or "config.md" in path for path in paths)
