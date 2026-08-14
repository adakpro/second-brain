from __future__ import annotations

import hashlib
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
import pytest

import app.documents as documents_module
from app.config import Settings
from app.documents import MarkdownRepository
from app.main import create_app


def test_health_and_fail_closed_auth(client: TestClient, auth: dict[str, str]) -> None:
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["ready"] is True
    assert health.json()["embedding_backend"] == "hash"

    assert client.get("/stats").status_code == 401
    assert (
        client.get(
            "/stats", headers={"Authorization": "Bearer test-secret-key"}
        ).status_code
        == 200
    )
    assert client.get("/stats", headers=auth).json()["total_nodes"] == 0


def test_vault_metadata_is_safe_and_does_not_expose_server_path(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    assert client.get("/vault").status_code == 401

    response = client.get("/vault", headers=auth)
    assert response.status_code == 200
    vault = response.json()
    assert vault["name"] == settings.vault_name
    assert vault["format"] == "obsidian-markdown"
    assert vault["mutation_mode"] == "api-only"
    assert str(settings.knowledge_root) not in response.text
    parsed = urlparse(vault["obsidian_uri"])
    assert parsed.scheme == "obsidian"
    assert parsed.netloc == "open"
    assert parse_qs(parsed.query) == {"vault": [settings.vault_name]}


def test_vault_name_rejects_paths_and_encodes_unicode(tmp_path: Path) -> None:
    unsafe = Settings(
        knowledge_root=tmp_path / "unsafe-notes",
        state_dir=tmp_path / "unsafe-state",
        vault_name="../server/secret",
        api_key="key",
        embedding_backend="hash",
        auto_index=False,
    )
    assert unsafe.vault_name == "HERMESS"

    unicode_name = Settings(
        knowledge_root=tmp_path / "unicode-notes",
        state_dir=tmp_path / "unicode-state",
        vault_name="دانش من",
        api_key="key",
        embedding_backend="hash",
        auto_index=False,
    )
    with TestClient(create_app(unicode_name)) as scoped_client:
        value = scoped_client.get("/vault", headers={"X-API-Key": "key"}).json()
    assert "+" not in value["obsidian_uri"]
    assert "%20" in value["obsidian_uri"]
    assert parse_qs(urlparse(value["obsidian_uri"]).query) == {
        "vault": ["دانش من"]
    }


def test_missing_key_is_degraded_and_protected_routes_are_closed(
    tmp_path: Path,
) -> None:
    settings = Settings(
        knowledge_root=tmp_path / "notes",
        state_dir=tmp_path / "state",
        embedding_backend="hash",
        auto_index=False,
    )
    with TestClient(create_app(settings)) as client:
        health = client.get("/health")
        assert health.status_code == 503
        assert health.json()["status"] == "degraded"
        assert client.get("/nodes").status_code == 503


def test_browser_mutations_require_an_allowed_origin(
    client: TestClient, auth: dict[str, str]
) -> None:
    blocked = client.post(
        "/index",
        headers={**auth, "Origin": "https://attacker.example"},
    )
    assert blocked.status_code == 403

    allowed = client.post(
        "/index",
        headers={**auth, "Origin": "http://localhost:3000"},
    )
    assert allowed.status_code == 200


def test_note_lifecycle_persists_markdown(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "A Fleeting Insight",
            "content": "Local retrieval keeps private notes private.",
            "tags": ["privacy", "local"],
        },
    )
    assert created.status_code == 201, created.text
    node_id = created.json()["id"]
    created_revision = created.json()["revision"]
    inbox_file = settings.knowledge_root / "inbox" / "a-fleeting-insight.md"
    assert inbox_file.exists()
    assert f"id: {node_id}" in inbox_file.read_text()
    assert created.json()["editable"] is True
    assert created.json()["source"] == "vault"
    parsed_uri = urlparse(created.json()["obsidian_uri"])
    assert parsed_uri.scheme == "obsidian"
    assert "%2F" in created.json()["obsidian_uri"]
    assert parse_qs(parsed_uri.query) == {
        "vault": [settings.vault_name],
        "file": ["inbox/a-fleeting-insight.md"],
    }

    updated = client.patch(
        f"/notes/{node_id}",
        headers=auth,
        json={
            "content": "Local semantic retrieval keeps private notes on this machine.",
            "expected_revision": created_revision,
        },
    )
    assert updated.status_code == 200
    assert "semantic retrieval" in updated.json()["content"]

    promoted = client.post(
        f"/notes/{node_id}/promote",
        headers=auth,
        json={
            "expected_revision": updated.json()["revision"],
            "summary": "Prefer local-first retrieval.",
            "tags": ["privacy", "principle"],
        },
    )
    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["permanent"] is True
    assert promoted.json()["path"].startswith("permanent/")
    assert not inbox_file.exists()
    permanent_file = settings.knowledge_root / promoted.json()["path"]
    assert permanent_file.exists()
    assert "Permanent insight" in permanent_file.read_text()

    listed = client.get("/notes?permanent=true", headers=auth).json()
    assert [note["id"] for note in listed] == [node_id]


