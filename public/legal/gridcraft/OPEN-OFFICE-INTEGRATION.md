# GridCraft in Open Office

Open Office integrates the Rust spreadsheet engine and egui interface from [GridCraft](https://github.com/storytold/gridcraft/tree/e6b6b349708ab4978cb3f061f6bd6ecbc25667cb), fixed at commit `e6b6b349708ab4978cb3f061f6bd6ecbc25667cb` (upstream workspace version `0.7.0`).

Copyright (c) 2026 ArtCraft Team and the GridCraft contributors. The original [MIT](LICENSE-MIT), [Apache-2.0](LICENSE-APACHE), [NOTICE](NOTICE), and [asset attribution](ATTRIBUTION.md) are preserved unchanged. Upstream code is offered under MIT OR Apache-2.0; dependencies and assets retain their own licenses. Open Office is an independent integration and is not an official ArtCraft or GridCraft distribution.

## Local modifications

The source is in `vendor/office-sheet/`. Open Office adds `apps/open-office-host` and a local WebAssembly bridge, adapts the editing interface to the host shell, and coordinates tabs, file import/export and successful-save acknowledgements. The application shell owns file pickers, save destinations and document closing. Local application and crate identifiers use Open Office names; original copyrights, legal notices, shared dependency identities and source URLs are retained. The Open Office source commit records the local changes; the upstream commit alone is not a description of the modified executable.

ArtCraft logo and mark image assets have been removed from `docs/brand/` under the upstream [brand terms](LICENSE-brand.txt). Those terms do not grant a modified product the right to use ArtCraft's marks. The unchanged upstream NOTICE and attribution still describe those upstream assets; they do not imply that Open Office includes them or is endorsed by ArtCraft.

## Dependencies

`craft-ui` is fixed to [craft-libs commit `d27646a5f7c8b4fc85d9dd3213b8c88b58e0088d`](https://github.com/storytold/craft-libs/tree/d27646a5f7c8b4fc85d9dd3213b8c88b58e0088d), the same revision used by Open Office's document editor. Its dual licenses, NOTICE and attribution are preserved in [the shared craft-libs legal directory](../wordcraft/craft-libs/NOTICE). The NOTICE retains provenance of code adapted from other Craft projects.

The optional `storytold/craft-fonts` checkout is not used. egui's built-in fonts have separate licenses, preserved under `../rust/epaint_default_fonts@0.36.2/fonts/`: Noto Emoji (OFL-1.1), Ubuntu Light (Ubuntu Font Licence 1.0), Hack (MIT / Bitstream Vera / DejaVu), and emoji-icon-font (MIT). These assets must not be described collectively as MIT-only.

The shared font source directory is `assets/fonts/open-office/`. The local canvas additionally embeds Open Office's Noto Sans CJK SC Regular and Bold, DejaVu Sans Regular, Bold, Oblique and Bold Oblique, and Noto Sans Symbols2 Regular. The PDF adaptation uses the same regular/bold and Symbols2 faces, without the two oblique faces. The exact embedded source files are listed in [source-manifest.json](source-manifest.json). The shared [font inventory](fonts/manifest.json) retains source hashes and CJK face extraction details. Original [Noto CJK OFL](fonts/LICENSE-Noto-CJK.txt), [Noto Symbols2 OFL](fonts/LICENSE-Noto-Core.txt), and [DejaVu / Bitstream Vera](fonts/LICENSE-DejaVu.txt) notices are preserved. Embedding font subsets in PDF does not change their licensing or guarantee complete script/emoji coverage.

The [source manifest](source-manifest.json) records original source and license hashes, not a guarantee of format fidelity or verification of every upstream function. The separate [WASM dependency inventory](../gridcraft-dependencies.json) records the host's normal/build dependency closure. The active PDF and other dependencies retain their own license and corresponding-source obligations in the combined distribution.
