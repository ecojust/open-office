# Open Office

一个窗口，处理文字文档、电子表格、演示文稿和 PDF。中文工作台、多文档标签；文件在本机打开、编辑和保存，无需账户，安装后可离线使用。

[下载安装包](https://github.com/ecojust/open-office/releases) · [构建记录](https://github.com/ecojust/open-office/actions/workflows/desktop-release.yml) · [开发与构建](docs/development.md)

当前源码版本为 **0.11.0 Alpha**，新增本地 Rust PDF 工作区、自动保存与局域网浏览器工作区，见[更新说明](docs/releases/0.11.0.md)。安装包通过原生运行验证后发布，下载及逐平台验证状态以[发布页](https://github.com/ecojust/open-office/releases)为准。

## 工作区

| 工作区 | 支持格式 | 主要功能 |
| --- | --- | --- |
| 文字文档 | DOCX；导出 PDF | 文字和段落格式、列表、表格、图片、页面与审阅工具 |
| 电子表格 | XLSX、CSV、TSV；导出 PDF | 工作簿与公式计算、单元格格式、公式栏、工作表编辑 |
| 演示文稿 | PPTX；导入 POTX、PPSX；导出 PDF | 幻灯片、文本与形状、图片、布局与样式、备注、放映 |
| PDF 工作室 | PDF | 阅读、文字编辑、批注、表单、搜索与页面整理；[集成边界](docs/pdf-capabilities.md) |

新建、打开、保存、另存为、导出、打印、撤销和重做集中在顶部，作用于当前文档。浅色／深色／跟随系统主题同步所有工作区；操作栏采用自行绘制的 SVG 图标。支持最近文件、多标签、未保存关闭确认与外部文件修改检测。

保存按钮旁的“自动保存”开关每 30 秒保存已选择本机位置的当前文档。新建和首次导入的文档需先手动保存；自动保存不会弹出文件对话框或覆盖导入原件。

点击 **Server → 启动 Server**，在本机或同一局域网的浏览器中直接打开访问链接，无需配对码。打开的文档会加入共享工作区，浏览器也可新建、导入和编辑；停顿后自动双向同步。两端同时修改时保留冲突副本，不合并到同一文档。浏览器的保存按钮下载副本；同步快照先保存在客户端工作区，写入本机文件由客户端保存操作控制。桌面应用需保持运行；停止 Server 后旧链接失效。持有链接即可访问，适用于可信局域网。见[浏览器工作区说明](docs/browser-workspace.md)。

导入的文档首次保存生成副本。POTX、PPSX 编辑后保存为 PPTX；CSV／TSV 只导出活动工作表的显示值，不包含格式和公式。当前不支持旧 DOC、RTF、ODT、XLS、ODS、PPT 和 ODP，需先转换为支持的格式。失败打开不会切换到其他内核。

## 架构与兼容性

文字、表格、演示和 PDF 均由仓库内固定版本的 Rust 源码构建为本地 WASM。四套引擎实际负责解析、编辑、排版和导出，Vue/Tauri 统一管理文件、主题和标签生命周期。代码标识与运行日志使用 Open Office 命名；原始版权、依赖身份及文档兼容标识保留，真实来源见[第三方清单](THIRD_PARTY_NOTICES.md)。

旧办公兼容运行时、早期文档引擎和 PDF 子进程后台已移除。应用不加载远程办公网页，PDF 也直接在本地工作区编辑。

编辑器仍处于 Alpha。上游功能数量不等于本应用已经验收的数量，复杂对象、特殊字体、分页、公式与格式往返可能有差异。请保留重要文档原件并核对导出结果。完整 Office 兼容、扫描件 OCR 和证书数字签名编辑不在当前承诺范围内。

验证包括真实画布编辑、导出和重开，以及独立 ZIP/XML/PDF 读取检查。浏览器测试不能代替安装包的原生 WebView 验收；各平台发布结果以对应 Actions 为准。`docs/` 中旧内核报告是历史记录，不代表当前新引擎的验证结果。

## 安装与开发

在[发布页](https://github.com/ecojust/open-office/releases)选择 Windows x64、Mac M 系列或 Mac Intel 安装包。新架构将四套文档引擎与字体一起打包。当前未配置商业代码签名；macOS 使用本地签名，尚未进行开发者公证。校验文件见发布附件 `SHA256SUMS`。

开发需要 Node.js 24、Rust stable（至少 1.95）、`wasm32-unknown-unknown`、`wasm-bindgen-cli 0.2.129` 和本机原生构建工具。独立导出验收另需 Python 3.12，它不进入应用安装包。见[开发与构建](docs/development.md)、[图标说明](src/icons/README.md)。

## 许可

本仓库保留原始 MIT 许可；集成发行包包含多种许可组件。原始版权和开源来源保留在法律资料中。见 [LICENSE](LICENSE)、[集成分发许可](DISTRIBUTION_LICENSE.md)及[第三方清单](THIRD_PARTY_NOTICES.md)。