def test_stale_note_update_returns_conflict(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Concurrent note", "content": "Browser version"},
    )
    assert created.status_code == 201
    note = created.json()
    note_path = settings.knowledge_root / note["path"]
    external = note_path.read_text() + "\nExternal Obsidian edit.\n"
    note_path.write_text(external)

    response = client.put(
        f"/notes/{note['id']}",
        headers=auth,
        json={"content": "Stale browser edit", "expected_revision": note["revision"]},
    )
    assert response.status_code == 409
    assert note_path.read_text() == external


def test_external_edit_during_api_save_wins_without_overwrite(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Racing note", "content": "Initial"},
    ).json()
    note_path = settings.knowledge_root / created["path"]
    external = note_path.read_text() + "\nExternal edit during save.\n"
    rename_exchange = documents_module._rename_exchange
    exchanges = 0

    def edit_at_commit(source: Path, destination: Path) -> None:
        nonlocal exchanges
        if destination == note_path and exchanges == 0:
            # This is the old check-to-replace gap: the external save lands at
            # the last possible point before the atomic exchange.
            note_path.write_text(external)
        exchanges += 1
        rename_exchange(source, destination)

    monkeypatch.setattr(documents_module, "_rename_exchange", edit_at_commit)
    response = client.patch(
        f"/notes/{created['id']}",
        headers=auth,
        json={
            "content": "API edit that must not win",
            "expected_revision": created["revision"],
        },
    )

    assert response.status_code == 409
    assert note_path.read_text() == external
    assert exchanges == 2


def test_second_external_writer_is_restored_and_recovery_versions_are_retained(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Double race", "content": "Initial"},
    ).json()
    note_path = settings.knowledge_root / created["path"]
    first_external = (note_path.read_text() + "\nFirst external save.\n").encode()
    later_external = b"---\nid: external-later\ntitle: Later\n---\n\nSecond external save.\n"
    rename_exchange = documents_module._rename_exchange
    exchanges = 0

    def race_during_rollback(source: Path, destination: Path) -> None:
        nonlocal exchanges
        if destination == note_path and exchanges == 0:
            note_path.write_bytes(first_external)
        rename_exchange(source, destination)
        if destination == note_path and exchanges == 0:
            # Model an in-place editor write after the candidate appeared but
            # before its stale displaced version could be rolled back.
            note_path.write_bytes(later_external)
        exchanges += 1

    monkeypatch.setattr(
        documents_module, "_rename_exchange", race_during_rollback
    )
    response = client.patch(
        f"/notes/{created['id']}",
        headers=auth,
        json={
            "content": "API edit that must not erase either external save",
            "expected_revision": created["revision"],
        },
    )

    assert response.status_code == 409
    assert note_path.read_bytes() == later_external
    recovery = settings.state_dir / "write-conflicts"
    retained = {path.read_bytes() for path in recovery.glob("*.md")}
    assert {first_external, later_external} <= retained
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in recovery.glob("*.md"))
    assert not list(note_path.parent.glob(f".{note_path.name}.*.tmp"))


