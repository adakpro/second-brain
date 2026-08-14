"""Resource-confined, network-disabled document-to-Markdown extraction worker."""

from __future__ import annotations

import csv
import html
import json
import math
import re
import resource
import socket
import subprocess
import sys
import tempfile
import warnings
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

PARSER_VERSION = "hermess-safe-extract/1.1.0"
MAX_PDF_PAGES = 200
MAX_TABLE_CELLS = 200_000
MAX_SHEETS = 100
MAX_IMAGE_PIXELS = 20_000_000
MAX_TOTAL_IMAGE_PIXELS = 64_000_000
MAX_OCR_PAGES_OR_FRAMES = 8
MIN_USEFUL_TEXT_ALNUM = 32
OCR_DPI = 300
TESSDATA_DIRECTORY = "/usr/share/tesseract-ocr/5/tessdata"


def _network_disabled(*_args: Any, **_kwargs: Any) -> Any:
    raise OSError("network access is disabled in the extraction worker")


class _NetworkDisabledSocket(socket.socket):
    def connect(self, *_args: Any, **_kwargs: Any) -> Any:
        raise OSError("network access is disabled in the extraction worker")

    def connect_ex(self, *_args: Any, **_kwargs: Any) -> int:
        raise OSError("network access is disabled in the extraction worker")


socket.socket = _NetworkDisabledSocket  # type: ignore[assignment]
socket.create_connection = _network_disabled  # type: ignore[assignment]


class Output:
    def __init__(self, limit: int):
        self.limit = limit
        self.size = 0
        self.parts: list[str] = []

    def add(self, value: Any = "") -> None:
        text = str(value).replace("\x00", "")
        size = len(text.encode("utf-8"))
        if self.size + size > self.limit:
            raise ValueError("extracted Markdown exceeds configured maximum")
        self.parts.append(text)
        self.size += size

    def value(self) -> str:
        return "".join(self.parts).strip()


def _cell(value: Any) -> str:
    if value is None:
        return ""
    return _safe_text(str(value)).replace("|", "\\|")


def _table(rows: Iterable[Iterable[Any]], output: Output) -> None:
    normalized: list[list[str]] = []
    cells = 0
    for raw in rows:
        row = [_cell(value) for value in raw]
        cells += len(row)
        if cells > MAX_TABLE_CELLS:
            raise ValueError("document exceeds maximum table cell count")
        if any(row):
            normalized.append(row)
    if not normalized:
        return
    width = min(max(len(row) for row in normalized), 200)
    normalized = [(row + [""] * width)[:width] for row in normalized]
    output.add("| " + " | ".join(normalized[0]) + " |\n")
    output.add("| " + " | ".join(["---"] * width) + " |\n")
    for row in normalized[1:]:
        output.add("| " + " | ".join(row) + " |\n")
    output.add("\n")


