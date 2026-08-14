from __future__ import annotations

import asyncio
import io
import json
import os
import time
import zipfile
from pathlib import Path

import pytest
import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.documents import MarkdownRepository
from app.index import KnowledgeIndex
from app.extractor_api import app as extractor_app
from app.main import create_app
import app.importer as importer_module
from app.importer import ImportError, ImportService, Staged, _extract_remote


def _upload(client: TestClient, auth: dict[str, str], name: str, body: bytes, media: str):
    return client.post(
        "/imports",
        headers=auth,
        files=[("files", (name, body, media))],
        data={"tags": "personal,imported", "target": "inbox"},
    )


def test_import_capabilities_are_authenticated_and_exact(
    client: TestClient, auth: dict[str, str]
) -> None:
    assert client.get("/imports/capabilities").status_code == 401
    response = client.get("/imports/capabilities", headers=auth)
    assert response.status_code == 200
    value = response.json()
    assert value["max_files"] == 12
    assert value["max_file_bytes"] == 16 * 1024 * 1024
    assert value["max_total_bytes"] == 64 * 1024 * 1024
    assert value["malware_scan"] is False
    assert set(value["accepted_extensions"]) == {
        ".md", ".txt", ".csv", ".json", ".html", ".htm",
        ".pdf", ".docx", ".pptx", ".xlsx",
        ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp",
    }


def test_secretless_extractor_api_contract() -> None:
    with TestClient(extractor_app) as extractor:
        assert extractor.get("/health/live").json()["service"] == "hermess-extractor"
        response = extractor.post(
            "/extract",
            files={"file": ("mine.txt", b"private <img src=x>", "text/plain")},
            data={
                "extension": ".txt",
                "max_output_bytes": "100000",
                "timeout_seconds": "5",
            },
        )
    assert response.status_code == 200, response.text
    assert "private" in response.json()["content"]
    assert "<img" not in response.json()["content"]
    assert response.json()["extractor"].startswith("hermess-safe-extract/")


