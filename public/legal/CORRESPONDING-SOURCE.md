# 对应源码归档说明

本目录记录 Open Office 使用的开源组件及其源码来源。许可证全文保存在同一 `legal/` 目录；应用完整说明见 `THIRD_PARTY_NOTICES.md`。这些说明不缩减任何上游许可赋予的权利。

## 已固定的源码

`corresponding-sources-manifest.json` 固定源码 URL、版本 / Git 提交、归档大小和 SHA-256。执行项目中的 `node scripts/fetch-corresponding-sources.mjs`，会获取以下已实际下载核验的源码：

1. LibreOffice / ZetaOffice 核心 `efaf0670b4d055f838a2849becb10f08aa06a257`。
2. Qt supermodule `3d440b7787f9b5ba15e5f8bcd7aef39b388f94fa`。
3. QtBase `a320678c85ec8029d5394bcd673d4c208af1de3a`。
4. Emscripten `949ee1d40467b80e90a9fdc67155d443426fef2d`。
5. zeta.js v1.2.0，提交 `57360bcb0e7726ffa0e66567c8041261b959f8dd`。
6. PyMuPDF 1.28.2 官方 PyPI sdist。
7. MuPDF 1.28.2 官方完整 source tarball，包含 `thirdparty/` 源码。
8. CPython 3.12.14 官方源码；这是此次本地运行时的实际版本。

下载器输出目录中的 `source-manifest.json` 是此清单的副本，`SHA256SUMS` 校验归档。归档总大小约 585 MiB。`--verify` / `--offline` 只使用已有归档；缺失或损坏时失败，不会通过网络补齐。`--out-dir` 可选择发行物的源码目录。

## WASM 来源与构建

ZetaOffice 上游 README 明确公开以下源分支：

- <https://git.libreoffice.org/core/+/refs/heads/distro/allotropia/zeta-24-2>
- <https://github.com/allotropia/qt5/tree/5.15.2%2Bwasm>
- <https://github.com/allotropia/qtbase/tree/5.15.2%2Bwasm>
- <https://github.com/allotropia/emscripten/commits/fixed-3.1.65>

分支会移动，因此发行材料采用清单中的完整提交号。LibreOffice 的固定提交直接取自所分发 `soffice.data` 内的 `versionrc`；QtBase 固定提交与 Qt supermodule 的 gitlink 相同。

`LIBREOFFICE-WASM-BUILD.md` 是固定核心提交中的 `static/README.wasm.md` 原文，说明了 Qt、WASM、Emscripten、配置和构建方法。其历史示例写有 Emscripten 3.1.46，而 ZetaOffice 当前公开分发说明指向 `fixed-3.1.65`；两份上游信息有时间差，不能将旧示例冒称为当前 CDN 的完整构建日志。

Qt GitHub supermodule 归档不会自动包含 submodule 内容。组装时把独立 QtBase 归档的内容放入 Qt supermodule 源码根目录的 `qtbase/`，并按上游说明仅构建所需模块。zeta.js 的本地变化在 `zetajs-local-change.patch`，应用源码中已包含修复后的 `public/office/zeta.js`。

LibreOffice Git 归档也不包含所有外部依赖 tarball。固定提交的 `download.lst` 另存为 `LIBREOFFICE-EXTERNAL-SOURCES.lst`。构建者应按实际配置执行上游获取外部依赖的步骤、核对列出的摘要，并把适用许可要求的对应源码及构建修改纳入最终源码发行。该文件同时列出可选组件，不能据此推断全部组件都在当前 WASM 中。

## PDF 运行时

`pdf-backend/engine.py`、Python requirements 和 `scripts/build-pdf-backend.mjs` 属于本应用源码的一部分，必须与相应发行版一起提供。PyMuPDF 的 `setup.py` 指向独立的 MuPDF source archive；因此这里只提供 PyMuPDF sdist 不够。MuPDF 的完整归档已另行固定。

原生构建若选择不同的 Python、PyInstaller 或底层库版本，必须更新对应源码 / 许可记录，不能拿 3.12.14 的源码来代表另一个 Python 版本。系统框架及可选构建依赖与实际链接库应以每个平台的构建产物为准。

## 发行材料的范围

建议将安装包、精确提交的应用源码、上游源码归档、许可证、修改补丁、构建脚本 / 配置、来源清单和校验文件放在同一发行页面，并允许接收者取得适用许可证要求的完整对应源码。无需把几百 MiB 的源码重复嵌入应用二进制。

本次已经核实核心 buildid、上游分支快照、归档字节与摘要，并保留了官方构建文档。上游未提供逐组件 CDN 构建 SBOM，本项目也尚未从这些源码逐字节重建该 CDN WASM。此源码快照集合不应被描述为已证明整个二进制发行物可重现，或替代对实际构建外部依赖的补齐。
