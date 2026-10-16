# WordCraft in Open Office

Open Office integrates WordCraft's Rust document engine and egui `WordApp` interface, pinned to upstream commit `3292ba05d3c15c003823be6849e87a1c6e205242`:

https://github.com/storytold/wordcraft/tree/3292ba05d3c15c003823be6849e87a1c6e205242

Copyright (c) 2026 ArtCraft Team and the WordCraft contributors. WordCraft is available under MIT OR Apache-2.0. The original [MIT](LICENSE-MIT), [Apache-2.0](LICENSE-APACHE), [NOTICE](NOTICE) and [asset attribution](ATTRIBUTION.md) are distributed unchanged. Open Office is an independent integration, not an official ArtCraft or WordCraft distribution, and does not claim authorship of the upstream engine or interface.

## Local integration

The upstream source is in `vendor/office-word/`. Open Office adds `apps/open-office-host`, a WASM bridge for the Vue/Tauri application shell, local document lifecycle and save coordination, a reproducible build entry point, and adaptation of the canvas interface to the host. Local changes to vendored files are included in the Open Office source distribution and tracked in its Git history. The generated `public/office-word/manifest.json` records the build inputs and artifact hashes; the upstream commit alone does not describe these local changes.

The restricted ArtCraft brand files under upstream `docs/brand/` are not copied or distributed. References to those files in the unchanged upstream NOTICE and attribution describe the upstream repository; they do not mean those assets are present here. Upstream agent instruction files are also not included. Original copyright notices are retained.

## Dependencies and assets

- `craft-ui` comes from [craft-libs](https://github.com/storytold/craft-libs/tree/d27646a5f7c8b4fc85d9dd3213b8c88b58e0088d), pinned to `d27646a5f7c8b4fc85d9dd3213b8c88b58e0088d`, MIT OR Apache-2.0. Its [NOTICE](craft-libs/NOTICE) retains the provenance of adapted source from the other Craft projects. Both licenses and its attribution are in `craft-libs/`.
- WordCraft bundles 13 font faces from Inter, JetBrains Mono, Source Sans 3 and Source Serif 4. The four original SIL OFL 1.1 texts are in `fonts/`; authors and upstream locations are retained in ATTRIBUTION.md. The file names, sizes and hashes are in [source-manifest.json](source-manifest.json).
- This integration also embeds Open Office's existing Noto Sans CJK SC Regular and Bold for Chinese document text and interface labels. Their source TTC hashes, extracted-face hashes and byte counts are retained in [fonts/open-office/manifest.json](fonts/open-office/manifest.json); the original OFL and copyright are in [LICENSE-Noto-CJK.txt](fonts/open-office/LICENSE-Noto-CJK.txt). DejaVu Sans Regular and Noto Sans Symbols2 Regular are additionally shared for selected monochrome emoji and symbols, under the original DejaVu/Bitstream Vera and OFL notices in the same directory. This is not full or color emoji support. The inventory covers the shared assets in `assets/fonts/open-office/`; individual editors select the faces they embed.
- The optional upstream `storytold/craft-fonts` checkout is not used. Upstream NOTICE references to Japanese font bundles remain unmodified and are not a claim that this integration includes those bundles.
- The egui dependency `epaint_default_fonts` also carries its own embedded fonts: Noto Emoji (OFL-1.1), Ubuntu Light (Ubuntu Font Licence 1.0), Hack (MIT, Bitstream Vera and DejaVu notices), and emoji-icon-font (MIT). The original font notices are preserved under `../rust/epaint_default_fonts@0.36.2/fonts/`, separately from the code's MIT OR Apache-2.0 licenses. Their hashes are recorded in the WASM dependency inventory; these fonts must not be described collectively as MIT-only.
- English hyphenation data derives from Grady Ward's public-domain Moby list; the trained patterns are CC0-1.0. The Polish, Portuguese and Italian pattern sources carry their own MIT or BSD-3-Clause notices. Their original files, including notices, are preserved in `hyphenation/`; authors, source URLs and source hashes remain in ATTRIBUTION.md.
- Other Rust dependencies keep their own licenses. The separate [WordCraft WASM dependency inventory](../wordcraft-dependencies.json) records the host's normal and build dependencies for `wasm32-unknown-unknown`, with exact versions and license paths under `rust/`. Where a published crate omitted its license text, `upstreamLicenseEvidence` identifies the original license at the commit recorded in that crate's `.cargo_vcs_info.json`, including the URL, byte count and SHA-256. The native Tauri `rust-dependencies.json` remains separate; WordCraft's dual license does not replace dependency licenses.

The source and license manifest is a provenance record, not a complete platform linkage report or a claim of compatibility with every Word feature. The active PDF and other dependencies retain their own license and corresponding-source obligations in the combined Open Office distribution.
