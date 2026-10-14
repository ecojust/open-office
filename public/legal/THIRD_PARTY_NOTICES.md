# Open Office — 第三方版权、许可与源码

本应用包含具有独立版权和许可的第三方软件。根目录 `LICENSE` 适用于其注明的项目代码，不替代以下组件的许可。本发行物包含 AGPL、GPL、MPL 和 LGPL 组件，不能将整个安装包标为“全部 MIT”。本项目未购买或假定持有 Artifex、Qt 或 ZetaOffice 的商业授权。

完整许可随网页和桌面资源放在 [`public/legal/`](public/legal/index.html)。这些组件按各自许可原样提供，不作保证；商标仍归原权利人所有。Open Office 不是 Apache OpenOffice、LibreOffice、Artifex 或 Qt 的官方产品，也未声称获得其背书。

## 主要运行时

| 组件 | 实际版本或构建 | 使用的许可与说明 |
| --- | --- | --- |
| ZetaOffice / LibreOffice WASM | 24.2.8.0；核心构建 `efaf0670b4d055f838a2849becb10f08aa06a257` | LibreOffice 的 MPL-2.0、LGPL-3.0 及各文件许可；完整上游法律文档保留在 `LIBREOFFICE-THIRD-PARTY-LICENSES.html`。WASM 与 Qt 静态组合还包含下述 GPL 代码。 |
| Qt 5 / QtBase WASM 分支 | `5.15.2+wasm` | **WASM 平台插件采用 GPL 第 3 版**，并保留 Qt 原文规定的后续版本选项；不能仅以 Qt 其他部分的 LGPL 掩盖该要求。插件原文见 `QT-WASM-LICENSE-HEADER.txt`，全文见 `GPL-3.0.txt`。其余组件仍按各文件许可。 |
| zeta.js | v1.2.0，提交 `57360bcb0e7726ffa0e66567c8041261b959f8dd` | MIT，Copyright © 2024 allotropia software GmbH and contributors。本地修复 `getSingleton` 返回值转换，并补充 UNO `TYPEDEF` 别名递归解析（含异常路径的类型描述句柄释放）；完整差异保存在 `zetajs-local-change.patch`，上游版权与许可保持不变。 |
| Emscripten | allotropia `fixed-3.1.65`，提交 `949ee1d40467b80e90a9fdc67155d443426fef2d` | MIT / University of Illinois NCSA 双许可及内含库各自许可；见 `EMSCRIPTEN-LICENSE.txt`。 |
| PyMuPDF | 1.28.2 | 采用免费开源的 GNU AGPL 第 3 版授权。Artifex 的商业授权是另一条独立授权途径，本项目不使用该途径。完整原文来自此版本官方 sdist 的 `COPYING`，见 `AGPL-3.0.txt`。 |
| MuPDF | 1.28.2，与 PyMuPDF 实测版本一致 | GNU AGPL 第 3 版；其第三方源代码、字体和编解码库另保留各自许可，见 `mupdf/`。PyMuPDF 的源码压缩包**不包含** MuPDF 全部 C/C++ 源码，因此源码下载脚本单独包含 MuPDF 完整源码包。 |
| CPython | 本次本地运行时为 3.12.14 | Python Software Foundation 与历史 Python 许可，见 `PYTHON-LICENSE.txt`。原生平台构建若使用其他 Python 版本，须保留该实际版本的许可与源码。 |
| PyInstaller | 6.16.0 | GPL 第 2 版及上游明确的 bootloader 例外；例外使打包产物可按其自身许可分发，但不取消 PyMuPDF 等组件的 AGPL 要求。见 `PYINSTALLER-COPYING.txt`。 |

对于采用 AGPL/GPL 的组合作品，应在相应许可条件下提供其完整对应源码、修改内容与构建安装所需材料，不能仅提供 Python 调用脚本或一个动态变化的上游主页地址。使用原版第三方文件并不自动免除其分发义务。若将适用 AGPL 条款的修改版本提供为网络服务，还须遵守该许可中面向远程用户提供源码的条款。

## 前端、字体与本地桥接