class SafeHTML(HTMLParser):
    BLOCKED = {"script", "style", "noscript", "svg", "canvas", "iframe", "object", "embed"}

    def __init__(self, output: Output):
        super().__init__(convert_charrefs=True)
        self.output = output
        self.blocked = 0
        self.list_depth = 0
        self.title: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        if tag in self.BLOCKED:
            self.blocked += 1
            return
        if self.blocked:
            return
        if tag == "title":
            self.in_title = True
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.output.add("\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.output.add("\n" + "  " * self.list_depth + "- ")
        elif tag in {"ul", "ol"}:
            self.list_depth += 1
        elif tag in {"p", "div", "section", "article", "br", "tr"}:
            self.output.add("\n")
        elif tag in {"td", "th"}:
            self.output.add(" | ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in self.BLOCKED:
            self.blocked = max(0, self.blocked - 1)
            return
        if self.blocked:
            return
        if tag == "title":
            self.in_title = False
        elif tag in {"ul", "ol"}:
            self.list_depth = max(0, self.list_depth - 1)
        elif tag in {"p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}:
            self.output.add("\n")

    def handle_data(self, data: str) -> None:
        if self.blocked:
            return
        compact = " ".join(data.split())
        if not compact:
            return
        if self.in_title:
            self.title.append(compact)
        self.output.add(_safe_text(compact) + " ")


RAW_HTML = re.compile(r"<\s*/?\s*[A-Za-z][^>]*>", re.DOTALL)
ACTIVE_LINK = re.compile(
    r"!?\[([^\]]*)\]\(\s*(?:[a-z][a-z0-9+.-]*:|//)[^)]*\)", re.IGNORECASE
)
MARKDOWN_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)", re.IGNORECASE)
MARKDOWN_IMAGE_REFERENCE = re.compile(
    r"!\[([^\]]*)\](?:\[[^\]]*\])?", re.IGNORECASE
)
REMOTE_LINK_DEFINITION = re.compile(
    r"(?m)^\s{0,3}\[([^\]]+)\]:\s*<?(?:[a-z][a-z0-9+.-]*:|//)[^\n]*$",
    re.IGNORECASE,
)
OBSIDIAN_EMBED = re.compile(r"!\[\[([^\]]+)\]\]")
FRONTMATTER = re.compile(r"\A---\s*\r?\n.*?\r?\n---\s*(?:\r?\n|\Z)", re.DOTALL)
FENCE = re.compile(r"(?m)^(\s{0,3})(`{3,}|~{3,})")
TEMPLATER = re.compile(r"<%([*_+~-]?)(.*?)%>", re.DOTALL)
DATAVIEW_INLINE_JS = re.compile(r"`\s*\$=", re.IGNORECASE)
DATAVIEW_INLINE_QUERY = re.compile(r"`\s*=(?!=)", re.IGNORECASE)


def _safe_text(value: str) -> str:
    """Keep text readable in Markdown while neutralizing all active constructs."""
    value = value.replace("\x00", "")
    value = ACTIVE_LINK.sub(lambda match: match.group(1), value)
    value = MARKDOWN_IMAGE.sub(lambda match: f"[image removed: {match.group(1)}]", value)
    value = OBSIDIAN_EMBED.sub(
        lambda match: f"[embedded reference removed: {match.group(1)}]", value
    )
    value = MARKDOWN_IMAGE_REFERENCE.sub(
        lambda match: f"[image removed: {match.group(1)}]", value
    )
    value = REMOTE_LINK_DEFINITION.sub(
        lambda match: f"[remote reference removed: {match.group(1)}]", value
    )
    value = FENCE.sub(lambda match: f"{match.group(1)}\\{match.group(2)}", value)
    value = TEMPLATER.sub(
        lambda match: f"&lt;%{match.group(1)}{match.group(2)}%&gt;", value
    )
    value = DATAVIEW_INLINE_JS.sub("`\\$=", value)
    value = DATAVIEW_INLINE_QUERY.sub("`\\=", value)
    return html.escape(value, quote=False)


def _sanitize_markdown(raw: str) -> str:
    raw = FRONTMATTER.sub("", raw, count=1)
    raw = ACTIVE_LINK.sub(lambda match: match.group(1), raw)
    raw = MARKDOWN_IMAGE.sub(lambda match: f"[image removed: {match.group(1)}]", raw)
    raw = OBSIDIAN_EMBED.sub(lambda match: f"[embedded reference removed: {match.group(1)}]", raw)
    raw = MARKDOWN_IMAGE_REFERENCE.sub(
        lambda match: f"[image removed: {match.group(1)}]", raw
    )
    raw = REMOTE_LINK_DEFINITION.sub(
        lambda match: f"[remote reference removed: {match.group(1)}]", raw
    )
    # Plugin-backed executable fences (DataviewJS/Templater/etc.) cannot run
    # once every fence marker is escaped. Text remains legible and auditable.
    raw = FENCE.sub(lambda match: f"{match.group(1)}\\{match.group(2)}", raw)
    raw = TEMPLATER.sub(
        lambda match: f"&lt;%{match.group(1)}{match.group(2)}%&gt;", raw
    )
    raw = DATAVIEW_INLINE_JS.sub("`\\$=", raw)
    raw = DATAVIEW_INLINE_QUERY.sub("`\\=", raw)
    raw = RAW_HTML.sub("", raw)
    return raw.replace("\x00", "").strip()


def _extract_text(path: Path, extension: str, output: Output) -> tuple[str | None, list[str]]:
    raw = path.read_bytes().decode("utf-8-sig")
    if extension == ".md":
        output.add(_sanitize_markdown(raw))
        warnings = ["frontmatter, raw HTML, active links, and image embeds were sanitized"]
    else:
        output.add(_safe_text(raw))
        warnings = ["raw HTML and image/embed syntax were neutralized"]
    return None, warnings


def _extract_csv(path: Path, output: Output) -> tuple[str | None, list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        rows = []
        for number, row in enumerate(reader, 1):
            if number > 10_000:
                raise ValueError("CSV exceeds maximum row count")
            rows.append(row[:200])
    _table(rows, output)
    return None, []


def _extract_json(path: Path, output: Output) -> tuple[str | None, list[str]]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    # Indented code cannot be closed by adversarial backtick runs in JSON strings.
    serialized = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    output.add("\n".join(f"    {line}" for line in serialized.splitlines()))
    return None, []


def _extract_html(path: Path, output: Output) -> tuple[str | None, list[str]]:
    parser = SafeHTML(output)
    parser.feed(path.read_text(encoding="utf-8-sig"))
    parser.close()
    title = " ".join(parser.title).strip() or None
    return title, ["active HTML, scripts, styles, embeds, and attributes were removed"]


def _text_score(value: str) -> tuple[int, int]:
    """Prefer actual readable characters, then bounded overall text length."""
    return sum(character.isalnum() for character in value), len(value.strip())


def _extract_pdf(path: Path, output: Output) -> tuple[str | None, list[str]]:
    import pypdfium2 as pdfium
    from pypdf import PdfReader

    reader = PdfReader(path, strict=True)
    if reader.is_encrypted:
        raise ValueError("encrypted PDF is not supported")
    if len(reader.pages) > MAX_PDF_PAGES:
        raise ValueError("PDF exceeds maximum page count")
    raster = pdfium.PdfDocument(str(path))
    if len(raster) != len(reader.pages):
        raster.close()
        raise ValueError("PDF page trees disagree")
    ocr_pages = 0
    projected_pixels = 0
    try:
        for number, page in enumerate(reader.pages, 1):
            raw_text = page.extract_text() or ""
            if _text_score(raw_text)[0] < MIN_USEFUL_TEXT_ALNUM:
                ocr_pages += 1
                if ocr_pages > MAX_OCR_PAGES_OR_FRAMES:
                    raise ValueError("PDF requires OCR on more than 8 pages")
                raster_page = raster[number - 1]
                try:
                    width, height = raster_page.get_size()
                    scale = OCR_DPI / 72
                    if (
                        not math.isfinite(width)
                        or not math.isfinite(height)
                        or width <= 0
                        or height <= 0
                    ):
                        raise ValueError("PDF page has invalid dimensions")
                    pixel_width = math.ceil(width * scale)
                    pixel_height = math.ceil(height * scale)
                    page_pixels = pixel_width * pixel_height
                    projected_pixels += page_pixels
                    if (
                        page_pixels > MAX_IMAGE_PIXELS
                        or projected_pixels > MAX_TOTAL_IMAGE_PIXELS
                    ):
                        raise ValueError("rasterized PDF exceeds maximum pixel count")
                    # Pixel bounds are checked before PDFium allocates the bitmap.
                    bitmap = raster_page.render(
                        scale=scale,
                        grayscale=True,
                        fill_color=(255, 255, 255, 255),
                    )
                    try:
                        with tempfile.TemporaryDirectory(
                            prefix="hermess-pdf-ocr-"
                        ) as directory:
                            image_path = Path(directory) / "page.png"
                            bitmap.to_pil().save(image_path, "PNG", optimize=False)
                            ocr_text = _run_tesseract(image_path, Path(directory))
                    finally:
                        bitmap.close()
                finally:
                    raster_page.close()
                if _text_score(ocr_text) > _text_score(raw_text):
                    raw_text = ocr_text
            text = _safe_text(raw_text)
            if text.strip():
                output.add(f"## Page {number}\n\n{text.strip()}\n\n")
    finally:
        raster.close()
    if not output.value():
        raise ValueError("PDF has no text layer or OCR-readable Persian/English text")
    title = None
    if reader.metadata:
        title = str(reader.metadata.title or "").strip() or None
    warnings_list = (
        [f"{ocr_pages} page(s) used local Tesseract OCR (fas+eng)"]
        if ocr_pages
        else []
    )
    return title, warnings_list


def _run_tesseract(image_path: Path, directory: Path) -> str:
    output_base = directory / "ocr"
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "OMP_THREAD_LIMIT": "1",
    }
    try:
        result = subprocess.run(
            [
                "/usr/bin/tesseract",
                str(image_path),
                str(output_base),
                "-l",
                "fas+eng",
                "--tessdata-dir",
                TESSDATA_DIRECTORY,
                "--oem",
                "1",
                "--psm",
                "3",
                "txt",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=25,
            check=False,
            close_fds=True,
            env=environment,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise ValueError("local Persian/English OCR is unavailable or timed out") from exc
    if result.returncode != 0:
        raise ValueError("local Persian/English OCR failed")
    destination = output_base.with_suffix(".txt")
    raw = destination.read_bytes()
    if len(raw) > 1_900_000:
        raise ValueError("OCR text exceeds maximum size")
    return raw.decode("utf-8", errors="strict")


def _extract_image(path: Path, output: Output) -> tuple[str | None, list[str]]:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    expected_formats = {
        ".png": "PNG",
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".webp": "WEBP",
        ".tif": "TIFF",
        ".tiff": "TIFF",
        ".bmp": "BMP",
    }
    total_pixels = 0
    frames = 0
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        expected = expected_formats[path.suffix.casefold()]
        # Restrict decoder selection up front; do not let Pillow probe every
        # installed image plugin before checking the decoded format.
        with Image.open(path, formats=[expected]) as image:
            declared_frames = int(getattr(image, "n_frames", 1))
            if declared_frames > MAX_OCR_PAGES_OR_FRAMES:
                raise ValueError("image exceeds maximum OCR frame count")
            while True:
                frames += 1
                if frames > MAX_OCR_PAGES_OR_FRAMES:
                    raise ValueError("image exceeds maximum OCR frame count")
                image.seek(frames - 1)
                image.load()
                frame = ImageOps.exif_transpose(image.copy())
                pixels = frame.width * frame.height
                total_pixels += pixels
                if pixels > MAX_IMAGE_PIXELS or total_pixels > MAX_TOTAL_IMAGE_PIXELS:
                    raise ValueError("image exceeds maximum pixel count")
                if frame.mode in {"RGBA", "LA"} or "transparency" in frame.info:
                    rgba = frame.convert("RGBA")
                    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                    white.alpha_composite(rgba)
                    normalized = white.convert("L")
                else:
                    normalized = frame.convert("L")
                with tempfile.TemporaryDirectory(prefix="hermess-image-ocr-") as directory:
                    image_path = Path(directory) / "frame.png"
                    normalized.save(image_path, "PNG", optimize=False)
                    text = _run_tesseract(image_path, Path(directory))
                if text.strip():
                    if getattr(image, "n_frames", 1) > 1:
                        output.add(f"## Frame {frames}\n\n")
                    output.add(_safe_text(text.strip()) + "\n\n")
                try:
                    image.seek(frames)
                except EOFError:
                    break
    if not output.value():
        raise ValueError("image has no OCR-readable Persian or English text")
    return None, [f"{frames} image frame(s) used local Tesseract OCR (fas+eng)"]


def _extract_docx(path: Path, output: Output) -> tuple[str | None, list[str]]:
    from docx import Document

    document = Document(path)
    title = str(document.core_properties.title or "").strip() or None
    for block in document.iter_inner_content():
        if hasattr(block, "rows"):
            _table(([cell.text for cell in row.cells] for row in block.rows), output)
            continue
        text = _safe_text(block.text.strip())
        if not text:
            continue
        style = str(block.style.name or "").casefold()
        heading = re.search(r"heading\s+([1-6])", style)
        output.add(("#" * int(heading.group(1)) + " " if heading else "") + text + "\n\n")
    return title, ["embedded media was not copied"]


def _extract_pptx(path: Path, output: Output) -> tuple[str | None, list[str]]:
    from pptx import Presentation

    presentation = Presentation(path)
    title = str(presentation.core_properties.title or "").strip() or None
    for number, slide in enumerate(presentation.slides, 1):
        output.add(f"## Slide {number}\n\n")
        for shape in sorted(
            slide.shapes,
            key=lambda item: (
                int(getattr(item, "top", 0)),
                int(getattr(item, "left", 0)),
                str(getattr(item, "name", "")),
            ),
        ):
            if getattr(shape, "has_table", False):
                _table(([cell.text for cell in row.cells] for row in shape.table.rows), output)
            elif getattr(shape, "has_text_frame", False):
                for paragraph in shape.text_frame.paragraphs:
                    text = _safe_text(paragraph.text.strip())
                    if text:
                        output.add(("  " * min(paragraph.level, 8)) + "- " + text + "\n")
        output.add("\n")
    return title, ["embedded media and speaker-note attachments were not copied"]


def _extract_xlsx(path: Path, output: Output) -> tuple[str | None, list[str]]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    if len(workbook.worksheets) > MAX_SHEETS:
        raise ValueError("workbook exceeds maximum sheet count")
    total_cells = 0
    try:
        for worksheet in workbook.worksheets:
            output.add(f"## Sheet: {_safe_text(worksheet.title)}\n\n")
            if worksheet.max_row > 10_000 or worksheet.max_column > 200:
                raise ValueError("worksheet dimensions exceed safe row/column limits")
            if worksheet.max_row * worksheet.max_column > MAX_TABLE_CELLS:
                raise ValueError("worksheet dimensions exceed maximum cell count")
            rows: list[list[Any]] = []
            for row_number, row in enumerate(
                worksheet.iter_rows(values_only=True), 1
            ):
                total_cells += len(row)
                if total_cells > MAX_TABLE_CELLS:
                    raise ValueError("workbook exceeds maximum cell count")
                rows.append(list(row))
            _table(rows, output)
    finally:
        workbook.close()
    return None, ["formulas were not executed; cached values were read when present"]


EXTRACTORS = {
    ".md": ("markdown-sanitizer", _extract_text),
    ".txt": ("utf8-text", _extract_text),
    ".csv": ("python-csv", _extract_csv),
    ".json": ("python-json", _extract_json),
    ".html": ("stdlib-html-parser", _extract_html),
    ".htm": ("stdlib-html-parser", _extract_html),
    ".pdf": ("pypdf+pypdfium2+tesseract-fas-eng", _extract_pdf),
    ".docx": ("python-docx", _extract_docx),
    ".pptx": ("python-pptx", _extract_pptx),
    ".xlsx": ("openpyxl-read-only", _extract_xlsx),
    ".png": ("pillow+tesseract-fas-eng", _extract_image),
    ".jpg": ("pillow+tesseract-fas-eng", _extract_image),
    ".jpeg": ("pillow+tesseract-fas-eng", _extract_image),
    ".webp": ("pillow+tesseract-fas-eng", _extract_image),
    ".tif": ("pillow+tesseract-fas-eng", _extract_image),
    ".tiff": ("pillow+tesseract-fas-eng", _extract_image),
    ".bmp": ("pillow+tesseract-fas-eng", _extract_image),
}


def main() -> int:
    if len(sys.argv) != 6:
        return 2
    source, extension, destination, raw_limit, raw_timeout = sys.argv[1:]
    limit = int(raw_limit)
    timeout = int(raw_timeout)
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout + 2))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    file_limit = max(64 * 1024 * 1024, limit + 128 * 1024)
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
    if hasattr(resource, "RLIMIT_NPROC"):
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
    output = Output(limit)
    extractor, callback = EXTRACTORS[extension]
    title, warnings = callback(Path(source), extension, output) if extension in {".md", ".txt"} else callback(Path(source), output)
    content = output.value()
    if not content:
        raise ValueError("document has no extractable text")
    payload = {
        "content": content,
        "title": title,
        "extractor": f"{PARSER_VERSION}:{extractor}",
        "warnings": warnings,
    }
    Path(destination).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - parent surfaces a bounded safe message
        print(f"extraction failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