def test_conditional_updates_fail_closed_without_atomic_exchange(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Portable fallback", "content": "Keep this version."},
    ).json()
    note_path = settings.knowledge_root / created["path"]
    original = note_path.read_bytes()

    def unavailable(source: Path, destination: Path) -> None:
        raise documents_module.ConditionalWriteUnavailableError(
            "safe conditional writes are unavailable on this filesystem"
        )

    monkeypatch.setattr(documents_module, "_rename_exchange", unavailable)
    response = client.patch(
        f"/notes/{created['id']}",
        headers=auth,
        json={
            "content": "Must not use check-then-replace",
            "expected_revision": created["revision"],
        },
    )

    assert response.status_code == 503
    assert note_path.read_bytes() == original
    assert not list(note_path.parent.glob(f".{note_path.name}.*.tmp"))


def test_create_never_clobbers_an_obsidian_filename(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    occupied = settings.knowledge_root / "inbox" / "same-title.md"
    occupied.write_text("# External Obsidian note\n", encoding="utf-8")

    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Same title", "content": "Created through the API."},
    )

    assert created.status_code == 201, created.text
    assert created.json()["path"] == "inbox/same-title-2.md"
    assert occupied.read_text() == "# External Obsidian note\n"


def test_insight_and_task_kinds_round_trip_and_join_the_tag_graph(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    insight = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "Retrieval insight",
            "kind": "insight",
            "content": "Local retrieval should retain provenance.",
            "tags": ["retrieval", "local-first"],
        },
    )
    task = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "Verify retrieval",
            "kind": "task",
            "content": "Test the local retrieval evidence.",
            "tags": ["retrieval", "verification"],
        },
    )
    assert insight.status_code == task.status_code == 201
    insight_node = insight.json()
    task_node = task.json()
    assert insight_node["kind"] == "insight"
    assert task_node["kind"] == "task"
    assert insight_node["path"].startswith("insights/")
    assert task_node["path"].startswith("tasks/")
    assert (settings.knowledge_root / insight_node["path"]).exists()
    assert (settings.knowledge_root / task_node["path"]).exists()

    updated = client.patch(
        f"/notes/{task_node['id']}",
        headers=auth,
        json={
            "content": "Verified with a deterministic fixture.",
            "expected_revision": task_node["revision"],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["kind"] == "task"
    assert [
        node["id"]
        for node in client.get("/nodes?kind=insight", headers=auth).json()
    ] == [insight_node["id"]]
    assert [
        node["id"] for node in client.get("/nodes?kind=task", headers=auth).json()
    ] == [task_node["id"]]

    graph = client.get("/graph?semantic=false", headers=auth).json()
    tag_edges = [edge for edge in graph["edges"] if edge["relation"] == "tag"]
    assert len(tag_edges) == 1
    assert {tag_edges[0]["source"], tag_edges[0]["target"]} == {
        insight_node["id"],
        task_node["id"],
    }
    assert tag_edges[0]["evidence"] == ["shared tag co-occurrence: retrieval"]
    stats = client.get("/stats", headers=auth).json()
    assert stats["nodes_by_kind"]["insight"] == 1
    assert stats["nodes_by_kind"]["task"] == 1


def test_idempotent_create_replays_one_durable_note_and_rejects_key_reuse(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    key = "daily-synthesis:2026-08-11"
    payload = {
        "title": "Daily synthesis — 2026-08-11",
        "content": "A retry-safe synthesis with [[Welcome to Hermes Knowledge]].",
        "tags": ["synthesis", "incubation"],
        "idempotency_key": key,
    }
    first = client.post("/notes", headers=auth, json=payload)
    replay = client.post("/notes", headers=auth, json=payload)

    assert first.status_code == replay.status_code == 201
    assert first.json()["id"] == replay.json()["id"]
    assert first.json()["path"] == replay.json()["path"]
    assert len(list((settings.knowledge_root / "inbox").glob("*.md"))) == 1
    raw = (settings.knowledge_root / first.json()["path"]).read_text()
    assert key not in raw
    assert hashlib.sha256(key.encode()).hexdigest() in raw

    conflict = client.post(
        "/notes",
        headers=auth,
        json={**payload, "content": "Different content under the same key."},
    )
    assert conflict.status_code == 409
    assert "different note payload" in conflict.json()["detail"]


def test_obsidian_ignores_and_folder_qualified_links(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    root = settings.knowledge_root
    ignored = [root / ".obsidian", root / ".trash", root / ".git", root / ".stfolder"]
    for directory in ignored:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "should-not-index.md").write_text("# Internal metadata")
    (root / "draft.tmp.md").write_text("# Incomplete atomic save")

    alpha = root / "areas" / "alpha"
    beta = root / "areas" / "beta"
    alpha.mkdir(parents=True)
    beta.mkdir(parents=True)
    (alpha / "Shared Note.md").write_text(
        "---\nid: alpha-shared\ntitle: Shared Note\n---\n\n# Alpha\n",
        encoding="utf-8",
    )
    (beta / "Shared Note.md").write_text(
        "---\nid: beta-shared\ntitle: Shared Note\n---\n\n# Beta\n",
        encoding="utf-8",
    )
    (root / "source.md").write_text(
        "---\nid: source-note\ntitle: Source\n---\n\n"
        "Embed: ![[areas/beta/Shared Note#Beta|chosen]].\n"
        "Markdown: [alpha](areas/alpha/Shared%20Note.md).\n",
        encoding="utf-8",
    )

    rebuilt = client.post("/index", headers=auth)
    assert rebuilt.status_code == 200, rebuilt.text
    listed = client.get("/nodes?limit=100", headers=auth).json()
    assert {node["id"] for node in listed} == {
        "alpha-shared",
        "beta-shared",
        "source-note",
    }
    source = client.get("/nodes/source-note", headers=auth).json()
    assert set(source["outgoing_links"]) == {"alpha-shared", "beta-shared"}


def test_invalid_obsidian_frontmatter_is_indexed_but_write_blocked(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    note = settings.knowledge_root / "broken.md"
    raw = "---\ntags: [unterminated\n---\n\n# Recover me\n"
    note.write_text(raw, encoding="utf-8")
    rebuilt = client.post("/index", headers=auth)
    assert rebuilt.status_code == 200

    listed = client.get("/nodes", headers=auth).json()
    assert len(listed) == 1
    broken = listed[0]
    assert broken["source"] == "vault"
    assert broken["editable"] is False
    assert broken["obsidian_uri"] is None

    response = client.patch(
        f"/notes/{broken['id']}",
        headers=auth,
        json={
            "content": "Would erase malformed properties",
            "expected_revision": broken["revision"],
        },
    )
    assert response.status_code == 403
    assert "invalid YAML frontmatter" in response.json()["detail"]
    deleted = client.request(
        "DELETE",
        f"/nodes/{broken['id']}",
        headers=auth,
        json={"expected_revision": broken["revision"]},
    )
    assert deleted.status_code == 403
    assert note.read_text() == raw


def test_committed_note_is_acknowledged_when_reindex_fails(
    client: TestClient, auth: dict[str, str], settings: Settings, monkeypatch
) -> None:
    def fail_reindex():
        raise RuntimeError("simulated embedding outage")

    monkeypatch.setattr(client.app.state.index, "reindex", fail_reindex)
    response = client.post(
        "/notes",
        headers=auth,
        json={"title": "Durable before index", "content": "The Markdown commit wins."},
    )

    assert response.status_code == 201, response.text
    assert response.json()["index_state"] == "pending"
    assert response.json()["revision"]
    assert (settings.knowledge_root / response.json()["path"]).exists()

    updated = client.patch(
        f"/notes/{response.json()['id']}",
        headers=auth,
        json={
            "content": "The committed update remains authoritative.",
            "expected_revision": response.json()["revision"],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["index_state"] == "pending"

    promoted = client.post(
        f"/notes/{response.json()['id']}/promote",
        headers=auth,
        json={"expected_revision": updated.json()["revision"]},
    )
    assert promoted.status_code == 200, promoted.text
    assert "committed update remains authoritative" in promoted.json()["content"]


def test_create_does_not_wait_behind_an_inflight_reindex(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
) -> None:
    index = client.app.state.index
    assert index._reindex_lock.acquire(timeout=1)  # noqa: SLF001 - simulate a live scan
    try:
        started = time.monotonic()
        response = client.post(
            "/notes",
            headers=auth,
            json={
                "title": "Commit During Reindex",
                "content": "The vault write must not wait for embeddings.",
            },
        )
        elapsed = time.monotonic() - started

        assert response.status_code == 201, response.text
        assert response.json()["index_state"] == "pending"
        assert elapsed < 0.5
        assert (settings.knowledge_root / response.json()["path"]).exists()

        # Pending reads come from durable Markdown rather than the stale
        # snapshot, so the new node is visible before the lock is released.
        node_id = response.json()["id"]
        assert client.get(f"/nodes/{node_id}", headers=auth).status_code == 200
        assert node_id in {
            note["id"] for note in client.get("/notes", headers=auth).json()
        }
    finally:
        index._reindex_lock.release()  # noqa: SLF001


def test_mutations_fail_fast_while_an_import_owns_the_commit_lock(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
) -> None:
    existing = client.post(
        "/notes",
        headers=auth,
        json={"title": "Keep During Import", "content": "Do not trash late."},
    ).json()
    existing_path = settings.knowledge_root / existing["path"]
    before_notes = set(settings.knowledge_root.rglob("*.md"))
    mutation_lock = client.app.state.mutation_lock
    client.portal.call(mutation_lock.acquire)
    try:
        started = time.monotonic()
        created = client.post(
            "/notes",
            headers=auth,
            json={"title": "Never Commit Late", "content": "Admission failed."},
        )
        deleted = client.request(
            "DELETE",
            f"/nodes/{existing['id']}",
            headers=auth,
            json={"expected_revision": existing["revision"]},
        )
        assert time.monotonic() - started < 0.5
    finally:
        client.portal.call(mutation_lock.release)

    assert created.status_code == deleted.status_code == 429
    assert created.headers["retry-after"] == deleted.headers["retry-after"] == "2"
    assert existing_path.exists()
    time.sleep(0.05)
    assert set(settings.knowledge_root.rglob("*.md")) == before_notes


def test_ingest_search_graph_connections_and_activation(
    client: TestClient, auth: dict[str, str]
) -> None:
    skill = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "Research Assistant",
            "kind": "skill",
            "content": "Find evidence and synthesize research about local knowledge retrieval.",
            "tags": ["research", "knowledge"],
        },
    )
    assert skill.json()["index_state"] == "pending"
    skill = skill.json()
    note = client.post(
        "/ingest",
        headers=auth,
        json={
            "title": "Local Search Architecture",
            "content": "Semantic retrieval uses local embeddings and a vector index.",
            "tags": ["knowledge", "architecture"],
            "links": ["Research Assistant"],
            "source": "meeting-notes",
        },
    )
    assert note.json()["index_state"] == "pending"
    note = note.json()
    related = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "Private Vector Retrieval",
            "content": "A local vector index supports private semantic knowledge search.",
            "tags": ["knowledge", "privacy"],
        },
    )
    assert related.json()["index_state"] == "pending"
    related = related.json()

    # Semantic discovery is an indexed read. Mutations acknowledge the durable
    # Markdown commit first, so explicitly wait for the administrative rebuild
    # before asserting the complete semantic snapshot.
    rebuilt = client.post("/index", headers=auth)
    assert rebuilt.status_code == 200, rebuilt.text

    hits = client.get(
        "/search", headers=auth, params={"q": "local semantic retrieval"}
    ).json()
    assert hits
    assert note["id"] in {hit["node"]["id"] for hit in hits}

    skills = client.get("/skills", headers=auth).json()
    assert [item["id"] for item in skills] == [skill["id"]]

    graph = client.get("/graph", headers=auth, params={"semantic": "false"}).json()
    assert any(
        edge["source"] == note["id"]
        and edge["target"] == skill["id"]
        and edge["relation"] == "references"
        for edge in graph["edges"]
    )

    discoveries = client.post(
        "/connections/discover",
        headers=auth,
        json={"node_id": note["id"], "min_score": 0, "limit": 10},
    ).json()
    assert related["id"] in {item["target"]["id"] for item in discoveries}

    activated = client.post(
        "/activation",
        headers=auth,
        json={"seed_ids": [note["id"]], "semantic": False, "depth": 2},
    ).json()
    activation_by_id = {item["node"]["id"]: item for item in activated["nodes"]}
    assert activation_by_id[skill["id"]]["depth"] == 1

    insights = client.post(
        "/insights/extract",
        headers=auth,
        json={"node_ids": [note["id"]], "minimum_words": 4},
    ).json()
    assert insights
    assert insights[0]["source"]["id"] == note["id"]
    assert 0 <= insights[0]["confidence"] <= 1


def test_mounted_hermes_skill_is_first_class_but_read_only(tmp_path: Path) -> None:
    skill_root = tmp_path / "hermes" / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "incident-response.md").write_text(
        "---\ntitle: Incident Response\ntags: [operations]\n---\n\nTriage and contain incidents.\n"
    )
    settings = Settings(
        knowledge_root=tmp_path / "notes",
        state_dir=tmp_path / "state",
        skill_roots=(skill_root,),
        api_key="key",
        embedding_backend="hash",
        auto_index=False,
    )
    with TestClient(create_app(settings)) as client:
        headers = {"X-API-Key": "key"}
        skills = client.get("/skills", headers=headers).json()
        assert len(skills) == 1
        assert skills[0]["kind"] == "skill"
        assert skills[0]["editable"] is False
        assert skills[0]["deletable"] is False
        assert skills[0]["source"] == "hermes-skill"
        assert skills[0]["obsidian_uri"] is None
        response = client.patch(
            f"/notes/{skills[0]['id']}",
            headers=headers,
            json={"content": "overwrite", "expected_revision": skills[0]["revision"]},
        )
        assert response.status_code == 403
        deleted = client.request(
            "DELETE",
            f"/nodes/{skills[0]['id']}",
            headers=headers,
            json={"expected_revision": skills[0]["revision"]},
        )
        assert deleted.status_code == 403
        assert (skill_root / "incident-response.md").exists()


def test_delete_node_moves_exact_revision_to_recoverable_trash(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Recover Me", "content": "Never unlink knowledge."},
    ).json()
    assert created["deletable"] is True
    active = settings.knowledge_root / created["path"]
    raw = active.read_bytes()

    missing_revision = client.request(
        "DELETE", f"/nodes/{created['id']}", headers=auth, json={}
    )
    assert missing_revision.status_code == 422
    extra_field = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"], "purge": True},
    )
    assert extra_field.status_code == 422

    generation = client.get("/stats", headers=auth).json()["generation"]
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result == {
        "id": created["id"],
        "status": "trashed",
        "recovery": "available",
        "trashed_path": result["trashed_path"],
        "index_state": "pending",
        "original_trashed": False,
    }
    assert result["trashed_path"].startswith(".trash/hermess/")
    assert str(settings.knowledge_root) not in response.text
    trashed = settings.knowledge_root / result["trashed_path"]
    assert not active.exists()
    assert trashed.read_bytes() == raw
    assert client.get(f"/nodes/{created['id']}", headers=auth).status_code == 404
    assert client.get("/stats", headers=auth).json()["generation"] > generation


