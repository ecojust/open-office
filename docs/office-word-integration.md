# 本地文字编辑器集成（Alpha）

文字工作区由本地 Rust 文档模型、DOCX 解析、编辑命令、布局与 egui 界面共同驱动。宿主适配基于固定版本的开源源码，来源、版权和修改说明见[第三方声明](../THIRD_PARTY_NOTICES.md)。完整界面的接入不等于所有复杂文档功能已经通过兼容验证。

已发布的 [0.7.0](releases/0.7.0.md) 使用本项目第一阶段基础 Rust 内核。其 SVG 界面、严格格式子集、原生 `word_engine_request` 和当时测试结果均属于旧路径；此次集成不沿用它们作为通过证据。

## 实际架构

```text
DOCX 字节
  → OfficeWord Rust DOCX 解析与文档模型
  → OfficeWord 编辑命令、历史、布局与渲染
  → egui WordApp 功能区与本地 canvas

Vue/Tauri 外壳 ↔ open-office-host WASM 桥 ↔ WordApp
  文件对话框、标签页、保存与另存、冲突检测与关闭确认
```

`vendor/office-word/` 保留固定上游代码；`apps/open-office-host` 是 Open Office 的适配层。`office-word-doc`、`office-word-docx`、`office-word-layout`、`office-word-render`、`office-word-engine` 与 `office-word-ui-egui` 分别承担文档、格式、排版、绘制、命令和界面。功能区和正文画布一起复用，Vue 不另外维护一份正文模型。

桌面 WebView 与浏览器都运行随应用分发的本地 WASM 和 JS，Tauri 负责原生文件与窗口生命周期。旧原生 Word IPC 和兼容办公入口已移除。当前表格使用 [OfficeSheet](office-sheet-integration.md)，演示使用 [OfficePresentation](office-presentation-integration.md)，PDF 使用 `vendor/office-pdf` 的本地 Rust/WASM 引擎；四套编辑器由共享外壳管理，不加载远程办公网页。

## 功能与边界

外壳当前开放 DOCX 新建、打开、编辑与保存，以及 PDF 副本导出。当前只开放 DOCX 文字格式；上游支持某种格式不等于本项目已开放对应文件流程。打印先生成 PDF 并尝试浏览器打印预览；不可用时可导出 PDF 后用系统阅读器打印，不代表已接入上游原生打印栈。

复用的功能区提供文字与段落格式、样式、列表、表格、图片、页面设置、页眉页脚、查找替换、批注修订等命令入口。它们的具体保真度、边缘操作和本应用生命周期交互，需要以实际验收记录为准；本页不把完整功能区或上游命令数量当作全部功能通过的证明。

为保持外壳的文档和文件归属，宿主明确拦截上游的文件操作；宏回放／重复命令、Zotero 工作流和会直接替换文档的部分邮件合并流程尚未开放。功能区来自完整上游界面，不代表这些需要宿主服务的路径已接通；不支持的操作应给出错误而不是绕过保存保护。

系统剪贴板当前只传递纯文本。OfficeWord 在同一会话内、剪贴板文本与内部保存的片段匹配时，可以复用该片段的格式；跨标签和跨应用的富文本剪贴板尚未接通。验证普通粘贴与“仅粘贴文本”的差异，需要在同一会话内使用同一带格式片段作对照；向新标签粘贴得到纯文本，不能单独证明“仅粘贴文本”已经正确去除格式。

OfficeWord 上游仍标记为 **Alpha**。复杂 DOCX、图表／SmartArt、域与浮动对象、字体替换和与 Microsoft Word 的分页一致性，均不能假定完整兼容。本项目尚未给出相对旧引擎的性能提升结论，也未证明可替代整个 Microsoft Office。上游 README 的功能比例与速度数字不作为本集成的指标。

从 0.12.0 起，桌面版打开已有 DOCX 后，“保存”直接写回该文件；需要保留原件时使用“另存为”。保存前仍检查原文件身份和外部修改，失败打开保留当前标签、未保存内容和撤销历史，不会静默切到兼容引擎。这些保护不能弥补未知内容的导入损失；复杂文件仍需核对保存结果。浏览器版通过下载交付文件。

字体包含 OfficeWord 随附的 Inter、JetBrains Mono、Source Sans 3 和 Source Serif 4，并使用本项目已有 Noto Sans CJK SC Regular、Bold 补充中文界面与正文，DejaVu Sans Regular 与 Noto Sans Symbols2 Regular 提供部分单色 emoji／符号回退，不支持完整或彩色 emoji。字体替换可能改变版式。可选 `storytold/craft-fonts` 仓库不在此集成内。

## 宿主事务约束

以下约束是替换内核时的验收要求，需检查实际实现与测试，不应仅凭文档认定通过：

1. 新文档先在候选会话中完成解析／准备，成功后才暂存当前页和创建标签。失败或放弃的候选必须释放，不能污染现有正文或切走当前标签。
2. 每个标签拥有独立的 WordApp／文档身份、选区、输入样式和撤销重做历史。隐藏标签不销毁会话，不接收当前窗口的键盘输入；回到标签不从最近一次 DOCX 快照重建历史。
3. 导出前确认正在进行的输入法组合、待处理按键和 Rust 编辑事务已经完成。无法确认时阻止保存，并保留输入；组合提交不得插入两次。
4. 导出是快照，不等于已经保存。只有文件写入或下载交付成功后，且文档仍对应本次导出的内容／版本，才能更新保存基线。取消、文件冲突、导出失败和迟到响应均不能清除新的修改。
5. 切换标签只暂存编辑快照，不把文档标为已保存，也不截断历史。关闭和退出沿用外壳的未保存确认；内部文件菜单须交给外壳，不能旁路保存保护或直接替换文档。
6. 资源关闭必须覆盖 WordApp runner、canvas 事件、动画帧、异步回调和未交付候选。跨标签与卸载后的响应按会话身份拒绝；多文档限制不得通过驱逐脏文档实现。

字符串位置、字节／字符／UTF-16 换算应由统一引擎适配处理。验证至少包含中文、emoji、组合字符、段落边界及格式选区，不能依赖 JavaScript 逐 UTF-16 单元截断来代替 OfficeWord 的文本语义。

## 构建与验证状态

需要 Rust 1.95 或更新版本（固定的 craft-ui 依赖要求）、`wasm32-unknown-unknown` 和固定 `wasm-bindgen-cli 0.2.129`。运行 `npm run word:build` 后，`public/office-word/manifest.json` 记录上游提交、实际源文件和字体输入摘要，以及生成 JS／WASM 的摘要；`npm run word:check` 检查产物是否匹配。完整步骤见[开发与构建](development.md)。

早期集成快照的测试数量、报告路径与校验摘要原样保留在[历史集成记录](history/word-integration-0.8.md)。这些结果不能作为当前命名迁移、PDF 替换或新安装包通过的证据；当前版本须重新完成构建、浏览器与原生安装包验收。
