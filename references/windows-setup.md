# Windows setup and verification

Use these steps in Windows PowerShell from the project root. The commands use the virtual environment's Python directly, so PowerShell script activation is not required.

## Install the Skill and Python dependency

Install [Git for Windows](https://git-scm.com/download/win) and Python 3.11 or newer. In PowerShell, confirm Git and Python are available:

```powershell
git --version
py -3 --version
New-Item -ItemType Directory -Force .agents | Out-Null
New-Item -ItemType Directory -Force .agents\skills | Out-Null
git clone https://github.com/chaogevision/tapbook.git .agents\skills\tapbook

py -3 -m venv .venv-tapbook
$python = (Resolve-Path .venv-tapbook\Scripts\python.exe).Path
& $python -c "import sys; assert sys.version_info >= (3, 11), 'TapBook requires Python 3.11+'; print(sys.version)"
& $python -m pip install -r .agents\skills\tapbook\requirements.txt
& $python -c "from importlib.metadata import version; print(version('edge-tts'))"
```

The final command must print `7.3.1`. If PowerShell cannot find `py`, install Python from [python.org](https://www.python.org/downloads/windows/) and reopen the terminal. If `py -3` selects Python earlier than 3.11, install a newer version or select an installed one explicitly, for example `py -3.11`.

## Install Poppler and Tesseract

TapBook calls the Poppler commands `pdfinfo`, `pdftoppm`, and `pdftotext`, plus the Tesseract command `tesseract`. Install both tools separately from Python:

1. The Tesseract installation guide points Windows users to third-party builds from UB Mannheim. Install one using the [Tesseract installation guide](https://tesseract-ocr.github.io/tessdoc/Installation.html). Select the English language data (`eng`) during setup. For PDFs in another language, install its Tesseract language data too.
2. Download a Windows Poppler build from [poppler-windows releases](https://github.com/oschwartz10612/poppler-windows/releases/latest), extract it, and add the directory containing `pdfinfo.exe`, `pdftoppm.exe`, and `pdftotext.exe` to your user `PATH`.
3. Ensure the directory containing `tesseract.exe` is on `PATH`. To add either tool folder, open **Edit environment variables for your account**, edit the user `Path`, add the folder containing the executable, and save. Restart PowerShell and the agent app (WorkBuddy/Codex) after changing `PATH`.

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
& $edgeTts --voice "<English voice from --list-voices>" --text "Hello, world." --write-media "$env:TEMP\tapbook-tts-smoke-en.mp3"
& $edgeTts --voice "<Chinese voice from --list-voices>" --text "你好，欢迎使用。" --write-media "$env:TEMP\tapbook-tts-smoke-zh.mp3"
```

Replace both voice placeholders with names returned by `--list-voices`; run both short tests to verify English and Chinese synthesis. A failed request is a network/service result, separate from Poppler or OCR setup. It does not by itself prove that every mainland network needs a VPN. Do not mark audio generation complete unless TapBook produced the required audio and timings. The finished reader plays its packaged local MP3 files and does not need TTS access while reading.

## Run the TapBook build

Run these commands from the project root. Place your PDF at `.\input.pdf` or replace that path with your own. Keep quotes around paths, especially paths containing spaces or Chinese characters. Recreate these variables if you opened a new PowerShell session. Run each block separately; do not continue after a failing command. The checks below stop the current block when a native command returns a nonzero exit code:

```powershell
$python = (Resolve-Path .venv-tapbook\Scripts\python.exe).Path
$skill = (Resolve-Path .agents\skills\tapbook).Path

& $python "$skill\scripts\generate_audio.py" voices --locale en-US
if ($LASTEXITCODE -ne 0) { throw "English voice listing failed" }
& $python "$skill\scripts\generate_audio.py" voices --locale zh-CN
if ($LASTEXITCODE -ne 0) { throw "Chinese voice listing failed" }

& $python "$skill\scripts\render_pdf.py" ".\input.pdf" --output-dir ".\work\book" --dpi 150 --ocr-lang eng
if ($LASTEXITCODE -ne 0) { throw "PDF rendering or OCR failed" }
```

**Stop here to prepare the book.** Rendering produces page images, OCR and a render manifest, not `book.json`. Have the Agent follow the [build workflow](../SKILL.md#build-workflow) and [book schema](book.schema.json): inspect every source page and OCR, correct word boxes and text, add contextual meanings and sentence translations, choose the theme and page layout, and create `work\book\book.json`. Mark only checked pages as verified; resolve uncertainties before continuing. This is a review step, not an automatic conversion command. Then run the next block in the same session (or recreate `$python` and `$skill`).

```powershell
& $python "$skill\scripts\generate_audio.py" build ".\work\book\book.json" --root ".\work\book" --voice-en "<English voice from the list>" --voice-zh "<Chinese voice from the list>"
if ($LASTEXITCODE -ne 0) { throw "Audio generation failed" }
& $python "$skill\scripts\validate_book.py" ".\work\book\book.json" --root ".\work\book"
if ($LASTEXITCODE -ne 0) { throw "Validation failed; inspect work\book\qa-report.json" }
& $python "$skill\scripts\package_book.py" ".\work\book" --output-dir ".\output\book" --zip ".\output\book.zip"
if ($LASTEXITCODE -ne 0) { throw "Packaging failed" }
```

Replace both voice placeholders with actual names from the voice lists. Inspect `work\book\qa-report.json` and resolve all errors; its `status` must be `passed`. Packaging performs validation again. For another run, choose a new output directory and ZIP path. Alternatively, use `--replace-generated` only for an output directory previously generated by TapBook; the ZIP path may be replaced, so preserve any prior ZIP you need.

## Verify the packaged reader

Extract the ZIP into a new destination directory and open the extracted root `index.html` in a browser. For repeat checks choose another destination, or deliberately clear the old extraction first. The command opens the Windows default browser; if that is not Edge, open the file from Edge with Ctrl+O:

```powershell
Expand-Archive ".\output\book.zip" -DestinationPath ".\output\book-extracted"
Start-Process ".\output\book-extracted\index.html"
```

Follow the full reader QA in `SKILL.md`, including phone/tablet/iPad layouts and extracted `file://` use. At minimum, confirm a page image loads, tap short and adjacent words in both orders, verify word and sentence audio, playback speed, page navigation, bilingual English-then-Chinese playback, and theme switching. Repeat once with source and output paths containing spaces or Chinese characters.

This guide documents the Windows workflow; it is not evidence of a completed native Windows test. Record Windows and PowerShell versions, tool versions, and any failing command when reporting a Windows run.