| 组件 | 版本 | 许可 / 版权记录 |
| --- | --- | --- |
| Vue | 3.5.22 | MIT；包含 Evan You 及 Vue 贡献者的原始许可。 |
| PDF.js | 6.4.299 | Apache-2.0；保留 Mozilla Foundation 的许可。离线 CMaps、标准字体及 WASM 编解码器另见 `pdfjs/` 下的原始许可。 |
| pdf-lib | 1.17.1 | MIT；用于独立演示文稿的本地向量 PDF 导出，原始许可见 `npm/pdf-lib@1.17.1/LICENSE.md`。 |
| @pdf-lib/fontkit | 1.1.1 | 包声明 MIT；用于中文字体嵌入与子集化，保留包内 README 许可声明及作者/贡献者元数据于 `npm/@pdf-lib__fontkit@1.1.1/`。 |
| fflate | 0.8.2 | MIT；Copyright © 2023 Arjun Barrett。用于本地 PPTX ZIP 解压与原位包编辑，原始许可见 `npm/fflate@0.8.2/LICENSE`。 |
| Noto Sans CJK SC Regular | 文件 SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b` | SIL Open Font License 1.1；字体内版权为 © 2014–2021 Adobe。见 `NOTO-CJK-NOTICE.txt` 与 `OFL-1.1.txt`。 |
| Tauri JavaScript API | 2.12.3 | Apache-2.0 OR MIT；两份原始文本均保留。 |
| Rust / Tauri 原生依赖 | 以 `src-tauri/Cargo.lock` 为准 | 多数为 MIT / Apache-2.0；另有 MPL、BSD、ISC 等。逐项表达式和原始许可见 `rust-dependencies.json`、`rust/`。 |

完整 npm 清单见 `npm-dependencies.json`，包括锁文件中的开发依赖、可选平台包和完整性摘要；`npm/` 保存已安装软件包的原始版权与许可。Rust 清单包含整个锁文件中的平台和构建依赖，**并不表示每一个包都链接进每个平台的应用**。未安装的 npm 平台二进制包使用其发行包元数据记录，不冒称已经检查其本地内容。最终原生发布仍应以各平台实际运行时清单核对附加库。

PDF.js 资产的许可证并不全是 Apache-2.0：例如 Liberation 标准字体采用 OFL，Foxit 标准字体、Adobe CMaps、OpenJPEG、JBIG2 和 QCMS 各有对应的版权文本。这些文件已原样保留，不能仅保留 PDF.js 顶层 LICENSE。

## 对应源码与复现依据

固定源码、下载地址、字节数、SHA-256 和关联证据保存在 [`public/legal/corresponding-sources-manifest.json`](public/legal/corresponding-sources-manifest.json)。执行：

```sh
node scripts/fetch-corresponding-sources.mjs
node scripts/fetch-corresponding-sources.mjs --verify
# 已有归档时也可以指定目录，完全离线核验：
node scripts/fetch-corresponding-sources.mjs --offline --out-dir /path/to/sources
```

脚本下载 8 份已实际核验的上游源码归档，默认放入 `artifacts/corresponding-sources/`，并生成 `SHA256SUMS`。归档位于应用资源目录之外，适合与发行版一起提供；脚本不会解压或执行下载内容，也不会自动更新校验值。源码脚本还会拒绝办公运行时清单、PyMuPDF 版本或本地 zeta.js 与本次审查记录不一致的构建。

必须区分已经确认的证据和仍需补齐的发行材料：

- **LibreOffice 核心提交已与实际二进制数据中的 buildid 对上。** 原始证据来自 `soffice.data` 的 `/instdir/program/versionrc`。
- Qt、QtBase、Emscripten 的快照来自 ZetaOffice 官方列出的分支，Qt supermodule 指向的 QtBase gitlink 也已核对；上游未随 CDN 公布逐组件构建 SBOM，因此未宣称这些快照已逐字节重建 CDN 二进制。
- LibreOffice 核心 Git 归档不含 `make fetch` 获取的外部依赖源码。`LIBREOFFICE-EXTERNAL-SOURCES.lst` 保留该核心提交规定的名称与校验值；完整源码发行还须包括实际配置选择的外部依赖、必要修改与构建材料。
- 本应用源码、锁文件、构建脚本和本地 zeta.js 补丁必须随对应源码交付。仅下载这 8 个归档，不等于已经证明整个发行物的对应源码完整性。
- 本地鼠标时间戳修改分别记录原始与派生 WASM 摘要。获取源码时会校验并复制精确转换脚本、Qt 源码等价补丁和修改说明；专项测试随完整应用源码提供。该二进制补丁不代表整个 WASM 已从源码重编译。

更详细的源码组装说明见 [`public/legal/CORRESPONDING-SOURCE.md`](public/legal/CORRESPONDING-SOURCE.md)。
