# Open Office — 第三方版权、许可与源码

Open Office 包含具有独立版权和许可的第三方软件。根目录 MIT `LICENSE` 适用于其注明的项目代码；集成发行包仍须遵守 PDF 内核的 AGPL 及其他组件许可，不能将整个安装包标为“全部 MIT”。原始许可随应用保存在 [`public/legal/`](index.html)，本项目不声称获得上游项目或商标所有者的背书。

## 当前编辑引擎

| 组件 | 固定来源 | 许可与本地集成 |
| --- | --- | --- |
| WordCraft | `3292ba05d3c15c003823be6849e87a1c6e205242` | MIT OR Apache-2.0；[来源、NOTICE、字体与改动](wordcraft/OPEN-OFFICE-INTEGRATION.md) |
| GridCraft | `e6b6b349708ab4978cb3f061f6bd6ecbc25667cb` | MIT OR Apache-2.0；[来源、NOTICE、字体与改动](gridcraft/OPEN-OFFICE-INTEGRATION.md) |
| DeckCraft | `9859da39255c0262cd592bb57101d7f2fa961f72` | MIT OR Apache-2.0；[许可及本地集成](deckcraft/OPEN-OFFICE-INTEGRATION.md) |

DeckCraft 的音频依赖 Symphonia 采用 MPL-2.0，原始许可及精确 crate 源码来源由其依赖索引记录。

三套编辑器源码随应用保存在 `vendor/`，各自的 `apps/open-office-host` 将 Rust 文档模型、格式读写和 egui 界面接入本地 WebAssembly 工作区。Vue/Tauri 负责文件、多标签、主题及保存保护。本项目保留上游版权、双许可、NOTICE 和资产归属，不将上游引擎声明为原创。受限 ArtCraft 品牌图片不分发；上游 NOTICE 中对它们的原始引用仅描述上游来源。

WordCraft 与 GridCraft 使用的 `craft-ui` 固定于 `storytold/craft-libs` 提交 `d27646a5f7c8b4fc85d9dd3213b8c88b58e0088d`，原始双许可和来源声明在 [wordcraft/craft-libs](wordcraft/craft-libs/NOTICE)。可选 `storytold/craft-fonts` 仓库不包含在本集成中。

旧 LibreOffice/ZetaOffice/Qt WASM 兼容内核、早期 TypeScript 文档引擎及自研 Rust Word IPC 内核已从当前应用移除。历史发布物仍以其对应版本的声明和源码为准。

## PDF、前端与原生运行时

| 组件 | 版本 | 许可与说明 |
| --- | --- | --- |
| PyMuPDF / MuPDF | 1.28.2 | GNU AGPL 第 3 版；[许可全文](AGPL-3.0.txt)，MuPDF 附带库、字体和编解码器另保留 `public/legal/mupdf/` 中各自许可。未购买商业授权。 |
| CPython | 固定源码记录为 3.12.14 | PSF 与历史 Python 许可；平台构建使用其他版本时必须提供匹配的许可和源码。 |
| PyInstaller | 6.16.0 | GPL 第 2 版及上游 bootloader 例外；例外不取消被打包组件的 AGPL 等要求。 |
| Vue | 3.5.22 | MIT，Evan You 与贡献者原始许可。 |
| PDF.js | 6.4.299 | Apache-2.0；CMaps、标准字体及 WASM 编解码器另保留 `public/legal/pdfjs/` 的版权许可。 |
| Tauri JavaScript API | 2.12.3 | Apache-2.0 OR MIT；原生依赖精确版本见 `src-tauri/Cargo.lock`。 |
| pdf-lib / fflate | 1.17.1 / 0.8.2 | MIT；仅用于开发、测试样例及独立导出校验，已不承担产品文档解析或 PDF 导出。 |

完整 npm 锁文件清单见 [`npm-dependencies.json`](npm-dependencies.json)，包括开发依赖及可选平台包，不表示每项都会进入安装包。原生 Rust 外部依赖见 [`rust-dependencies.json`](rust-dependencies.json)；WordCraft、GridCraft、DeckCraft 的 WASM normal/build 依赖分别记录于各自的依赖清单。原始许可保存在 `public/legal/npm/`、`public/legal/rust/`；已发布 crate 或上游许可来源的 URL、字节数及摘要在对应条目中记录。

## 字体与其他素材

共享字体资源已迁到 [`assets/fonts/open-office/`](wordcraft/fonts/open-office/manifest.json)，保留逐文件 SHA-256、来源、Noto 的 SIL OFL 1.1 及 DejaVu/Bitstream Vera 许可。WordCraft 与 GridCraft 的实际嵌入字体清单由各自来源和构建清单记录；保留字体文件不代表每个工作区都使用所有字重。

WordCraft 自带 Inter、JetBrains Mono、Source Sans 3、Source Serif 4 共 13 份字体，原始四份 OFL 在 `public/legal/wordcraft/fonts/`。其断词数据保留公有领域、CC0、MIT 或 BSD 的原始来源和作者声明。DeckCraft 的中文回退字体及许可证单独保存在 `assets/fonts/deck/` 和相应集成说明中。

egui 的 `epaint_default_fonts` 内嵌 Noto Emoji、Ubuntu Light、Hack 和 emoji-icon-font，分别适用 OFL、Ubuntu Font Licence、MIT/Bitstream Vera/DejaVu 等许可；原文在 `public/legal/rust/epaint_default_fonts@0.36.2/fonts/`。这组字体不保证完整或彩色 emoji 覆盖。PDF.js 内的 Liberation/Foxit 字体、Adobe CMaps、OpenJPEG、JBIG2、QCMS 也各有许可，不能只保留 PDF.js 顶层 LICENSE。

## 对应源码与构建材料

[`corresponding-sources-manifest.json`](corresponding-sources-manifest.json) 固定当前 PDF 内核的 PyMuPDF、MuPDF 和 CPython 三份源码归档、URL、大小及 SHA-256。下载器不会执行归档内容或自动接受变化的摘要：

```sh
node scripts/fetch-corresponding-sources.mjs
node scripts/fetch-corresponding-sources.mjs --verify
node scripts/fetch-corresponding-sources.mjs --offline --out-dir /path/to/sources
```

每个发行版须同时提供精确应用提交的源码、三套编辑器的本地修改、锁文件、构建与安装材料，以及适用许可要求的依赖源码。仅提供下载脚本或上游主页不等于已交付完整对应源码。原生 Python 版本和底层库须与实际发布包匹配；具体组装范围见 [对应源码说明](CORRESPONDING-SOURCE.md)。组件原始许可优先于本概述，软件按适用许可原样提供，不作保证。
