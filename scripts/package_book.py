#!/usr/bin/env python3
"""Assemble a validated book as a static reader folder and reproducible ZIP."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from validate_book import validate_book


READER_DIR = Path(__file__).resolve().parents[1] / "assets/reader"
THEME_DIR = READER_DIR / "themes"
THEME_BACKGROUND_DIR = THEME_DIR / "backgrounds"
READER_FILES = ("index.html", "reader.css", "playback-utils.js", "reader.js")
THEME_MODES = ("default", "storybook", "winter", "vehicles", "construction", "ocean", "forest", "farm", "space")
THEME_ORIENTATIONS = ("landscape", "portrait")
THEME_FILES = tuple(f"{mode}-{orientation}.webp" for mode in THEME_MODES for orientation in THEME_ORIENTATIONS)
THEME_ICON_FILES = ("default.svg", "storybook.svg", "winter.svg", "vehicles.svg", "construction.svg", "ocean.svg", "forest.svg", "farm.svg", "space.svg", "book.svg")
MARKER_NAME = ".picturebook-generated.json"


def collect_references(book: dict) -> list[str]:
    references = set()
    theme = book.get("readerTheme", {})
    for field in ("backgroundImage", "backgroundImagePortrait"):
        if theme.get(field):
            references.add(theme[field])
    for page in book["pages"]:
        references.add(page["image"])
        for field in ("englishAudio", "chineseAudio"):
            if page.get(field):
                references.add(page[field])
        for word in page.get("words", []):
            references.add(word["audio"])
    references.add("audio/manifest.json")
    return sorted(references)


def copy_relative(source_root: Path, target_root: Path, relative: str) -> None:
    posix_path = PurePosixPath(relative)
    if posix_path.is_absolute() or any(part in {"", ".", ".."} for part in posix_path.parts):
        raise ValueError(f"unsafe asset path: {relative}")
    source = (source_root / Path(*posix_path.parts)).resolve()
    target = target_root / Path(*posix_path.parts)
    source.relative_to(source_root.resolve())
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def zip_reproducibly(folder: Path, archive_path: Path) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{archive_path.name}.", suffix=".part", dir=archive_path.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for source in sorted(path for path in folder.rglob("*") if path.is_file()):
                relative = source.relative_to(folder).as_posix()
                suffix = source.suffix.lower()
                method = zipfile.ZIP_STORED if suffix in {".jpg", ".jpeg", ".png", ".webp", ".mp3"} else zipfile.ZIP_DEFLATED
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = method
                info.external_attr = 0o100644 << 16
                archive.writestr(info, source.read_bytes(), compress_type=method, compresslevel=6 if method == zipfile.ZIP_DEFLATED else None)
        os.replace(temporary, archive_path)
    finally:
        temporary.unlink(missing_ok=True)


def package_book(source_root: Path, output_dir: Path, archive_path: Path, replace_generated: bool = False) -> dict:
    source_root = source_root.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    archive_path = archive_path.expanduser().resolve()
    book_path = source_root / "book.json"
    if not book_path.is_file():
        raise ValueError(f"book.json is missing from {source_root}")
    book = json.loads(book_path.read_text(encoding="utf-8"))
    report = validate_book(book_path, source_root)
    if report["status"] != "passed":
        raise ValueError(f"QA did not pass ({len(report['errors'])} blocking errors); fix {source_root / 'qa-report.json'} first")
    if output_dir == source_root:
        raise ValueError("--output-dir must be separate from the source work directory")
    try:
        archive_path.relative_to(source_root)
    except ValueError:
        pass
    else:
        raise ValueError("--zip must be outside the source work directory")
    try:
        archive_path.relative_to(output_dir)
    except ValueError:
        pass
    else:
        raise ValueError("--zip must be outside --output-dir")
    replace_existing = False
    if output_dir.exists():
        marker = output_dir / MARKER_NAME
        if not replace_generated or not marker.is_file():
            raise FileExistsError(f"output directory already exists: {output_dir}; choose another path or pass --replace-generated for a prior generated output")
        replace_existing = True

    if not READER_DIR.is_dir():
        raise ValueError(f"reader template is missing: {READER_DIR}")
    for filename in READER_FILES:
        if not (READER_DIR / filename).is_file():
            raise ValueError(f"reader template file is missing: {filename}")
    for filename in THEME_FILES:
        if not (THEME_BACKGROUND_DIR / filename).is_file():
            raise ValueError(f"reader theme asset is missing: {filename}")
    for filename in THEME_ICON_FILES:
        if not (THEME_DIR / "icons" / filename).is_file():
            raise ValueError(f"reader theme icon is missing: {filename}")

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.", dir=output_dir.parent))
    archive_stage_fd, archive_stage_name = tempfile.mkstemp(prefix=f".{archive_path.name}.", suffix=".stage", dir=archive_path.parent)
    os.close(archive_stage_fd)
    archive_stage = Path(archive_stage_name)
    backup: Path | None = None
    try:
        for filename in READER_FILES:
            shutil.copy2(READER_DIR / filename, stage / filename)
        (stage / "themes").mkdir(parents=True, exist_ok=True)
        (stage / "themes" / "backgrounds").mkdir(parents=True, exist_ok=True)
        for filename in THEME_FILES:
            shutil.copy2(THEME_BACKGROUND_DIR / filename, stage / "themes" / "backgrounds" / filename)
        (stage / "themes" / "icons").mkdir(parents=True, exist_ok=True)
        for filename in THEME_ICON_FILES:
            shutil.copy2(THEME_DIR / "icons" / filename, stage / "themes" / "icons" / filename)
        for relative in collect_references(book):
            copy_relative(source_root, stage, relative)
        shutil.copy2(book_path, stage / "book.json")
        shutil.copy2(source_root / "qa-report.json", stage / "qa-report.json")
        marker = {"generatedBy": "tapbook", "schemaVersion": 1, "title": book["title"]}
        (stage / MARKER_NAME).write_text(json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        zip_reproducibly(stage, archive_stage)
        if replace_existing:
            backup = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.backup.", dir=output_dir.parent))
            backup.rmdir()
            os.replace(output_dir, backup)
        os.replace(stage, output_dir)
        os.replace(archive_stage, archive_path)
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        archive_stage.unlink(missing_ok=True)
        if backup is not None and backup.exists():
            shutil.rmtree(output_dir, ignore_errors=True)
            os.replace(backup, output_dir)
        raise
    return {"outputDir": str(output_dir), "zip": str(archive_path), "pageCount": len(book["pages"]), "status": "passed"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--replace-generated", action="store_true", help="replace an existing output directory marked as generated by this Skill")
    args = parser.parse_args()
    try:
        result = package_book(args.source_dir, args.output_dir, args.zip, args.replace_generated)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
