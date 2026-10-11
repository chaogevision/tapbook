#!/usr/bin/env python3
"""Render source PDF pages and extract page text/OCR word boxes."""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path


class ToolError(RuntimeError):
    pass


def run_tool(command: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise ToolError(f"required tool not found: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(f"tool timed out after {timeout}s: {command[0]}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ToolError(f"{command[0]} failed (exit {result.returncode}): {detail[:500]}")
    return result


def jpeg_dimensions(image_path: Path) -> tuple[int, int]:
    data = image_path.read_bytes()
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise ToolError(f"renderer did not create a valid JPEG: {image_path.name}")

    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            continue
        if offset + 2 > len(data):
            break
        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in sof_markers and segment_length >= 7:
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            if width > 0 and height > 0:
                return width, height
        offset += segment_length
    raise ToolError(f"could not read JPEG dimensions: {image_path.name}")


def round6(value: float) -> float:
    return round(value, 6)


def read_ocr_tsv(tsv: str, image_width: int, image_height: int) -> list[dict]:
    words = []
    reader = csv.DictReader(io.StringIO(tsv), delimiter="\t")
    for row in reader:
        if row.get("level") != "5":
            continue
        text = (row.get("text") or "").strip()
        try:
            confidence = float(row.get("conf") or -1)
            left = int(row.get("left") or 0)
            top = int(row.get("top") or 0)
            width = int(row.get("width") or 0)
            height = int(row.get("height") or 0)
        except (TypeError, ValueError):
            continue
        if not text or confidence < 0 or width <= 0 or height <= 0:
            continue

        left = max(0, min(left, image_width))
        top = max(0, min(top, image_height))
        right = max(left, min(left + width, image_width))
        bottom = max(top, min(top + height, image_height))
        if right == left or bottom == top:
            continue
        words.append({
            "text": text,
            "confidence": round6(confidence),
            "box": {
                "x": round6(left / image_width),
                "y": round6(top / image_height),
                "w": round6((right - left) / image_width),
                "h": round6((bottom - top) / image_height),
            },
        })
    return words


def parse_page_count(pdfinfo: str) -> int:
    match = re.search(r"^Pages:\s*(\d+)\s*$", pdfinfo, re.MULTILINE)
    if not match:
        raise ToolError("pdfinfo did not report a page count")
    count = int(match.group(1))
    if count < 1:
        raise ToolError("input PDF has no pages")
    return count


def render(input_pdf: Path, output_dir: Path, dpi: int = 150, ocr_lang: str = "eng") -> dict:
    input_pdf = input_pdf.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    if not input_pdf.is_file():
        raise ToolError(f"input PDF does not exist: {input_pdf}")
    if input_pdf.suffix.lower() != ".pdf":
        raise ToolError("input file must have a .pdf extension")
    if dpi < 36 or dpi > 600:
        raise ToolError("DPI must be between 36 and 600")

    required = ["pdfinfo", "pdftoppm", "pdftotext", "tesseract"]
    missing = [tool for tool in required if not shutil.which(tool)]
    if missing:
        names = ", ".join(missing)
        raise ToolError(f"required PDF/OCR tools not found: {names}; install Poppler and Tesseract")

    pdf_info = run_tool(["pdfinfo", str(input_pdf)])
    page_count = parse_page_count(pdf_info.stdout)
    assets_dir = output_dir / "assets"
    ocr_dir = output_dir / "ocr"
    text_dir = output_dir / "source-text"
    assets_dir.mkdir(parents=True, exist_ok=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)

    pages = []
    for page_number in range(1, page_count + 1):
        page_id = f"page-{page_number:03d}"
        prefix = assets_dir / page_id
        image_path = prefix.with_suffix(".jpg")
        run_tool([
            "pdftoppm", "-f", str(page_number), "-l", str(page_number), "-singlefile",
            "-jpeg", "-jpegopt", "quality=92", "-r", str(dpi), str(input_pdf), str(prefix),
        ], timeout=180)
        if not image_path.is_file() or image_path.stat().st_size == 0:
            raise ToolError(f"pdftoppm did not create page {page_number}")
        image_width, image_height = jpeg_dimensions(image_path)

        extracted = run_tool(["pdftotext", "-f", str(page_number), "-l", str(page_number), "-layout", str(input_pdf), "-"])
        text_path = text_dir / f"{page_id}.txt"
        text_path.write_text(extracted.stdout, encoding="utf-8")

        ocr = run_tool(["tesseract", str(image_path), "stdout", "-l", ocr_lang, "tsv"], timeout=180)
        ocr_path = ocr_dir / f"{page_id}.json"
        ocr_data = {
            "sourcePdfPage": page_number,
            "imageWidth": image_width,
            "imageHeight": image_height,
            "language": ocr_lang,
            "words": read_ocr_tsv(ocr.stdout, image_width, image_height),
        }
        ocr_path.write_text(json.dumps(ocr_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        pages.append({
            "sourcePdfPage": page_number,
            "image": f"assets/{image_path.name}",
            "width": image_width,
            "height": image_height,
            "sourceText": f"source-text/{text_path.name}",
            "hasTextLayer": bool(extracted.stdout.strip()),
            "ocr": f"ocr/{ocr_path.name}",
            "ocrWords": len(ocr_data["words"]),
        })

    manifest = {
        "sourceFile": input_pdf.name,
        "pageCount": page_count,
        "dpi": dpi,
        "ocrLanguage": ocr_lang,
        "tools": {
            "pdfinfo": shutil.which("pdfinfo"),
            "pdftoppm": shutil.which("pdftoppm"),
            "pdftotext": shutil.which("pdftotext"),
            "tesseract": shutil.which("tesseract"),
        },
        "pages": pages,
    }
    manifest_path = output_dir / "render-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--dpi", default=150, type=int)
    parser.add_argument("--ocr-lang", default="eng")
    args = parser.parse_args()
    try:
        manifest = render(args.input_pdf, args.output_dir, args.dpi, args.ocr_lang)
    except ToolError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "pageCount": manifest["pageCount"], "outputDir": str(args.output_dir)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
