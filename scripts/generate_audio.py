#!/usr/bin/env python3
"""Generate local Edge TTS word and page audio, with resumable content caching."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import string
import sys
import time
import unicodedata
from pathlib import Path


TICKS_PER_SECOND = 10_000_000
WORD_EDGE_PUNCTUATION = string.punctuation + "“”‘’—–…"
TOKEN_RE = re.compile(r"[^\W_]+(?:[’'][^\W_]+)*(?:-[^\W_]+)*", re.UNICODE)


def normalize_text(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def clean_word(text: str) -> str:
    return unicodedata.normalize("NFKC", text).strip().strip(WORD_EDGE_PUNCTUATION).strip()


def cache_key(text: str, voice: str, rate: str, volume: str, pitch: str) -> str:
    payload = json.dumps(
        {
            "provider": "edge-tts",
            "text": normalize_text(text),
            "voice": voice,
            "rate": rate,
            "volume": volume,
            "pitch": pitch,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def text_hash(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def text_tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text).replace("’", "'")
    return [token.casefold() for token in TOKEN_RE.findall(normalized)]


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def relative_asset_path(root: Path, value: str) -> Path:
    candidate = (root / value).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"asset path escapes book root: {value}") from exc
    return candidate


def boundary_seconds(message: dict) -> dict | None:
    text = normalize_text(str(message.get("text", "")))
    try:
        offset = float(message.get("offset")) / TICKS_PER_SECOND
        duration = float(message.get("duration")) / TICKS_PER_SECOND
    except (TypeError, ValueError):
        return None
    if not text or offset < 0 or duration <= 0:
        return None
    return {"text": text, "start": round(offset, 6), "duration": round(duration, 6)}


def load_book(book_path: Path, root: Path) -> dict:
    try:
        book = json.loads(book_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read book JSON: {exc}") from exc
    if not isinstance(book, dict) or not isinstance(book.get("pages"), list):
        raise ValueError("book JSON must contain a pages array")
    if not book.get("title"):
        raise ValueError("book JSON must have a title")
    if book_path.resolve() != (root / "book.json").resolve():
        raise ValueError("book JSON must be stored as book.json inside --root")
    return book


def make_jobs(book: dict, settings: dict) -> tuple[list[dict], dict[int, dict]]:
    jobs_by_key: dict[str, dict] = {}
    page_jobs: dict[int, dict] = {}

    def add_job(kind: str, text: str, voice: str, rel_path: str, page_index: int | None = None) -> dict:
        spoken_text = normalize_text(text)
        key = cache_key(spoken_text, voice, settings["rate"], settings["volume"], settings["pitch"])
        identity = f"{kind}:{key}"
        existing = jobs_by_key.get(identity)
        if existing is not None:
            return existing
        job = {
            "cacheKey": key,
            "kind": kind,
            "text": spoken_text,
            "voice": voice,
            "path": rel_path,
            "textHash": text_hash(spoken_text),
            "pageIndex": page_index,
        }
        jobs_by_key[identity] = job
        return job

    for page in book["pages"]:
        index = int(page["index"])
        page_jobs[index] = {}
        for word in page.get("words", []):
            spoken = clean_word(str(word.get("text", "")))
            if not spoken:
                continue
            canonical = spoken.casefold()
            key = cache_key(canonical, settings["voiceEn"], settings["rate"], settings["volume"], settings["pitch"])
            rel_path = f"audio/words/en/{key[:24]}.mp3"
            job = add_job("word", canonical, settings["voiceEn"], rel_path)
            word["audio"] = job["path"]

        english_text = normalize_text(str(page.get("enText", "")))
        if english_text:
            rel_path = f"audio/pages/en-{index:03d}.mp3"
            job = add_job("english-page", english_text, settings["voiceEn"], rel_path, index)
            page["englishAudio"] = job["path"]
            page_jobs[index]["english"] = job
        else:
            page["englishAudio"] = None

        chinese_text = normalize_text(str(page.get("zhText", "")))
        if chinese_text:
            rel_path = f"audio/pages/zh-{index:03d}.mp3"
            job = add_job("chinese-page", chinese_text, settings["voiceZh"], rel_path, index)
            page["chineseAudio"] = job["path"]
            page_jobs[index]["chinese"] = job
        else:
            page["chineseAudio"] = None
    return list(jobs_by_key.values()), page_jobs


def prior_entry(cache: dict, job: dict, root: Path) -> dict | None:
    entry = cache.get("files", {}).get(job["path"])
    if not isinstance(entry, dict) or entry.get("cacheKey") != job["cacheKey"]:
        return None
    try:
        path = relative_asset_path(root, job["path"])
    except ValueError:
        return None
    if not path.is_file() or path.stat().st_size == 0:
        return None
    if job["kind"] == "english-page":
        timings = entry.get("wordTimings", [])
        cached_tokens = [token for timing in timings if isinstance(timing, dict) for token in text_tokens(str(timing.get("text", "")))]
        if cached_tokens != text_tokens(job["text"]):
            return None
    return entry


async def synthesize(edge_tts, job: dict, root: Path, settings: dict, retries: int) -> dict:
    output = relative_asset_path(root, job["path"])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".part")
    last_error = None
    for attempt in range(retries):
        try:
            audio_chunks = []
            timings = []
            communicate = edge_tts.Communicate(
                job["text"],
                job["voice"],
                rate=settings["rate"],
                volume=settings["volume"],
                pitch=settings["pitch"],
                boundary="WordBoundary",
            )
            async for message in communicate.stream():
                if message.get("type") == "audio":
                    audio_chunks.append(message.get("data", b""))
                elif message.get("type") == "WordBoundary":
                    boundary = boundary_seconds(message)
                    if boundary:
                        timings.append(boundary)
            audio_bytes = b"".join(audio_chunks)
            if not audio_bytes:
                raise RuntimeError("Edge TTS returned empty audio")
            temporary.write_bytes(audio_bytes)
            if temporary.stat().st_size == 0:
                raise RuntimeError("Edge TTS returned empty audio")
            os.replace(temporary, output)
            return {
                "cacheKey": job["cacheKey"],
                "textHash": job["textHash"],
                "kind": job["kind"],
                "voice": job["voice"],
                "bytes": output.stat().st_size,
                "wordTimings": timings,
            }
        except Exception as exc:  # upstream failures vary and should become a QA error, not a traceback
            last_error = exc
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            if attempt + 1 < retries:
                await asyncio.sleep(0.25 * (2**attempt))
        finally:
            if temporary.exists():
                try:
                    temporary.unlink()
                except OSError:
                    pass
    raise RuntimeError(str(last_error or "Edge TTS synthesis failed"))


async def synthesize_jobs(edge_tts, jobs: list[dict], root: Path, settings: dict, old_cache: dict, concurrency: int, retries: int):
    semaphore = asyncio.Semaphore(concurrency)
    results: dict[str, dict] = {}
    errors: list[dict] = []

    async def process(job: dict) -> None:
        cached = prior_entry(old_cache, job, root)
        if cached:
            results[job["path"]] = cached
            return
        async with semaphore:
            try:
                result = await synthesize(edge_tts, job, root, settings, retries)
                results[job["path"]] = result
            except Exception as exc:
                errors.append({"code": "tts_failed", "task": job["kind"], "path": job["path"], "message": str(exc)[:300]})

    await asyncio.gather(*(process(job) for job in jobs))
    return results, errors


def list_voices(edge_tts, locale: str) -> dict:
    voices = []
    for voice in asyncio.run(edge_tts.list_voices()):
        if locale and str(voice.get("Locale", "")).casefold() != locale.casefold():
            continue
        voices.append({
            "shortName": voice.get("ShortName", ""),
            "locale": voice.get("Locale", ""),
            "gender": voice.get("Gender", ""),
        })
    voices.sort(key=lambda item: (item["gender"], item["shortName"]))
    return {"ok": True, "voices": voices}


async def build_audio(book: dict, book_path: Path, root: Path, args, edge_tts) -> dict:
    settings = {
        "voiceEn": args.voice_en,
        "voiceZh": args.voice_zh,
        "rate": args.rate,
        "volume": args.volume,
        "pitch": args.pitch,
    }
    if not settings["voiceEn"] or not settings["voiceZh"]:
        raise ValueError("both --voice-en and --voice-zh are required")
    if args.concurrency < 1 or args.concurrency > 8:
        raise ValueError("--concurrency must be between 1 and 8")
    if args.retries < 1 or args.retries > 6:
        raise ValueError("--retries must be between 1 and 6")

    cache_path = root / "audio/manifest.json"
    try:
        old_cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.is_file() else {}
    except json.JSONDecodeError:
        old_cache = {}

    jobs, page_jobs = make_jobs(book, settings)
    results, errors = await synthesize_jobs(edge_tts, jobs, root, settings, old_cache, args.concurrency, args.retries)

    for page in book["pages"]:
        index = int(page["index"])
        english_job = page_jobs[index].get("english")
        if english_job:
            entry = results.get(english_job["path"], {})
            page["wordTimings"] = entry.get("wordTimings", [])
        else:
            page["wordTimings"] = []
    book["voices"] = {"en": args.voice_en, "zh": args.voice_zh}
    atomic_json(book_path, book)

    manifest = {
        "schemaVersion": 1,
        "provider": "edge-tts",
        "voices": {"en": args.voice_en, "zh": args.voice_zh},
        "settings": {"rate": args.rate, "volume": args.volume, "pitch": args.pitch},
        "files": results,
        "errors": errors,
    }
    atomic_json(cache_path, manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command")
    voices = subparsers.add_parser("voices", help="list currently available voices")
    voices.add_argument("--locale", default="en-US")

    build = subparsers.add_parser("build", help="generate local audio for a book")
    build.add_argument("book_json", type=Path)
    build.add_argument("--root", required=True, type=Path)
    build.add_argument("--voice-en", required=True)
    build.add_argument("--voice-zh", required=True)
    build.add_argument("--rate", default="-8%")
    build.add_argument("--volume", default="+0%")
    build.add_argument("--pitch", default="+0Hz")
    build.add_argument("--concurrency", type=int, default=2)
    build.add_argument("--retries", type=int, default=3)
    args = parser.parse_args()
    if args.command is None:
        parser.error("choose 'voices' or 'build'")
    try:
        import edge_tts
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "edge-tts-not-installed", "detail": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2

    try:
        if args.command == "voices":
            print(json.dumps(list_voices(edge_tts, args.locale), ensure_ascii=False))
            return 0
        root = args.root.expanduser().resolve()
        book_path = args.book_json.expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f"book root does not exist: {root}")
        book = load_book(book_path, root)
        manifest = asyncio.run(build_audio(book, book_path, root, args, edge_tts))
        summary = {"ok": not manifest["errors"], "audioFiles": len(manifest["files"]), "errors": len(manifest["errors"])}
        print(json.dumps(summary, ensure_ascii=False))
        if manifest["errors"]:
            print(json.dumps({"errors": manifest["errors"]}, ensure_ascii=False), file=sys.stderr)
        return 0 if summary["ok"] else 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:500]}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
