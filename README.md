# Open Office

一个窗口，处理文字文档、电子表格、演示文稿和 PDF。中文工作台、扁平界面、多文档标签；文件在本机打开、编辑和保存，无需账户，安装后可离线使用。

[下载安装包](https://github.com/ecojust/open-office/releases) · [构建记录](https://github.com/ecojust/open-office/actions/workflows/desktop-release.yml) · [开发与构建](docs/development.md)

![Open Office 工作台](docs/screenshots/home.png)

## 软件功能

| 工作区 | 常用格式 | 主要功能 |
| --- | --- | --- |
| 文字文档 | DOCX、ODT | 文字与段落排版、标题大纲、表格、页眉页脚、查找替换、批注与修订、导出 PDF |
| 电子表格 | XLSX、ODS | 单元格与公式、工作表管理、排序筛选、冻结、条件格式、数据验证、基础图表与透视汇总 |
| 演示文稿 | PPTX | 独立画布、页面编排、文本与图片、可编辑表格和图表、备注、页面切换、本地音视频与放映 |
| PDF 工作室 | PDF | 原文替换、新增文字与图片、高亮、手绘签名、搜索、合并与页面整理、页码和水印 |

支持最近文件、撤销重做、保存与另存为；未保存退出确认、未应用草稿检查和外部文件修改检测，帮助保留编辑结果。旧版 DOC、RTF、XLS 可导入并另存现代格式副本。演示文稿目前支持标准 PPTX，旧 PPT 与 ODP 需要先转换。

演示工作区现已采用独立文档模型、SVG 画布和 PPTX 读写模块，不加载原办公引擎。文件操作与幻灯片工具各一行，属性收在侧栏；支持拖动、缩放、组合、表格与图表数据编辑，以及可检索中文的 PDF 导出。[功能与验证范围](docs/standalone-presentation.md)

## 兼容性测试

- 文档回归使用固定样例，检查“打开 → 编辑 → 保存 → 重开”，并独立读取导出的 PDF；覆盖文字格式、表格、公式重算、图表、备注和页面编排。
- 复杂文档测试覆盖 23 份原件；PDF 专项完成多轮实际编辑，核对未修改页面、书签、批注和页面信息。详细结果见[兼容测试报告](docs/compatibility-results.md)。
- 发布前验证 Windows x64、macOS ARM64 和 macOS Intel 安装包。Intel 包原生编译后通过 Rosetta 运行真实应用检查，尚未在真实 Intel 显卡上完整实测。
- 本轮界面检查覆盖 1360 × 900、900 × 640、640 × 800 三种窗口尺寸，以及标签切换、工具面板和弹窗键盘操作。
- 独立演示工作区单独验证新建、对象编辑、保存重开、中文 PDF、20 页文稿和隐藏页放映；检查导出的真实 PPTX XML 与图表内嵌工作簿，整个 PPT 会话没有旧办公引擎请求。
- 新增[复杂 PPTX 专项](docs/presentation-complex-compatibility.md)：12 份原件覆盖 SmartArt、动画引用、混合文字、母版、分组和复杂图表，分别记录文件保留与实际画面，尚未实现的功能明确列出。

测试只证明报告中的样例与检查项。复杂版式、特殊字体、部分公式和嵌入附件仍可能存在差异；完整对象动画、扫描件 OCR 和证书数字签名编辑尚未支持。发现已知导入风险时会提示另存副本，重要文档请保留原件并核对导出结果。[PDF 功能边界](docs/pdf-capabilities.md) · [内存测试记录](docs/memory-optimization.md)

## 界面预览

以下为实际运行的浏览器预览截图，内容为测试文档；桌面版另提供原生文件保存与本地后台处理。演示工作区采用独立扁平界面，文字与表格工作区的内置高级菜单仍保留原有外观。

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

独立演示内核属于当前源码更新；此前发布的安装包不包含这次替换，请以发布记录对应的提交为准。本轮已验证浏览器运行与生产构建，尚未构建新的桌面安装包。

开发需要 Node.js 24、Python 3.12、Rust stable 和对应系统的原生构建工具，步骤见[开发与构建](docs/development.md)。

## 许可

本仓库保留原始 MIT 许可；集成发行包包含多种许可证组件，不能仅按 MIT 二进制软件分发。完整许可与对应源码说明见 [LICENSE](LICENSE)、[集成分发许可](DISTRIBUTION_LICENSE.md)和[第三方许可清单](THIRD_PARTY_NOTICES.md)。
