# Embedded outline fonts

These exact font bytes are compiled into the Rust engine with `include_bytes!`.
Native and WASM layout use the same shaping, metrics and outlines. The UI receives
SVG paths and does not load system or web fonts to render document text.

| Files | Source | License |
| --- | --- | --- |
| `DejaVuSans*.ttf` | Debian `fonts-dejavu-core`, unmodified files | [Bitstream Vera / DejaVu notices](LICENSE-DejaVu.txt) |
| `NotoSansSymbols2-Regular.ttf` | Debian `fonts-noto-core`, unmodified file | [SIL Open Font License 1.1 and notices](LICENSE-Noto-Core.txt) |
| `NotoSansCJKsc-*.otf` | Debian `fonts-noto-cjk`, SC face 2 extracted from Regular/Bold TTC | [SIL Open Font License 1.1 and notices](LICENSE-Noto-CJK.txt) |

`manifest.json` records source paths, source collection hashes, final font hashes,
and sizes. The CJK files retain the complete SC face and its original glyph set;
they are not reduced to characters present in tests or examples. Only the SC face
is bundled rather than all ten faces of each TTC. Total font bytes are about
35.1 MiB; both CJK weights are included to render real Chinese bold outlines.

Fallback order is the requested regular/bold/oblique/bold-oblique DejaVu face,
the regular/bold Noto Sans CJK SC face, then regular DejaVu and Noto Sans Symbols2
for monochrome emoji missing from a styled face. CJK italic uses a 12-degree outline shear because
these CJK families have no italic face. There is no silent browser fallback.

Available monochrome emoji such as U+1F600 (😀), U+1F30D (🌍), and U+1F44D (👍) are supported. Missing emoji,
variation selectors, ZWJ sequences and unsupported scripts produce a layout error
before an edit is committed. Color/bitmap emoji are outside this outline-only
phase. Latin common/discretionary ligatures are disabled; kerning and combining
marks remain shaped by rustybuzz.

To reproduce extraction on a machine with those Debian packages and fontTools:

```sh
python3 crates/word-engine/fonts/extract.py
```

The script preserves the input font timestamps. FontTools serialization can vary
between versions; verify the emitted manifest when updating font tooling.