@pytest.mark.anyio
async def test_remote_extractor_uses_remaining_deadline_and_maps_busy_retryably(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "mine.txt"
    source.write_text("private", encoding="utf-8")
    staged = Staged(
        ordinal=0,
        filename="mine.txt",
        extension=".txt",
        declared_type="text/plain",
        media_type="text/plain",
        path=source,
        size=7,
        sha256="0" * 64,
    )
    seen: list[bytes] = []

    async def busy(request: httpx.Request) -> httpx.Response:
        seen.append(await request.aread())
        return httpx.Response(
            429,
            stream=httpx.ByteStream(b'{"detail":"busy"}'),
            headers={"Content-Type": "application/json"},
        )

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(busy)
    monkeypatch.setattr(
        importer_module.httpx,
        "AsyncClient",
        lambda **_kwargs: real_client(transport=transport),
    )
    settings = Settings(
        knowledge_root=tmp_path / "notes",
        state_dir=tmp_path / "state",
        extractor_url="http://extractor:8010",
        import_parser_timeout_seconds=30,
    )
    with pytest.raises(ImportError) as raised:
        await _extract_remote(staged, settings, 7.8)
    assert raised.value.status_code == 429
    assert b'\r\n\r\n7\r\n' in seen[0]


@pytest.mark.anyio
async def test_remote_extractor_has_an_absolute_stream_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "mine.txt"
    source.write_text("private", encoding="utf-8")
    staged = Staged(
        ordinal=0,
        filename="mine.txt",
        extension=".txt",
        declared_type="text/plain",
        media_type="text/plain",
        path=source,
        size=7,
        sha256="0" * 64,
    )

    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"content":"'
            await asyncio.sleep(1)
            yield b'late","extractor":"test"}'

    async def drip(request: httpx.Request) -> httpx.Response:
        await request.aread()
        return httpx.Response(200, stream=SlowStream())

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(drip)
    monkeypatch.setattr(
        importer_module.httpx,
        "AsyncClient",
        lambda **_kwargs: real_client(transport=transport),
    )
    settings = Settings(
        knowledge_root=tmp_path / "notes",
        state_dir=tmp_path / "state",
        extractor_url="http://extractor:8010",
    )
    started = time.monotonic()
    with pytest.raises(ImportError) as raised:
        await _extract_remote(staged, settings, 0.05)
    assert raised.value.status_code == 503
    assert time.monotonic() - started < 0.5


def test_cleanup_only_removes_exact_owned_staging(settings) -> None:
    settings.prepare_directories()
    repository = MarkdownRepository(settings)
    service = ImportService(settings, repository)
    imports = settings.knowledge_root / "inbox" / "imports"
    imports.mkdir(parents=True, exist_ok=True)
    owned = imports / (".pending-" + "a" * 64 + "-" + "b" * 32)
    user = imports / ".pending-ideas"
    owned.mkdir()
    user.mkdir()
    old = time.time() - 2 * 24 * 60 * 60
    os.utime(owned, (old, old))
    os.utime(user, (old, old))
    service.cleanup_stale()
    assert not owned.exists()
    assert user.exists()


@pytest.mark.parametrize(
    ("name", "media", "body", "needle"),
    [
        ("safe.md", "text/markdown", b"# Mine\n\n<img onerror=bad> ![track](https://x) ![ref][r]\n[r]: https://tracker\n<%* evil() %> `$= evil()`", "Mine"),
        ("safe.txt", "text/plain", b"private <script>alert(1)</script>\n```dataviewjs\nevil()\n```\n`$= evil()` <%* evil() %>", "private"),
        ("rows.csv", "text/csv", b"name,value\nalpha,<img onerror=x>\n", "alpha"),
        ("data.json", "application/json", json.dumps({"x": "``` <tag>"}).encode(), '"x"'),
        (
            "page.html",
            "text/html",
            b"<h1>Title</h1><script>bad()</script><p>Body ```dataviewjs `$= evil()` &lt;%* evil() %&gt;</p>",
            "Body",
        ),
    ],
)
def test_safe_text_imports_and_content_hash_idempotency(
    client: TestClient,
    auth: dict[str, str],
    settings,
    name: str,
    media: str,
    body: bytes,
    needle: str,
) -> None:
    first = _upload(client, auth, name, body, media)
    assert first.status_code == 201, first.text
    assert first.json()["index_state"] == "pending"
    result = first.json()["results"][0]
    assert result["status"] == "imported"
    assert result["node"]["source"] == "vault"
    assert "content" not in result["node"]
    note = settings.knowledge_root / result["node"]["path"]
    text = note.read_text(encoding="utf-8")
    assert needle in text
    assert "<script" not in text.casefold()
    assert "<img" not in text.casefold()
    assert "![track](" not in text
    assert "![ref][r]" not in text
    assert "[r]: https://" not in text
    assert "<%*" not in text
    assert "`$=" not in text
    assert "\n```dataviewjs" not in text
    original = settings.state_dir / "originals" / result["sha256"] / f"source{Path(name).suffix}"
    assert original.read_bytes() == body
    assert settings.knowledge_root not in original.parents

    duplicate = _upload(client, auth, "renamed" + Path(name).suffix, body, media)
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["index_state"] == "ready"
    assert duplicate.json()["results"][0]["status"] == "duplicate"
    assert duplicate.json()["results"][0]["node"]["id"] == result["node"]["id"]


def test_same_name_different_content_creates_distinct_notes(
    client: TestClient, auth: dict[str, str]
) -> None:
    first = _upload(client, auth, "same.txt", b"one", "text/plain").json()
    second = _upload(client, auth, "same.txt", b"two", "text/plain").json()
    assert first["results"][0]["node"]["id"] != second["results"][0]["node"]["id"]


def test_deleting_import_moves_unshared_private_original_to_state_trash(
    client: TestClient, auth: dict[str, str], settings
) -> None:
    imported = _upload(client, auth, "private.txt", b"private source", "text/plain")
    assert imported.status_code == 201, imported.text
    result = imported.json()["results"][0]
    original = (
        settings.state_dir
        / "originals"
        / result["sha256"]
        / "source.txt"
    )
    assert original.exists()

    deleted = client.request(
        "DELETE",
        f"/nodes/{result['node']['id']}",
        headers=auth,
        json={"expected_revision": result["node"]["revision"]},
    )
    assert deleted.status_code == 200, deleted.text
    receipt = deleted.json()
    assert receipt["original_trashed"] is True
    trash_id = Path(receipt["trashed_path"]).parts[2]
    private_trash = (
        settings.state_dir
        / "trash"
        / "hermess"
        / trash_id
        / "originals"
        / result["sha256"]
        / "source.txt"
    )
    assert not original.exists()
    assert private_trash.read_bytes() == b"private source"
    assert private_trash.stat().st_mode & 0o777 == 0o600


def test_deleting_import_retains_original_referenced_by_active_note(
    client: TestClient, auth: dict[str, str], settings
) -> None:
    imported = _upload(client, auth, "shared.txt", b"shared source", "text/plain")
    assert imported.status_code == 201, imported.text
    result = imported.json()["results"][0]
    shared = client.post(
        "/notes",
        headers=auth,
        json={
            "title": "Active shared source",
            "content": "Keep the original active.",
            "metadata": {"import_sha256": result["sha256"]},
        },
    )
    assert shared.status_code == 201, shared.text

    deleted = client.request(
        "DELETE",
        f"/nodes/{result['node']['id']}",
        headers=auth,
        json={"expected_revision": result["node"]["revision"]},
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["original_trashed"] is False
    original = (
        settings.state_dir
        / "originals"
        / result["sha256"]
        / "source.txt"
    )
    assert original.read_bytes() == b"shared source"


@pytest.mark.parametrize(
    ("name", "body", "media", "status"),
    [
        ("../escape.txt", b"x", "text/plain", 422),
        ("binary.txt", b"a\x00b", "text/plain", 415),
        ("wrong.pdf", b"not pdf", "application/pdf", 415),
        ("empty.txt", b"", "text/plain", 422),
        ("archive.zip", b"PK\x03\x04", "application/zip", 415),
        ("wrong.txt", b"x", "application/pdf", 415),
    ],
)
def test_invalid_import_leaves_no_visible_note(
    client: TestClient,
    auth: dict[str, str],
    settings,
    name: str,
    body: bytes,
    media: str,
    status: int,
) -> None:
    response = _upload(client, auth, name, body, media)
    assert response.status_code == status, response.text
    assert not list((settings.knowledge_root / "inbox" / "imports").glob("batch-*/*.md"))


def _hostile_ooxml(required: str, *, extra_name: str | None = None, extra: bytes = b"") -> bytes:
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr(required, "<document/>")
        if extra_name:
            archive.writestr(extra_name, extra)
    return data.getvalue()


@pytest.mark.parametrize(
    ("extra_name", "extra"),
    [
        ("word/vbaProject.bin", b"macro"),
        ("word/activeX/control.xml", b"active"),
        ("word/_rels/document.xml.rels", b'<Relationship TargetMode="External"/>'),
        ("word/custom.xml", b"<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///etc/passwd'>]><x>&y;</x>"),
    ],
)
def test_ooxml_active_content_is_rejected(
    client: TestClient, auth: dict[str, str], extra_name: str, extra: bytes
) -> None:
    body = _hostile_ooxml("word/document.xml", extra_name=extra_name, extra=extra)
    response = _upload(
        client,
        auth,
        "unsafe.docx",
        body,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    assert response.status_code in {415, 422}, response.text


def test_atomic_batch_validation_failure_commits_nothing(
    client: TestClient, auth: dict[str, str], settings
) -> None:
    response = client.post(
        "/imports",
        headers=auth,
        files=[
            ("files", ("valid.txt", b"valid", "text/plain")),
            ("files", ("bad.pdf", b"invalid", "application/pdf")),
        ],
    )
    assert response.status_code == 415
    assert not list((settings.knowledge_root / "inbox" / "imports").glob("batch-*/*.md"))


def test_generated_docx_pptx_and_xlsx_extract(
    client: TestClient, auth: dict[str, str]
) -> None:
    docx = pytest.importorskip("docx")
    pptx = pytest.importorskip("pptx")
    openpyxl = pytest.importorskip("openpyxl")

    document = docx.Document()
    document.add_paragraph("Before")
    table = document.add_table(rows=1, cols=1)
    table.cell(0, 0).text = "Middle <img onerror=x>"
    document.add_paragraph("After")
    docx_io = io.BytesIO()
    document.save(docx_io)

    presentation = pptx.Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    box = slide.shapes.add_textbox(0, 0, 100, 100)
    box.text = "Slide <script>bad</script>"
    pptx_io = io.BytesIO()
    presentation.save(pptx_io)

    workbook = openpyxl.Workbook()
    workbook.active["A1"] = "Cell <img onerror=x>"
    xlsx_io = io.BytesIO()
    workbook.save(xlsx_io)

    cases = [
        ("ordered.docx", docx_io.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("slides.pptx", pptx_io.getvalue(), "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        ("sheet.xlsx", xlsx_io.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ]
    for name, body, media in cases:
        response = _upload(client, auth, name, body, media)
        assert response.status_code == 201, response.text
        detail = client.get(
            f"/nodes/{response.json()['results'][0]['node']['id']}", headers=auth
        ).json()
        assert "<img" not in detail["content"].casefold()
        assert "<script" not in detail["content"].casefold()
        if name == "ordered.docx":
            assert detail["content"].index("Before") < detail["content"].index("Middle") < detail["content"].index("After")


def _ocr_image(text: str, *, persian: bool = False):
    pillow = pytest.importorskip("PIL.Image")
    from PIL import ImageDraw, ImageFont

    image = pillow.new("RGBA", (1_800, 600), (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 100
    )
    options = (
        {"direction": "rtl", "language": "fa", "anchor": "ra"}
        if persian
        else {}
    )
    position = (1_700, 100) if persian else (60, 100)
    draw.text(position, text, font=font, fill=(0, 0, 0, 255), **options)
    return image


def test_real_english_persian_image_and_scanned_pdf_ocr(
    client: TestClient, auth: dict[str, str]
) -> None:
    english = _ocr_image("DIGITAL BRAIN 2026")
    persian = _ocr_image("سلام دنیا دانش شخصی هوش مصنوعی", persian=True)

    english_io = io.BytesIO()
    english.save(english_io, "PNG")
    persian_io = io.BytesIO()
    persian.save(persian_io, "PNG")
    scanned_pdf = io.BytesIO()
    english.convert("RGB").save(scanned_pdf, "PDF", resolution=150)

    english_response = _upload(
        client, auth, "english.png", english_io.getvalue(), "image/png"
    )
    assert english_response.status_code == 201, english_response.text
    english_detail = client.get(
        f"/nodes/{english_response.json()['results'][0]['node']['id']}", headers=auth
    ).json()
    assert "DIGITAL BRAIN" in english_detail["content"]
    assert english_detail["metadata"]["import_parser_version"] == (
        "hermess-safe-extract/1.1.0"
    )

    persian_response = _upload(
        client, auth, "persian.png", persian_io.getvalue(), "image/png"
    )
    assert persian_response.status_code == 201, persian_response.text
    persian_detail = client.get(
        f"/nodes/{persian_response.json()['results'][0]['node']['id']}", headers=auth
    ).json()
    assert any("\u0600" <= character <= "\u06ff" for character in persian_detail["content"])

    pdf_response = _upload(
        client, auth, "scanned.pdf", scanned_pdf.getvalue(), "application/pdf"
    )
    assert pdf_response.status_code == 201, pdf_response.text
    pdf_detail = client.get(
        f"/nodes/{pdf_response.json()['results'][0]['node']['id']}", headers=auth
    ).json()
    assert "DIGITAL BRAIN" in pdf_detail["content"]


def test_pdf_pixel_preflight_and_image_frame_cap(
    client: TestClient, auth: dict[str, str]
) -> None:
    pypdf = pytest.importorskip("pypdf")
    pillow = pytest.importorskip("PIL.Image")

    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=100_000, height=100_000)
    huge_pdf = io.BytesIO()
    writer.write(huge_pdf)
    response = _upload(
        client, auth, "huge.pdf", huge_pdf.getvalue(), "application/pdf"
    )
    assert response.status_code == 422

    frames = [pillow.new("1", (8, 8), color=index % 2) for index in range(9)]
    tiff = io.BytesIO()
    frames[0].save(tiff, "TIFF", save_all=True, append_images=frames[1:])
    response = _upload(client, auth, "many.tiff", tiff.getvalue(), "image/tiff")
    assert response.status_code == 422


def test_graph_defaults_to_personal_vault_data_only(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    skill_root = tmp_path / "hermes" / "skills"
    vault.mkdir()
    skill_root.mkdir(parents=True)
    (vault / "seed.md").write_text(
        "---\nid: welcome-to-hermes-knowledge\nsystem_managed: true\n---\n# Seed\n",
        encoding="utf-8",
    )
    (vault / "mine.md").write_text(
        "---\nid: mine\ntags: [private]\n---\n# My knowledge\n[[Other]]\n",
        encoding="utf-8",
    )
    (vault / "other.md").write_text(
        "---\nid: other\ntags: [private]\n---\n# Other\n",
        encoding="utf-8",
    )
    (skill_root / "system.md").write_text(
        "---\nid: system-skill\n---\n# System Skill\n",
        encoding="utf-8",
    )
    settings = Settings(
        knowledge_root=vault,
        state_dir=tmp_path / "state",
        skill_roots=(skill_root,),
        api_key="key",
        embedding_backend="hash",
        auto_index=False,
        semantic_threshold=0,
    )
    index = KnowledgeIndex(settings, repository=MarkdownRepository(settings))
    index.reindex()
    personal = index.graph(False, 0, 100)
    assert {node.id for node in personal.nodes} == {"mine", "other"}
    assert all(edge.source in {"mine", "other"} and edge.target in {"mine", "other"} for edge in personal.edges)
    system = index.graph(False, 0, 100, include_system=True)
    assert {"welcome-to-hermes-knowledge", "mine", "other"}.issubset(
        {node.id for node in system.nodes}
    )
    assert any(node.source == "hermes-skill" for node in system.nodes)
    with pytest.raises(KeyError):
        index.activate(["welcome-to-hermes-knowledge"], 1, 0.5, 10, False)
    assert index.activate(["welcome-to-hermes-knowledge"], 1, 0.5, 10, False, True).nodes
    with TestClient(create_app(settings)) as scoped_client:
        public = scoped_client.get(
            "/graph?semantic=false&include_system=true",
            headers={"X-API-Key": "key"},
        )
    assert public.status_code == 200
    assert {node["id"] for node in public.json()["nodes"]} == {"mine", "other"}
