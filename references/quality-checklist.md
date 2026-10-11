# Picture-book generation quality checklist

## Source pages

- [ ] Page count, ordering, and orientation match the source PDF.
- [ ] Every rendered page keeps the full original composition and aspect ratio.
- [ ] OCR text, reading order, punctuation, and word boxes were checked against the rendered page.
- [ ] Uncertain OCR is listed for review instead of silently corrected or invented.

## Theme and page layout

- [ ] The default landscape and portrait backgrounds are present in the offline package.
- [ ] The book theme was chosen from the cover, story, and representative inside pages, and `readerTheme.reason` records the evidence.
- [ ] The reader opens with the theme selected from the whole-book analysis, and the theme menu can switch among every bundled scene.
- [ ] If a custom theme image exists, it appears as “本书专属背景” in the theme menu and can be selected; if no custom image exists, all reading controls still work.
- [ ] The theme preset is allowed and suits the whole book; uncertain or mixed books use the neutral `storybook` preset.
- [ ] Any optional book-specific environment background comes from the whole-book theme analysis and contains no book/page, text, logo, or copied source-book characters.
- [ ] The background leaves the center open, frames the scene from the edges, and stays behind/outside the full source pages.
- [ ] The CSS-built cover, paper stack, gutter, and soft shadow make the reader look like a physical open book without altering source-page pixels.
- [ ] `presentation.pageMode` matches the PDF: `single`, `facing-pages`, or `source-spread`.
- [ ] Facing-page pairing preserves page order; covers, title pages, and end pages remain single; existing source spreads are never paired again.
- [ ] The local generated background and every fallback theme SVG are included in the generated reader package and work offline.

## Language and interactions

- [ ] Each English story page has a Chinese translation unless the source already provides one.
- [ ] Every English token belongs to one ordered sentence range with a matching Chinese translation.
- [ ] Every English body word has a hotspot aligned to the printed word on its source page; tapping it speaks that word and shows its contextual Chinese meaning in the bottom dock.
- [ ] Image hotspots align with their printed words at phone portrait and tablet landscape sizes.
- [ ] English narration highlights the matching word on the original page and updates the bottom dock to that sentence's translation.
- [ ] Word meanings, sentence playback, and sentence translation appear in the bottom dock; no right transcript sidebar appears.
- [ ] Sentence playback uses the matching audio range; previous/next sentence controls follow the page's reading order.
- [ ] Playback speed changes word, sentence, page, and book audio and stays selected across reloads when local storage is available.
- [ ] Page and book bilingual modes read each page's English, then its Chinese, before moving to the next page; missing clips are skipped.
- [ ] Stopping bilingual playback cancels the current clip and the rest of its queue.
- [ ] Starting a new word, sentence, page, or book action stops the previous audio.

## Audio and package

- [ ] English and Chinese voices are recorded in the manifest.
- [ ] Required MP3s are non-empty, playable, and match the requested text and voice settings.
- [ ] The reader does not start browser speech as a fallback.
- [ ] All images, scripts, styles, and audio resolve from local relative paths.
- [ ] The ZIP excludes the original PDF and includes only the rendered pages and generated book assets.
- [ ] `qa-report.json` says `passed` and contains no blocking errors.

## Devices and accessibility

- [ ] Source pages are not cropped at 360×800, 768×1024, and 1024×768.
- [ ] The book stage and bottom dock remain usable in portrait and landscape layouts.
- [ ] Navigation works with buttons, touch swipe, and keyboard arrows.
- [ ] Buttons have accessible names, images have alt text, focus is visible, and reduced-motion is honored.
- [ ] The first page does not autoplay audio.
