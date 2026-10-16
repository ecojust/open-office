# Shared interface fonts

The shell, notebook and four Rust editor interfaces use **Inter Regular / SemiBold**
from `../deck` and **WenQuanYi Micro Hei Regular** from this directory. UI body and
control text is 13px, supporting text 11px and dialog headings 18px. The Chinese
face has one real weight; it is reused for both interface weights without synthetic
bold. These settings do not replace document fonts or font previews.

WenQuanYi Micro Hei 0.2.0-beta is distributed under its **Apache-2.0** option.
The original release notes, complete contributors list and both upstream licence
texts are retained. The release notes include the punctuation attribution and
BSD-style notice for Wada Laboratory / Electronic Font Open Laboratory.

**Local modification:** the proportional face (index 0) was extracted from the
upstream TTC to a standalone TTF. Glyph outlines, coverage and original font
notices were not modified. `manifest.json` records the source, extraction tool,
hashes and licence choice. Reproduce with `extract.py` and the pinned archive.

The browser uses this same local TTF and the same Inter files as the Rust
interfaces. No online font service or installed system font is required.