def test_delete_conflict_preserves_external_obsidian_edit(
    client: TestClient, auth: dict[str, str], settings: Settings
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Delete Conflict", "content": "Original"},
    ).json()
    active = settings.knowledge_root / created["path"]
    external = active.read_bytes() + b"\nExternal Obsidian edit.\n"
    active.write_bytes(external)

    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 409
    assert active.read_bytes() == external
    assert not list((settings.knowledge_root / ".trash").rglob("*.md"))


def test_delete_race_rolls_back_without_clobbering_obsidian(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Delete Race", "content": "Original"},
    ).json()
    active = settings.knowledge_root / created["path"]
    external = active.read_bytes() + b"\nExternal at rename.\n"
    rename_noreplace = documents_module._renameat2_at
    calls = 0

    def race(
        source_directory_fd: int,
        source_name: str,
        destination_directory_fd: int,
        destination_name: str,
        flags: int,
    ) -> None:
        nonlocal calls
        if calls == 0:
            active.write_bytes(external)
        calls += 1
        rename_noreplace(
            source_directory_fd,
            source_name,
            destination_directory_fd,
            destination_name,
            flags,
        )

    monkeypatch.setattr(documents_module, "_renameat2_at", race)
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 409, response.text
    assert active.read_bytes() == external
    assert not list((settings.knowledge_root / ".trash").rglob("*.md"))
    assert calls == 2


