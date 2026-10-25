# Windows setup and verification

Use these steps in Windows PowerShell from the project root. The commands use the virtual environment's Python directly, so PowerShell script activation is not required.

## Install the Skill and Python dependency

Install Git and Python 3.11 or newer. In PowerShell:

```powershell
New-Item -ItemType Directory -Force .agents | Out-Null
New-Item -ItemType Directory -Force .agents\skills | Out-Null
git clone https://github.com/chaogevision/tapbook.git .agents\skills\tapbook

py -3.11 -m venv .venv-tapbook
$python = (Resolve-Path .venv-tapbook\Scripts\python.exe).Path
& $python -m pip install -r .agents\skills\tapbook\requirements.txt
& $python -c "from importlib.metadata import version; print(version('edge-tts'))"
```

The final command must print `7.3.1`. If PowerShell cannot find `py`, install Python from [python.org](https://www.python.org/downloads/windows/) and reopen the terminal.

## Install Poppler and Tesseract

TapBook calls the Poppler commands `pdfinfo`, `pdftoppm`, and `pdftotext`, plus the Tesseract command `tesseract`. Install both tools separately from Python:

1. The Tesseract installation guide points Windows users to third-party builds from UB Mannheim. Install one using the [Tesseract installation guide](https://tesseract-ocr.github.io/tessdoc/Installation.html). Select the English language data (`eng`) during setup. For PDFs in another language, install its Tesseract language data too.
2. Download a Windows Poppler build from [poppler-windows releases](https://github.com/oschwartz10612/poppler-windows/releases/latest), extract it, and add the directory containing `pdfinfo.exe`, `pdftoppm.exe`, and `pdftotext.exe` to your user `PATH`.
3. Ensure the directory containing `tesseract.exe` is on `PATH`. Restart PowerShell and WorkBuddy/Codex after changing `PATH`.

Check that all commands are discoverable and that the required OCR language is installed:

```powershell
Get-Command pdfinfo, pdftoppm, pdftotext, tesseract
tesseract --list-langs
```

The `eng` language must appear for the default `--ocr-lang eng` workflow. If any command is not found, correct `PATH` and reopen the terminal before continuing.

## Check Edge TTS connectivity

Audio generation contacts the online Edge TTS service. Test it from the same PowerShell/WorkBuddy environment that will run TapBook; a browser connection does not prove that a separate WorkBuddy runner can reach the service.

```powershell
$edgeTts = (Resolve-Path .venv-tapbook\Scripts\edge-tts.exe).Path
& $edgeTts --list-voices
& $edgeTts --voice en-US-AriaNeural --text "Hello, world." --write-media "$env:TEMP\tapbook-tts-smoke.mp3"
```

If that voice is unavailable, use a name returned by `--list-voices`. A failed request is a network/service result, separate from Poppler or OCR setup. It does not by itself prove that every mainland network needs a VPN. Do not mark audio generation complete unless TapBook produced the required audio and timings. The finished reader plays its packaged local MP3 files and does not need TTS access while reading.

## Run the TapBook build

Run these commands from the project root. Keep quotes around paths, especially paths containing spaces or Chinese characters. Recreate these variables if you opened a new PowerShell session:

```powershell
$python = (Resolve-Path .venv-tapbook\Scripts\python.exe).Path
$skill = (Resolve-Path .agents\skills\tapbook).Path

& $python "$skill\scripts\generate_audio.py" voices --locale en-US
& $python "$skill\scripts\generate_audio.py" voices --locale zh-CN

& $python "$skill\scripts\render_pdf.py" ".\input.pdf" --output-dir ".\work\book" --dpi 150 --ocr-lang eng
# Review all rendered pages and OCR, then create and review work\book\book.json.

& $python "$skill\scripts\generate_audio.py" build ".\work\book\book.json" --root ".\work\book" --voice-en "<English voice from the list>" --voice-zh "<Chinese voice from the list>"
& $python "$skill\scripts\validate_book.py" ".\work\book\book.json" --root ".\work\book"
& $python "$skill\scripts\package_book.py" ".\work\book" --output-dir ".\output\book" --zip ".\output\book.zip"
```

Replace both voice placeholders with actual names from the voice lists. Inspect the QA report; packaging is complete only when validation passes.

## Verify the packaged reader

Extract the ZIP, then open the extracted root `index.html` in Edge:

```powershell
Expand-Archive ".\output\book.zip" -DestinationPath ".\output\book-extracted"
Start-Process ".\output\book-extracted\index.html"
```

Confirm a page image loads, a tapped English word plays its local clip, sentence/page narration plays, page navigation works, and themes can be changed. Repeat once with a source PDF and output folder whose paths contain spaces or Chinese characters.

This guide documents the Windows workflow; it is not evidence of a completed native Windows test. Record Windows and PowerShell versions, tool versions, and any failing command when reporting a Windows run.
