#!/usr/bin/env python3
"""Validate a generated picture book and write qa-report.json."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import unicodedata
from pathlib import Path, PurePosixPath


TOKEN_RE = re.compile(r"[^\W_]+(?:[’'][^\W_]+)*(?:-[^\W_]+)*", re.UNICODE)
EDGE_PUNCTUATION = "\"'“”‘’.,!?;:()[]{}<>—–…"
MIN_TOUCH_TARGET_PX = 44
REFERENCE_DISPLAY_WIDTHS = (320, 600, 900)


def clean_token(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).replace("’", "'")
    return normalized.strip(EDGE_PUNCTUATION).casefold()


def text_tokens(text: str) -> list[str]:
    return [clean_token(value) for value in TOKEN_RE.findall(text) if clean_token(value)]


def asset_path(root: Path, value, errors: list, code: str, page_index: int | None = None) -> tuple[Path | None, str | None]:
    if not isinstance(value, str) or not value.strip():
        errors.append({"code": code, "page": page_index, "message": "asset path is empty"})
        return None, None
    if "\\" in value:
        errors.append({"code": code, "page": page_index, "message": f"asset path must use relative POSIX separators: {value}"})
        return None, None
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        errors.append({"code": code, "page": page_index, "message": f"asset path is not a safe relative path: {value}"})
        return None, None
    target = (root / Path(*relative.parts)).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        errors.append({"code": code, "page": page_index, "message": f"asset path escapes book root: {value}"})
        return None, None
    if not target.is_file() or target.stat().st_size == 0:
        errors.append({"code": code, "page": page_index, "message": f"asset is missing or empty: {value}"})
    return target, relative.as_posix()


def valid_box(box) -> bool:
    if not isinstance(box, dict) or set(box) != {"x", "y", "w", "h"}:
        return False
    try:
        x, y, width, height = (float(box[key]) for key in ("x", "y", "w", "h"))
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(value) for value in (x, y, width, height)):
        return False
    return x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= 1.000001 and y + height <= 1.000001


def image_dimensions(image_path: Path) -> tuple[int, int] | None:
    """Read dimensions for the JPEG/PNG pages produced or accepted by TapBook."""
    try:
        with image_path.open("rb") as handle:
            header = handle.read(26)
            if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
                width = int.from_bytes(header[16:20], "big")
                height = int.from_bytes(header[20:24], "big")
                return (width, height) if width > 0 and height > 0 else None
            if not header.startswith(b"\xff\xd8"):
                return None
            handle.seek(2)
            sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
            while True:
                prefix = handle.read(1)
                if not prefix:
                    return None
                if prefix != b"\xff":
                    continue
                marker_data = handle.read(1)
                while marker_data == b"\xff":
                    marker_data = handle.read(1)
                if not marker_data:
                    return None
                marker = marker_data[0]
                if marker in {0xD8, 0xD9, 0x01} or 0xD0 <= marker <= 0xD7:
                    continue
                segment_length_data = handle.read(2)
                if len(segment_length_data) != 2:
                    return None
                segment_length = int.from_bytes(segment_length_data, "big")
                if segment_length < 2:
                    return None
                if marker in sof_markers:
                    dimensions = handle.read(5)
                    if len(dimensions) != 5:
                        return None
                    height = int.from_bytes(dimensions[1:3], "big")
                    width = int.from_bytes(dimensions[3:5], "big")
                    return (width, height) if width > 0 and height > 0 else None
                handle.seek(segment_length - 2, os.SEEK_CUR)
    except OSError:
        return None


def dimensions_from_manifest(render_manifest: dict, source_page: int) -> tuple[int, int] | None:
    pages = render_manifest.get("pages", []) if isinstance(render_manifest, dict) else []
    for item in pages if isinstance(pages, list) else []:
        if not isinstance(item, dict) or item.get("sourcePdfPage") != source_page:
            continue
        try:
            width, height = int(item.get("width", 0)), int(item.get("height", 0))
        except (TypeError, ValueError):
            return None
        return (width, height) if width > 0 and height > 0 else None
    return None


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {path}: {exc}") from exc


def validate_book(book_path: Path, root: Path) -> dict:
    book_path = book_path.expanduser().resolve()
    root = root.expanduser().resolve()
    report = {
        "status": "failed",
        "title": "",
        "pageCount": 0,
        "errors": [],
        "warnings": [],
        "lowConfidenceTexts": [],
        "unreferencedAssets": [],
        "checks": {"pageCount": False, "images": False, "translations": False, "sentenceTranslations": False, "words": False, "audio": False, "pageReview": False, "theme": False, "themeBackground": False, "layout": False, "touchTargets": False},
        "touchTargetAudit": {
            "minimumCssPixels": MIN_TOUCH_TARGET_PX,
            "referenceDisplayWidths": list(REFERENCE_DISPLAY_WIDTHS),
            "wordCount": 0,
            "wordsNeedingExpansion": [0 for _ in REFERENCE_DISPLAY_WIDTHS],
            "pageImagesWithKnownDimensions": 0,
        },
    }
    errors = report["errors"]
    warnings = report["warnings"]
    referenced: set[str] = set()
    try:
        book = read_json(book_path)
    except ValueError as exc:
        errors.append({"code": "invalid_book_json", "message": str(exc)})
        write_report(root, report)
        return report

    if not isinstance(book, dict):
        errors.append({"code": "invalid_book", "message": "book JSON root must be an object"})
        write_report(root, report)
        return report
    report["title"] = str(book.get("title", ""))
    if book.get("schemaVersion") != 1:
        errors.append({"code": "invalid_schema_version", "message": "schemaVersion must be 1"})
    for field in ("title", "sourceLanguage", "translationLanguage"):
        if not isinstance(book.get(field), str) or not book[field].strip():
            errors.append({"code": "missing_book_field", "message": f"{field} must be a non-empty string"})
    voices = book.get("voices")
    if not isinstance(voices, dict) or not voices.get("en") or not voices.get("zh"):
        errors.append({"code": "missing_voice", "message": "voices.en and voices.zh must both be configured"})
    theme_presets = {"winter", "vehicles", "construction", "ocean", "forest", "farm", "space", "storybook"}
    theme = book.get("readerTheme")
    theme_ok = isinstance(theme, dict) and theme.get("preset") in theme_presets and theme.get("source") in {"auto", "user", "fallback"} and theme.get("confidence") in {"high", "medium", "low"} and isinstance(theme.get("reason"), str) and bool(theme["reason"].strip())
    if not theme_ok:
        errors.append({"code": "invalid_reader_theme", "message": "readerTheme needs an allowed preset, source, confidence, and a non-empty reason"})
    bundled_theme_dir = Path(__file__).resolve().parents[1] / "assets/reader/themes/backgrounds"
    bundled_theme_files = tuple(
        f"{preset}-{orientation}.webp"
        for preset in ("default", *sorted(theme_presets))
        for orientation in ("landscape", "portrait")
    )
    bundled_themes_ok = all((bundled_theme_dir / name).is_file() and (bundled_theme_dir / name).stat().st_size > 0 for name in bundled_theme_files)
    if not bundled_themes_ok:
        errors.append({"code": "missing_preset_theme", "message": "Every bundled theme needs landscape and portrait background artwork"})
    theme_background_ok = bundled_themes_ok and not (isinstance(theme, dict) and "backgroundImage" in theme)
    if isinstance(theme, dict):
        if "backgroundImage" in theme:
            background, relative_background = asset_path(root, theme.get("backgroundImage"), errors, "missing_theme_background")
            if background is not None and background.is_file() and background.stat().st_size > 0 and relative_background:
                referenced.add(relative_background)
                theme_background_ok = bundled_themes_ok
        portrait_background = theme.get("backgroundImagePortrait")
        if portrait_background:
            if not theme.get("backgroundImage"):
                errors.append({"code": "missing_theme_background", "message": "readerTheme.backgroundImagePortrait requires a landscape backgroundImage"})
                theme_background_ok = False
            else:
                portrait, relative_portrait = asset_path(root, portrait_background, errors, "missing_portrait_theme_background")
                if portrait is not None and portrait.is_file() and portrait.stat().st_size > 0 and relative_portrait:
                    referenced.add(relative_portrait)
                else:
                    theme_background_ok = False
    presentation = book.get("presentation")
    layout_ok = isinstance(presentation, dict) and presentation.get("pageMode") in {"single", "facing-pages", "source-spread"}
    if not layout_ok:
        errors.append({"code": "invalid_page_mode", "message": "presentation.pageMode must be single, facing-pages, or source-spread"})

    pages = book.get("pages")
    if not isinstance(pages, list) or not pages:
        errors.append({"code": "missing_pages", "message": "book must contain at least one page"})
        pages = []
    report["pageCount"] = len(pages)
    source_language = str(book.get("sourceLanguage", "")).casefold()
    english_source = source_language.startswith("en") or source_language == "english"
    render_manifest_path = root / "render-manifest.json"
    render_manifest = {}
    render_manifest_exists = render_manifest_path.is_file()
    if render_manifest_exists:
        try:
            render_manifest = read_json(render_manifest_path)
        except ValueError as exc:
            errors.append({"code": "invalid_render_manifest", "message": str(exc)})
    touch_targets_ok = True
    touch_words_by_page: dict[int, list[str]] = {}
    image_dimensions_checked: set[int] = set()
    page_images_ok = True
    translations_ok = True
    sentence_translations_ok = True
    words_ok = True
    review_ok = True
    audio_ok = True
    indexes = []
    source_pages = []
    referenced_audio = []

    for page_number, page in enumerate(pages, start=1):
        if not isinstance(page, dict):
            errors.append({"code": "invalid_page", "page": page_number, "message": "page must be an object"})
            page_images_ok = translations_ok = words_ok = review_ok = audio_ok = False
            continue
        index = page.get("index")
        source_page = page.get("sourcePdfPage")
        if not isinstance(index, int) or isinstance(index, bool):
            errors.append({"code": "invalid_page_index", "page": page_number, "message": "index must be an integer"})
        else:
            indexes.append(index)
            if index != page_number:
                errors.append({"code": "page_order_mismatch", "page": page_number, "message": f"expected index {page_number}, got {index}"})
        if not isinstance(source_page, int) or isinstance(source_page, bool) or source_page < 1:
            errors.append({"code": "invalid_source_page", "page": page_number, "message": "sourcePdfPage must be a positive integer"})
        else:
            source_pages.append(source_page)

        if not isinstance(page.get("alt"), str) or not page["alt"].strip():
            errors.append({"code": "missing_alt_text", "page": page_number, "message": "page alt text is required"})

        image, relative_image = asset_path(root, page.get("image"), errors, "missing_page_image", page_number)
        if image is None or not image.is_file() or image.stat().st_size == 0:
            page_images_ok = False
        elif relative_image:
            referenced.add(relative_image)

        page_dimensions = dimensions_from_manifest(render_manifest, source_page) if isinstance(source_page, int) else None
        if page_dimensions is None and image is not None and image.is_file():
            page_dimensions = image_dimensions(image)
        if page_dimensions:
            image_dimensions_checked.add(page_number)

        if page.get("reviewStatus") != "verified":
            review_ok = False
            errors.append({"code": "ocr_needs_review", "page": page_number, "message": "page must be visually verified before publishing"})
        ocr_warnings = page.get("ocrWarnings", [])
        if not isinstance(ocr_warnings, list):
            errors.append({"code": "invalid_ocr_warnings", "page": page_number, "message": "ocrWarnings must be an array"})
            review_ok = False
        else:
            for warning in ocr_warnings:
                if isinstance(warning, str) and warning.strip():
                    report["lowConfidenceTexts"].append({"page": page_number, "text": warning.strip()})
                    warnings.append({"code": "ocr_note", "page": page_number, "message": warning.strip()})

        en_text = page.get("enText", "")
        zh_text = page.get("zhText", "")
        if not isinstance(en_text, str) or not isinstance(zh_text, str):
            errors.append({"code": "invalid_page_text", "page": page_number, "message": "enText and zhText must be strings"})
            en_text = zh_text = ""
        kind = page.get("kind")
        has_story = kind == "story" and bool(en_text.strip())
        if has_story and english_source and not zh_text.strip():
            translations_ok = False
            errors.append({"code": "missing_translation", "page": page_number, "message": "English story page has no Chinese translation"})

        page_words = page.get("words", [])
        if not isinstance(page_words, list):
            errors.append({"code": "invalid_words", "page": page_number, "message": "words must be an array"})
            page_words = []
            words_ok = False
        if page_words and not page_dimensions:
            touch_targets_ok = False
            errors.append({"code": "missing_touch_target_geometry", "page": page_number, "message": "word boxes need a readable page image dimension to verify device-sized touch targets"})
        elif page_words and page_dimensions:
            image_width, image_height = page_dimensions
            short_reference_widths = [
                width for width in REFERENCE_DISPLAY_WIDTHS
                if width * image_height / image_width < MIN_TOUCH_TARGET_PX
            ]
            if short_reference_widths:
                touch_targets_ok = False
                errors.append({"code": "page_too_short_for_touch_targets", "page": page_number, "message": f"the page aspect ratio leaves less than {MIN_TOUCH_TARGET_PX} CSS px of height at reference widths {short_reference_widths}"})
        text_word_tokens = text_tokens(en_text)
        written_word_tokens = [clean_token(str(word.get("text", ""))) for word in page_words if isinstance(word, dict)]
        if text_word_tokens != written_word_tokens:
            words_ok = False
            errors.append({"code": "word_text_mismatch", "page": page_number, "message": f"transcript has {len(text_word_tokens)} words but token list has {len(written_word_tokens)} in a different order"})

        sentence_rows = page.get("sentences")
        if en_text.strip():
            if not isinstance(sentence_rows, list) or not sentence_rows:
                sentence_translations_ok = False
                errors.append({"code": "missing_sentence_translations", "page": page_number, "message": "English text needs sentence-level Chinese translations"})
            else:
                expected_start = 0
                for sentence_index, sentence in enumerate(sentence_rows, start=1):
                    if not isinstance(sentence, dict):
                        sentence_translations_ok = False
                        errors.append({"code": "invalid_sentence_translation", "page": page_number, "message": f"sentence {sentence_index} must be an object"})
                        continue
                    word_start = sentence.get("wordStart")
                    word_end = sentence.get("wordEnd")
                    translation = sentence.get("translationZh")
                    valid_bounds = (
                        isinstance(word_start, int) and not isinstance(word_start, bool)
                        and isinstance(word_end, int) and not isinstance(word_end, bool)
                        and word_start == expected_start and word_end > word_start and word_end <= len(page_words)
                    )
                    if not valid_bounds or not isinstance(translation, str) or not translation.strip():
                        sentence_translations_ok = False
                        errors.append({"code": "invalid_sentence_translation", "page": page_number, "message": f"sentence {sentence_index} needs contiguous valid word bounds and a Chinese translation"})
                        if isinstance(word_end, int) and not isinstance(word_end, bool) and word_end > expected_start:
                            expected_start = word_end
                    else:
                        expected_start = word_end
                if expected_start != len(page_words):
                    sentence_translations_ok = False
                    errors.append({"code": "sentence_coverage_mismatch", "page": page_number, "message": f"sentence translations cover {expected_start} of {len(page_words)} words"})
        elif isinstance(sentence_rows, list) and sentence_rows:
            sentence_translations_ok = False
            errors.append({"code": "unexpected_sentence_translations", "page": page_number, "message": "pages without English text must not define English sentence translations"})

        page_word_centers = []
        for word_index, word in enumerate(page_words, start=1):
            if not isinstance(word, dict):
                words_ok = False
                errors.append({"code": "invalid_word", "page": page_number, "message": f"word {word_index} must be an object"})
                continue
            for field in ("text", "lemma", "meaningZh"):
                if not isinstance(word.get(field), str) or not word[field].strip():
                    words_ok = False
                    code = "missing_word_meaning" if field == "meaningZh" else "invalid_word_text"
                    errors.append({"code": code, "page": page_number, "message": f"word {word_index} needs {field}"})
            if not valid_box(word.get("box")):
                words_ok = False
                touch_targets_ok = False
                errors.append({"code": "invalid_word_box", "page": page_number, "message": f"word {word_index} bounds are outside the normalized page"})
            elif page_dimensions:
                report["touchTargetAudit"]["wordCount"] += 1
                image_width, image_height = page_dimensions
                page_word_centers.append({
                    "index": word_index,
                    "text": str(word.get("text", "")),
                    "x": float(word["box"]["x"]) + float(word["box"]["w"]) / 2,
                    "y": float(word["box"]["y"]) + float(word["box"]["h"]) / 2,
                })
                compact_at_widths = []
                for width_index, display_width in enumerate(REFERENCE_DISPLAY_WIDTHS):
                    display_height = display_width * image_height / image_width
                    source_width = float(word["box"]["w"]) * display_width
                    source_height = float(word["box"]["h"]) * display_height
                    if source_width < MIN_TOUCH_TARGET_PX or source_height < MIN_TOUCH_TARGET_PX:
                        report["touchTargetAudit"]["wordsNeedingExpansion"][width_index] += 1
                        compact_at_widths.append(display_width)
                if compact_at_widths:
                    touch_words_by_page.setdefault(page_number, []).append(str(word.get("text", "")))
            audio, relative_audio = asset_path(root, word.get("audio"), errors, "missing_word_audio", page_number)
            if audio is None or not audio.is_file() or audio.stat().st_size == 0:
                audio_ok = False
            elif relative_audio:
                referenced.add(relative_audio)
                referenced_audio.append((relative_audio, page_number))

        for field, text in (("englishAudio", en_text), ("chineseAudio", zh_text)):
            value = page.get(field)
            if text.strip() and not value:
                audio_ok = False
                errors.append({"code": "missing_page_audio", "page": page_number, "message": f"{field} is required for non-empty page text"})
            if value:
                audio, relative_audio = asset_path(root, value, errors, "missing_page_audio", page_number)
                if audio is None or not audio.is_file() or audio.stat().st_size == 0:
                    audio_ok = False
                elif relative_audio:
                    referenced.add(relative_audio)
                    referenced_audio.append((relative_audio, page_number))

        if page_dimensions and len(page_word_centers) > 1:
            image_width, image_height = page_dimensions
            reference_width = REFERENCE_DISPLAY_WIDTHS[0]
            reference_height = reference_width * image_height / image_width
            for left_index, left in enumerate(page_word_centers):
                for right in page_word_centers[left_index + 1:]:
                    distance = math.hypot(
                        (left["x"] - right["x"]) * reference_width,
                        (left["y"] - right["y"]) * reference_height,
                    )
                    if distance < 0.5:
                        touch_targets_ok = False
                        errors.append({
                            "code": "ambiguous_word_hotspots",
                            "page": page_number,
                            "message": f"word {left['index']} ({left['text']}) and word {right['index']} ({right['text']}) have indistinguishable centers, so touch input cannot select between them",
                        })

        timings = page.get("wordTimings", [])
        if not isinstance(timings, list):
            timings = []
            errors.append({"code": "invalid_word_timings", "page": page_number, "message": "wordTimings must be an array"})
        previous_start = -1.0
        normalized_timing_tokens = []
        for timing_index, timing in enumerate(timings, start=1):
            if not isinstance(timing, dict):
                errors.append({"code": "invalid_word_timings", "page": page_number, "message": f"timing {timing_index} must be an object"})
                continue
            try:
                start = float(timing.get("start"))
                duration = float(timing.get("duration"))
            except (TypeError, ValueError):
                start, duration = -1, 0
            if not math.isfinite(start) or not math.isfinite(duration) or start < previous_start or duration <= 0:
                errors.append({"code": "invalid_word_timings", "page": page_number, "message": f"timing {timing_index} must be ordered, non-negative, and non-empty"})
            previous_start = start
            normalized_timing_tokens.extend(text_tokens(str(timing.get("text", ""))))
        if en_text.strip() and normalized_timing_tokens != text_word_tokens:
            audio_ok = False
            errors.append({"code": "timing_text_mismatch", "page": page_number, "message": "English narration timings do not match the page transcript"})

    if len(indexes) != len(set(indexes)):
        errors.append({"code": "duplicate_page_index", "message": "page indexes must be unique"})
    if len(source_pages) != len(set(source_pages)):
        errors.append({"code": "duplicate_source_page", "message": "sourcePdfPage values must be unique"})
    if source_pages and source_pages != sorted(source_pages):
        errors.append({"code": "source_page_order_mismatch", "message": "pages must remain in source PDF order"})

    if render_manifest_exists and render_manifest:
        try:
            expected = int(render_manifest.get("pageCount", 0))
            report["checks"]["pageCount"] = expected == len(pages)
            if expected != len(pages):
                errors.append({"code": "page_count_mismatch", "message": f"PDF has {expected} pages but book has {len(pages)}"})
        except (AttributeError, TypeError, ValueError):
            errors.append({"code": "invalid_render_manifest", "message": "render-manifest.json is invalid"})
    else:
        report["checks"]["pageCount"] = bool(pages)

    manifest_path = root / "audio/manifest.json"
    audio_manifest = {}
    if manifest_path.is_file():
        try:
            audio_manifest = read_json(manifest_path)
            referenced.add("audio/manifest.json")
            for error in audio_manifest.get("errors", []):
                audio_ok = False
                errors.append({"code": error.get("code", "audio_generation_error"), "page": None, "message": error.get("message", "audio generation failed")})
        except ValueError as exc:
            audio_ok = False
            errors.append({"code": "invalid_audio_manifest", "message": str(exc)})
    elif referenced_audio:
        audio_ok = False
        errors.append({"code": "missing_audio_manifest", "message": "audio/manifest.json is required for generated audio"})

    files_in_manifest = audio_manifest.get("files", {}) if isinstance(audio_manifest, dict) else {}
    for relative, page_number in referenced_audio:
        entry = files_in_manifest.get(relative)
        if not isinstance(entry, dict) or not entry.get("cacheKey"):
            audio_ok = False
            errors.append({"code": "audio_not_in_manifest", "page": page_number, "message": f"audio file is not registered: {relative}"})

    for folder_name in ("assets", "audio"):
        folder = root / folder_name
        if folder.is_dir():
            for item in folder.rglob("*"):
                if item.is_file():
                    relative = item.relative_to(root).as_posix()
                    if relative not in referenced and not relative.endswith(".part"):
                        report["unreferencedAssets"].append(relative)
                        warnings.append({"code": "unreferenced_asset", "message": relative})

    for page_number, compact_words in touch_words_by_page.items():
        samples = compact_words[:5]
        warnings.append({
            "code": "small_printed_word_boxes",
            "page": page_number,
            "message": f"{len(compact_words)} printed word boxes fall below {MIN_TOUCH_TARGET_PX} CSS px at one or more reference display widths; the reader expands their tap targets and resolves overlap by nearest word center.",
            "sampleWords": samples,
        })
    report["touchTargetAudit"]["pageImagesWithKnownDimensions"] = len(image_dimensions_checked)

    report["checks"].update({
        "images": page_images_ok,
        "translations": translations_ok,
        "sentenceTranslations": sentence_translations_ok,
        "words": words_ok,
        "audio": audio_ok,
        "pageReview": review_ok,
        "theme": theme_ok,
        "themeBackground": theme_background_ok,
        "layout": layout_ok,
        "touchTargets": touch_targets_ok,
    })
    if not errors:
        report["status"] = "passed"
    write_report(root, report)
    return report


def write_report(root: Path, report: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    destination = root / "qa-report.json"
    temporary = destination.with_name(destination.name + ".part")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("book_json", type=Path)
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()
    report = validate_book(args.book_json, args.root)
    print(json.dumps({"status": report["status"], "pageCount": report["pageCount"], "errors": len(report["errors"]), "warnings": len(report["warnings"])}, ensure_ascii=False))
    if report["errors"]:
        print(json.dumps({"errors": report["errors"]}, ensure_ascii=False), file=sys.stderr)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