def test_delete_second_writer_and_recovery_are_both_retained(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Double Delete Race", "content": "Original"},
    ).json()
    active = settings.knowledge_root / created["path"]
    first_external = active.read_bytes() + b"\nFirst external save.\n"
    later_external = (
        b"---\nid: later-external\ntitle: Later\n---\n\nLater external save.\n"
    )
    rename_noreplace = documents_module._renameat2_at
    calls = 0

    def race(
        source_directory_fd: int,
        source_name: str,
        destination_directory_fd: int,
        destination_name: str,
        flags: int,
    ) -> None:
        nonlocal calls
        if calls == 0:
            active.write_bytes(first_external)
        elif calls == 1:
            active.write_bytes(later_external)
        calls += 1
        rename_noreplace(
            source_directory_fd,
            source_name,
            destination_directory_fd,
            destination_name,
            flags,
        )

    monkeypatch.setattr(documents_module, "_renameat2_at", race)
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 409
    assert active.read_bytes() == later_external
    recovery = list((settings.knowledge_root / ".trash").rglob("*.md"))
    assert len(recovery) == 1
    assert recovery[0].read_bytes() == first_external


def test_delete_detects_source_recreated_after_exact_move(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Recreated Delete", "content": "Exact revision"},
    ).json()
    active = settings.knowledge_root / created["path"]
    recreated = b"---\nid: recreated\ntitle: Recreated\n---\n\nNew Obsidian version.\n"
    rename_noreplace = documents_module._renameat2_at
    calls = 0

    def recreate_after_move(
        source_directory_fd: int,
        source_name: str,
        destination_directory_fd: int,
        destination_name: str,
        flags: int,
    ) -> None:
        nonlocal calls
        rename_noreplace(
            source_directory_fd,
            source_name,
            destination_directory_fd,
            destination_name,
            flags,
        )
        if calls == 0:
            active.write_bytes(recreated)
        calls += 1

    monkeypatch.setattr(documents_module, "_renameat2_at", recreate_after_move)
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 409
    assert active.read_bytes() == recreated
    recovery = list((settings.knowledge_root / ".trash").rglob("*.md"))
    assert len(recovery) == 1
    assert hashlib.sha256(recovery[0].read_bytes()).hexdigest() == created["revision"]


