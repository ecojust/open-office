# Shared document fonts

These fonts are shared build inputs for the active Rust document and spreadsheet
editors. They live outside any retired editor crate. Each editor selects the faces
needed by its UI, document renderer and PDF export; the individual editor's font
fallback and shaping behavior applies.

| Files | Source | License |
| --- | --- | --- |
| `DejaVuSans*.ttf` | Debian `fonts-dejavu-core`, unmodified files | [Bitstream Vera / DejaVu notices](LICENSE-DejaVu.txt) |
| `NotoSansSymbols2-Regular.ttf` | Debian `fonts-noto-core`, unmodified file | [SIL Open Font License 1.1 and notices](LICENSE-Noto-Core.txt) |
| `NotoSansCJKsc-*.otf` | Debian `fonts-noto-cjk`, SC face 2 extracted from Regular/Bold TTC | [SIL Open Font License 1.1 and notices](LICENSE-Noto-CJK.txt) |

`manifest.json` records source paths, source collection hashes, final font hashes,
and sizes. Both CJK weights retain the complete Simplified Chinese face, including
its original glyph set. The move to this directory does not modify font bytes or
license texts. These fonts do not guarantee support for every Unicode glyph or
color emoji.

To reproduce extraction with the recorded Debian packages and fontTools:

```sh
python3 assets/fonts/open-office/extract.py
```

The script preserves input font timestamps. FontTools serialization can vary
between versions; verify the emitted manifest when updating font tooling.
