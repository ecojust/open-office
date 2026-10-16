# Open Office — 第三方版权、许可与源码

Open Office 包含具有独立版权和许可的第三方软件。根目录 MIT `LICENSE` 适用于其注明的项目代码；各组件仍保留自己的版权、许可与免责条款。原始许可随应用保存在 [开源许可索引](index.html)，本项目不声称获得上游项目或商标所有者的背书。

## 当前编辑引擎

| 组件来源 | 固定提交 | 许可与本地集成 |
| --- | --- | --- |
| WordCraft | `3292ba05d3c15c003823be6849e87a1c6e205242` | MIT OR Apache-2.0；[来源与改动](wordcraft/OPEN-OFFICE-INTEGRATION.md) |
| GridCraft | `e6b6b349708ab4978cb3f061f6bd6ecbc25667cb` | MIT OR Apache-2.0；[来源与改动](gridcraft/OPEN-OFFICE-INTEGRATION.md) |
| DeckCraft | `9859da39255c0262cd592bb57101d7f2fa961f72` | MIT OR Apache-2.0；[来源与改动](deckcraft/OPEN-OFFICE-INTEGRATION.md) |
| PdfCraft | `f65f7330418e8121ebe59c01003da899340ceee9` | MIT OR Apache-2.0；[来源与改动](office-pdf/OPEN-OFFICE-INTEGRATION.md) |

四套编辑器源码及本地修改位于 `vendor/office-word`、`vendor/office-sheet`、`vendor/office-presentation`、`vendor/office-pdf`。各自的 `apps/open-office-host` 将 Rust 模型、读写和 egui 界面接入本地 WebAssembly；Vue/Tauri 负责文件、多标签、主题和保存保护。上游原始版权、双许可、NOTICE 和素材归属保留在对应目录，代码及产品标识的统一不改变其来源。受限 ArtCraft 品牌素材不分发；原始声明中相关引用仅描述上游。

当前产品已移除早期办公兼容运行时、PDF.js 及 Python/PyMuPDF/MuPDF 后台。历史发行物仍遵循对应版本的许可和源码声明。PDF 新内核使用上游的 hayro/lopdf 及其补丁，不声称全部解析代码由本项目原创。演示编辑器的 Symphonia 音频依赖采用 MPL-2.0，逐项来源和许可记录在依赖索引。

## 前端、依赖与素材

Vue 和 Tauri 的原始许可保留在 `npm`、`rust`。pdf-lib、fflate 和外部 Python PDF 检查器只用于开发测试，不进入产品编辑引擎。npm、原生 Rust 及四个 WASM 宿主各有依赖索引，精确版本由锁文件确定；清单中的开发或可选项不代表它们都进入每个平台安装包。

`craft-ui` 等真实共享依赖保持原始包名、固定提交和许可。其 git 来源不是可以随产品改名而伪造的 URL。各编辑器的依赖索引记录这些提交及对应声明。

共用字体来源、逐文件摘要和原始许可在 `assets/fonts/open-office`、`assets/fonts/deck` 及各编辑器法律说明中。文字/表格保留既有字体配置；演示/PDF 使用 LXGW WenKai 中文字体。egui 默认字体另有 OFL、Ubuntu Font Licence、MIT/Bitstream Vera 等许可。PDF 技术 CMaps、标准字体及颜色配置保持各自原始许可。原创应用 SVG 图标采用项目 MIT 许可；用户文档中的内容不属于应用图标替换范围。

## 源码和发行材料

发行页应提供精确提交的应用源码（包含四套编辑器本地修改）、锁文件、构建与安装脚本、来源清单及适用许可要求的依赖源码。固定来源与下载校验记录在 [`corresponding-sources-manifest.json`](corresponding-sources-manifest.json)，各组件的逐项源码链接见其依赖索引。`node scripts/fetch-corresponding-sources.mjs` 获取清单中的归档，`--verify` 或 `--offline` 核验已有内容。

只提供上游主页不等于已交付完整对应源码；具体组装说明见 [`CORRESPONDING-SOURCE.md`](CORRESPONDING-SOURCE.md)。第三方许可原文优先于此概述，软件按适用许可原样提供，不作保证。