def test_delete_rejects_system_and_read_only_nodes(
    client: TestClient, auth: dict[str, str]
) -> None:
    system = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "Managed Seed",
            "content": "Bootstrap",
            "metadata": {"system_managed": True},
        },
    ).json()
    assert system["editable"] is True
    assert system["deletable"] is False
    response = client.request(
        "DELETE",
        f"/nodes/{system['id']}",
        headers=auth,
        json={"expected_revision": system["revision"]},
    )
    assert response.status_code == 403


def test_delete_committed_trash_is_acknowledged_when_reindex_fails(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Trash Before Index", "content": "Durable authority"},
    ).json()
    active = settings.knowledge_root / created["path"]

    def fail_reindex():
        raise RuntimeError("simulated embedding outage")

    monkeypatch.setattr(client.app.state.index, "reindex", fail_reindex)
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["index_state"] == "pending"
    assert not active.exists()
    assert (settings.knowledge_root / response.json()["trashed_path"]).exists()


def test_delete_returns_before_slow_reindex_and_tombstones_reads(
    client: TestClient,
    auth: dict[str, str],
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Fast Trash Receipt", "content": "Hide immediately"},
    ).json()
    real_reindex = client.app.state.index.reindex

    def slow_reindex():
        time.sleep(0.6)
        return real_reindex()

    monkeypatch.setattr(client.app.state.index, "reindex", slow_reindex)
    started = time.monotonic()
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    assert response.json()["index_state"] == "pending"
    assert elapsed < 0.5
    assert client.get(f"/nodes/{created['id']}", headers=auth).status_code == 404


