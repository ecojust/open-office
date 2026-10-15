# Open Office

一个窗口，处理文字文档、电子表格、演示文稿和 PDF。中文工作台、多文档标签；文件在本机打开、编辑和保存，无需账户，安装后可离线使用。

[下载安装包](https://github.com/ecojust/open-office/releases) · [构建记录](https://github.com/ecojust/open-office/actions/workflows/desktop-release.yml) · [开发与构建](docs/development.md)

当前源码版本为 **0.10.0 Alpha**，见[更新说明](docs/releases/0.10.0.md)。本版接入 Rust 演示文稿编辑器并移除旧内核；安装包及逐平台验证状态以[发布页](https://github.com/ecojust/open-office/releases)为准。

## 工作区

| 工作区 | 支持格式 | 主要功能 |
| --- | --- | --- |
| 文字文档 | DOCX；导出 PDF | 文字和段落格式、列表、表格、图片、页面与审阅工具 |
| 电子表格 | XLSX、CSV、TSV；导出 PDF | 工作簿与公式计算、单元格格式、公式栏、工作表编辑 |
| 演示文稿 | PPTX；导入 POTX、PPSX；导出 PDF | 幻灯片、文本与形状、图片、布局与样式、备注、放映 |
| PDF 工作室 | PDF | 原文替换、文字与图片、高亮与便签、简单表单、手绘签名、搜索、合并与页面整理、页码和水印 |

新建、打开、保存、另存为、导出、打印、撤销和重做集中在顶部，作用于当前文档。浅色／深色／跟随系统主题同步所有工作区；操作栏采用自行绘制的 SVG 图标。支持最近文件、多标签、未保存关闭确认与外部文件修改检测。

导入的 Office 文档首次保存生成副本。POTX、PPSX 编辑后保存为 PPTX；CSV／TSV 只导出活动工作表的显示值，不包含格式和公式。当前不支持旧 DOC、RTF、ODT、XLS、ODS、PPT 和 ODP，需先转换为支持的格式。失败打开不会切换到其他内核。

## 架构与兼容性

文字、表格、演示分别使用固定版本的 [WordCraft](https://github.com/storytold/wordcraft)、[GridCraft](https://github.com/storytold/gridcraft)、[DeckCraft](https://github.com/storytold/deckcraft) Rust 引擎与 egui 界面。三者从仓库源码构建为本地 WASM，文档模型、编辑与导出由对应引擎实际处理；Vue/Tauri 协调文件、主题和标签生命周期。PDF 保留 PDF.js 与本地 PyMuPDF/MuPDF 后端。详见[演示引擎与清理范围](docs/deckcraft-integration.md)。

旧 LibreOffice/ZetaOffice 兼容运行时、早期 TypeScript 文档引擎和旧自研 Rust Word IPC 已移除。当前只有上述三套 Office 编辑引擎和 PDF 工作室，不加载远程 Office 网页。

编辑器仍处于 Alpha。上游功能数量不等于本应用已经验收的数量，复杂对象、特殊字体、分页、公式与格式往返可能有差异。请保留重要文档原件并核对导出结果。完整 Office 兼容、扫描件 OCR 和证书数字签名编辑不在当前承诺范围内。

验证包括真实画布编辑、导出和重开，以及独立 ZIP/XML/PDF 读取检查。浏览器测试不能代替安装包的原生 WebView 验收；各平台发布结果以对应 Actions 为准。`docs/` 中旧内核报告是历史记录，不代表当前新引擎的验证结果。

## 安装与开发

在[发布页](https://github.com/ecojust/open-office/releases)选择 Windows x64、Mac M 系列或 Mac Intel 安装包。安装包自带文档引擎、字体与 PDF 后端。当前未配置商业代码签名；macOS 使用本地签名，尚未进行开发者公证。校验文件见发布附件 `SHA256SUMS`。

开发需要 Node.js 24、Python 3.12、Rust stable（至少 1.95）、`wasm32-unknown-unknown`、`wasm-bindgen-cli 0.2.129` 和本机原生构建工具。见[开发与构建](docs/development.md)、[图标说明](src/icons/README.md)。

## 许可

本仓库保留原始 MIT 许可；集成发行包包含多种许可组件。原始版权和开源来源保留在法律资料中。见 [LICENSE](LICENSE)、[集成分发许可](DISTRIBUTION_LICENSE.md)及[第三方清单](THIRD_PARTY_NOTICES.md)。
