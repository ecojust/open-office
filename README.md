# Open Office

一个窗口，处理文字文档、电子表格、演示文稿和 PDF。中文工作台、扁平界面、多文档标签；文件在本机打开、编辑和保存，无需账户，安装后可离线使用。

[下载安装包](https://github.com/ecojust/open-office/releases) · [构建记录](https://github.com/ecojust/open-office/actions/workflows/desktop-release.yml) · [开发与构建](docs/development.md)

**WordCraft 文字编辑器集成预览（Alpha）**：本分支将默认文字工作区接入 WordCraft 的 Rust 文档引擎和完整功能区界面。上游版本固定，文件在本机处理；实际功能与验证边界见[集成说明](docs/wordcraft-integration.md)。已发布的 [0.7.0](docs/releases/0.7.0.md) 使用此前的基础 Rust 内核，不包含此次集成。

![Open Office 工作台](docs/screenshots/home.png)

## 软件功能

| 工作区 | 常用格式 | 主要功能 |
| --- | --- | --- |
| 文字文档（WordCraft Alpha） | DOCX；导出 PDF | 复用 WordCraft 的 Rust 文档模型、排版和功能区，提供文字与段落格式、列表、表格、图片、页面与审阅等工具；本项目接入及验证范围见下文 |
| 文字兼容编辑器 | DOCX、ODT | 文字与段落排版、普通列表与编号、上下标与高亮、超链接、标题大纲、表格、页眉页脚、查找替换、批注与修订、导出 PDF |
| 电子表格 | XLSX、ODS | 单元格与公式、混合格式提示与富文本格式设置、向下/向右填充、选区汇总、工作表管理、排序筛选、冻结、条件格式、数据验证、基础图表与透视汇总 |
| 演示文稿 | PPTX | 独立画布、局部文字与段落排版、文本框布局、图片、可编辑表格和图表、备注、页面切换、本地音视频与放映 |
| PDF 工作室 | PDF | 原文替换、新增文字与图片、高亮与便签、批注备注管理、简单表单填写、手绘签名、搜索、合并与页面整理、页码和水印 |

支持最近文件、撤销重做、保存与另存为；另存为可以选择当前工作区支持的格式，跨格式转换生成副本，保留原文稿继续编辑。未保存退出确认、未应用草稿检查和外部文件修改检测，帮助保留编辑结果。旧版 DOC、RTF、XLS 可导入并另存现代格式副本。演示文稿目前支持标准 PPTX，旧 PPT 与 ODP 需要先转换。

演示工作区现已采用独立文档模型、SVG 画布和 PPTX 读写模块，不加载原办公引擎。文件操作与幻灯片工具各一行，属性收在侧栏；支持拖动、缩放、组合、表格与图表数据编辑，以及可检索中文的 PDF 导出。[功能与验证范围](docs/standalone-presentation.md)

默认文字工作区基于 [WordCraft](https://github.com/storytold/wordcraft) 的 Rust 内核与 egui `WordApp` 界面，编译为随应用分发的 WASM，在本地画布中运行。Vue/Tauri 负责工作台、多标签、文件对话框和保存保护。这是对开源编辑器源码的集成；电子表格和显式文字兼容入口继续使用原办公引擎，演示与 PDF 保留各自实现。

当前外壳开放 DOCX 导入、编辑与保存，以及 PDF 副本导出。WordCraft 上游仍为 Alpha，完整功能区中的命令数量不等于已经验证所有功能；复杂对象、字体替换、分页和文件往返保真仍需核对。导入的 DOCX 首次保存生成副本，失败打开不会自动切换引擎。其他文字格式从“兼容编辑器”入口打开。尚未测得本集成相对旧引擎的性能提升，也未宣称替代完整 Microsoft Office。[架构、功能与验收边界](docs/wordcraft-integration.md)

0.6.0 新增“轻量文字文档（预览）”入口，采用独立正文模型、编辑界面与 DOCX 读写，支持基础文字格式、单／双下划线及独立线条颜色、上下标、单／双删除线、字符间距与字偶距、大写与小型大写显示、标准色高亮、自定义文字背景色、标题、段落对齐、左右与首行／悬挂缩进、段前段后与行距、纸张尺寸、方向和页边距，以及撤销重做，并保留空段及独立段落标记的文字格式。桌面路径的 DOCX 解压、压缩与校验已接入 Rust 后台模块，并增加真实 LibreOffice 文件的往返测试。尚未支持复杂分页、表格和图片，DOCX 导入限于已实现的格式子集。[使用方式与验证范围](docs/independent-word.md) · [Rust 实现与性能记录](docs/word-rust-performance.md) · [导入性能对照](docs/word-import-performance.md)

## 兼容性测试

- 使用固定样例验证“打开 → 编辑 → 保存 → 重开”，并独立读取实际导出文件；检查正文、格式、公式、图表、链接、批注与页面信息。[文档兼容报告](docs/compatibility-results.md)
- 演示专项覆盖 12 份复杂原件，分别检查原始内容保留、可编辑功能与画面差异；对尚未支持的动画、图示和排版明确提示。[复杂演示文稿测试](docs/presentation-complex-compatibility.md)
- 持续修复四个工作区的编辑与保存问题。每轮记录源码指纹、实际操作、失败原因和已知限制；测试结果不会替代未完成的功能。[当前实现与验证进展](docs/rea-compatibility-progress.md)
- 界面检查覆盖桌面和窄窗；具体工具的 390、320 像素操作、键盘交互与实际截图见各专项记录。
- 历史发布记录包含 Windows x64、macOS ARM64 和 macOS Intel 安装包检查；Intel 使用 Rosetta，尚未在真实 Intel 显卡上完整实测。0.7.0 的 Rust IPC 和旧浏览器结果不证明此次 WordCraft WASM／画布集成通过，后者需要独立验收。

测试只证明报告中的样例与检查项。复杂版式、特殊字体、部分公式和嵌入附件仍可能存在差异；完整对象动画、扫描件 OCR 和证书数字签名编辑尚未支持。发现已知导入风险时会提示另存副本，重要文档请保留原件并核对导出结果。[PDF 功能边界](docs/pdf-capabilities.md) · [内存测试记录](docs/memory-optimization.md)

## 界面预览

以下为实际运行的浏览器预览截图，内容为测试文档；桌面版另提供原生文件保存与本地后台处理。演示工作区采用独立扁平界面，截图中的文字兼容编辑器和表格工作区仍保留内置高级菜单的原有外观，尚未展示此次 WordCraft 界面。

<details>
<summary>文字文档</summary>

![文字文档编辑](docs/screenshots/document.png)

</details>

<details>
<summary>电子表格</summary>

![电子表格编辑](docs/screenshots/spreadsheet.png)

</details>

<details>
<summary>演示文稿</summary>

![演示文稿编辑](docs/screenshots/presentation.png)

</details>

<details>
<summary>PDF 工作室</summary>

![PDF 编辑与页面工具](docs/screenshots/pdf.png)

</details>

## 安装与开发

在[发布页](https://github.com/ecojust/open-office/releases)选择 Windows x64 安装程序、Mac M 系列 DMG 或 Mac Intel DMG。安装包自带文档引擎、中文字体与 PDF 后端。当前编辑引擎内存占用较高，建议至少 8 GB 内存。

当前安装包未配置商业代码签名；macOS 包使用本地签名，尚未进行开发者公证。首次打开请按系统安全提示处理，校验文件见发布附件 `SHA256SUMS`。

历史版本、安装包和已通过的检查见 [0.7.0 更新说明](docs/releases/0.7.0.md)。本分支的 WordCraft 集成验证单独记录，不能沿用历史测试数量作为完成证明。

开发需要 Node.js 24、Python 3.12、Rust stable（至少 1.95）、`wasm32-unknown-unknown`、固定 `wasm-bindgen-cli 0.2.129` 和对应系统的原生构建工具，步骤见[开发与构建](docs/development.md)。

## 许可

本仓库保留原始 MIT 许可；集成发行包包含多种许可证组件，不能仅按 MIT 二进制软件分发。完整许可与对应源码说明见 [LICENSE](LICENSE)、[集成分发许可](DISTRIBUTION_LICENSE.md)和[第三方许可清单](THIRD_PARTY_NOTICES.md)。