def test_rapid_deletes_coalesce_background_reindex(
    client: TestClient,
    auth: dict[str, str],
    monkeypatch,
) -> None:
    created = [
        client.post(
            "/notes",
            headers=auth,
            json={"title": f"Burst Trash {number}", "content": "Delete quickly"},
        ).json()
        for number in range(3)
    ]
    real_reindex = client.app.state.index.reindex
    calls = 0

    def counted_slow_reindex():
        nonlocal calls
        calls += 1
        time.sleep(0.15)
        return real_reindex()

    monkeypatch.setattr(client.app.state.index, "reindex", counted_slow_reindex)
    for node in created:
        response = client.request(
            "DELETE",
            f"/nodes/{node['id']}",
            headers=auth,
            json={"expected_revision": node["revision"]},
        )
        assert response.status_code == 200, response.text
        assert response.json()["index_state"] == "pending"
        assert client.app.state.index.snapshot.by_id.get(node["id"]) is None
    time.sleep(0.45)
    assert calls <= 2


def test_delete_fails_closed_on_symlinked_source_parent(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    tmp_path: Path,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "No Follow", "content": "Original vault bytes"},
    ).json()
    repository = MarkdownRepository(settings)
    document = repository.get(created["id"])
    inbox = settings.knowledge_root / "inbox"
    displaced = settings.knowledge_root / "inbox-real"
    inbox.rename(displaced)
    outside = tmp_path / "outside"
    outside.mkdir()
    inbox.symlink_to(outside, target_is_directory=True)

    with pytest.raises(PermissionError):
        repository.trash(
            document,
            expected_revision=created["revision"],
        )
    assert (displaced / "no-follow.md").exists()
    assert not list(outside.iterdir())


