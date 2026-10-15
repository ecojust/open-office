# GridCraft source in Open Office

This source derives from [storytold/gridcraft](https://github.com/storytold/gridcraft/tree/e6b6b349708ab4978cb3f061f6bd6ecbc25667cb), commit `e6b6b349708ab4978cb3f061f6bd6ecbc25667cb` (workspace version `0.7.0`).

Copyright (c) 2026 ArtCraft Team and the GridCraft contributors. Upstream code is available under MIT OR Apache-2.0. The original `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, and `ATTRIBUTION.md` are retained.

Open Office adds its own WASM host and adapts the editor to the application's file operations and tab lifecycle. These modifications are part of the Open Office source distribution and Git history; the upstream commit does not describe the modified source alone. See `../../docs/gridcraft-integration.md` and `../../public/legal/gridcraft/source-manifest.json` for integration scope and source hashes.

The ArtCraft logo and mark image assets in `docs/brand/` have been removed as required for a modified distribution. Their original terms remain in `docs/brand/LICENSE-brand.txt`. Unchanged references in upstream notices describe the upstream asset set, not assets distributed by Open Office. Open Office is independent of ArtCraft and does not claim ownership or authorship of GridCraft's engine.

## Local asset attribution addendum

The local canvas/PDF integration references existing Open Office font files outside this vendored tree. Upstream `ATTRIBUTION.md` is retained unchanged; this table records the additional inputs:

| Files under `../../crates/word-engine/fonts/` | Authors / source | License |
| --- | --- | --- |
| `NotoSansCJKsc-Regular.otf`, `NotoSansCJKsc-Bold.otf` | Adobe and Noto contributors; extracted Simplified Chinese faces from the Noto CJK collection, with source hashes in that directory's `manifest.json` | SIL OFL 1.1, `LICENSE-Noto-CJK.txt` |
| `DejaVuSans.ttf`, `DejaVuSans-Bold.ttf`, `DejaVuSans-Oblique.ttf`, `DejaVuSans-BoldOblique.ttf` | Bitstream and DejaVu contributors; existing Open Office font inventory; the two oblique faces are used by the canvas, not the PDF adaptation | Bitstream Vera / DejaVu, `LICENSE-DejaVu.txt` |
| `NotoSansSymbols2-Regular.ttf` | Google and Noto contributors; existing Open Office font inventory | SIL OFL 1.1, `LICENSE-Noto-Core.txt` |

File hashes and license copies are distributed in `../../public/legal/gridcraft/`. The optional `storytold/craft-fonts` repository is not included.