def test_delete_rejects_an_unmodelable_recovery_path_before_move(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "Bounded Receipt", "content": "Keep it modelable"},
    ).json()
    repository = MarkdownRepository(settings)
    document = repository.get(created["id"])
    document.source_path = settings.knowledge_root / ("x" * 4_096) / "note.md"
    with pytest.raises(ValueError, match="maximum length"):
        repository.trash(document, expected_revision=created["revision"])

    document.source_path = settings.knowledge_root / "bad\\component" / "note.md"
    with pytest.raises(ValueError, match="maximum length"):
        repository.trash(document, expected_revision=created["revision"])


def test_delete_is_available_to_allowed_browser_origin(
    client: TestClient, auth: dict[str, str]
) -> None:
    preflight = client.options(
        "/nodes/example",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "DELETE",
            "Access-Control-Request-Headers": "content-type,x-api-key",
        },
    )
    assert preflight.status_code == 200
    assert "DELETE" in preflight.headers["access-control-allow-methods"]


def test_delete_fails_closed_without_atomic_noreplace(
    client: TestClient,
    auth: dict[str, str],
    settings: Settings,
    monkeypatch,
) -> None:
    created = client.post(
        "/notes",
        headers=auth,
        json={"title": "No Unsafe Delete", "content": "Keep this."},
    ).json()
    active = settings.knowledge_root / created["path"]
    raw = active.read_bytes()

    def unavailable(
        source_directory_fd: int,
        source_name: str,
        destination_directory_fd: int,
        destination_name: str,
        flags: int,
    ) -> None:
        raise documents_module.ConditionalWriteUnavailableError(
            "safe recoverable trash is unavailable on this filesystem"
        )

    monkeypatch.setattr(documents_module, "_renameat2_at", unavailable)
    response = client.request(
        "DELETE",
        f"/nodes/{created['id']}",
        headers=auth,
        json={"expected_revision": created["revision"]},
    )
    assert response.status_code == 503
    assert active.read_bytes() == raw
    assert not list((settings.knowledge_root / ".trash").rglob("*.md"))
