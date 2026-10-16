# OfficeSheet 电子表格集成（Alpha）

默认电子表格工作区采用 [OfficeSheet](https://github.com/ecojust/open-office) 的 Rust 工作簿模型、公式引擎和 egui 编辑界面，固定上游提交为 [`e6b6b349708ab4978cb3f061f6bd6ecbc25667cb`](https://github.com/storytold/gridcraft/tree/e6b6b349708ab4978cb3f061f6bd6ecbc25667cb)，上游工作区版本为 `0.7.0`。这是基于开源引擎的本地集成，不是本项目从零重写的完整 Excel，也不是上游官方发行版。

## 架构与文件归属

```text
XLSX / CSV / TSV 字节
  → Rust 文件解析与工作簿模型
  → Rust 公式计算、编辑命令、撤销重做
  → egui 功能区、公式栏、表格画布、工作表标签

Open Office Vue/Tauri 外壳 ↔ 本地 WASM 宿主 ↔ SheetApp
  新建、打开、保存、另存、导出、打印、文档标签与关闭确认
```

`vendor/office-sheet/` 保留上游 Rust 源码；`apps/open-office-host` 是本地适配层。`office-sheet-core`、`office-sheet-model`、`office-sheet-formula`、`office-sheet-calc`、`office-sheet-engine`、`office-sheet-xlsx` 和 `office-sheet-ui-egui` 分别承担值与地址、工作簿、公式、重算、命令、文件格式和界面。Vue 不另外维护一份用于编辑的单元格模型。

桌面 WebView 和浏览器加载随应用构建的本地 JS/WASM，Tauri 负责原生文件与窗口生命周期。编辑区不加载远程 Office 网页服务。内部文件菜单、下载、系统文件选择以及会替换当前工作簿的入口必须交给外壳，不能绕过未保存确认。普通编辑界面使用 Open Office 的产品名称；源码、内部模块名和法律归属保留上游名称。

## 格式与功能边界

复用的编辑界面包含单元格输入、公式栏、格式、工作表管理、排序筛选、查找替换、图表和其他上游命令入口。功能区中存在按钮不等于对应功能的每种组合都已验收；上游仍为 Alpha，本文不引用其功能数量或完成比例作为 Open Office 的通过指标。

| 格式 | 本次集成需要遵守的边界 |
| --- | --- |
| XLSX | Rust 引擎解析、编辑并写出工作簿。上游对部分未知包内容采用透传，但切片器、时间线、数据模型、未建模扩展和复杂图表细节仍可能丢失。首次保存导入文件应另存副本；不能宣称任意 XLSX 无损往返。 |
| CSV / TSV | 属于单工作表文本数据。上游导出活动表的显示值和公式结果，不携带公式、格式、多工作表及对象。CSV 可保留读取时检测到的分隔符；文本编码及引用规则以实现和测试为准。 |
| ODS / XLSB | 上游只导入数据及公式的最后保存值，不保留可重算公式、格式和多数对象，也不写出这些格式。本应用不开放 ODS 或 XLSB；旧兼容入口已移除，需先转换为 XLSX。 |
| XLS（BIFF8） | 上游只读部分值、公式、数字格式、合并和尺寸等内容；字体、填充、边框及多数对象未保留，不能写回 XLS。本应用不开放 XLS，需先转换为 XLSX。 |
| XLSM / 模板 / 加密工作簿 | 上游的宏字节保留、模板内容类型和密码解密能力，不代表已接通本应用的完整安全保存流程。宏不执行；上游不能写出密码加密文件。本应用拒绝未开放的格式，不提供兼容内核回退。 |
| PDF / 打印 | 上游原有标准 PDF 字体路径不能覆盖中文。本地 PDF 字体适配使用本项目已有字体并嵌入子集；实际字符、图片、分页和导出结果须以专项验收为准，不据字体文件存在就认定所有文字系统正确。 |

不支持或损坏的文件应给出可理解的失败结果；保留原有标签、修改和历史，不能自动切换引擎掩盖错误。复杂原件应与另存的副本核对。没有性能对照测试时，不宣称此次替换比旧引擎更快。

## 生命周期验收要求

以下是替换内核时需要实现并验证的约束，本节本身不是通过证据：

1. 新建／导入先在候选会话完成准备，成功后才切换文档；失败和取消不得污染当前工作簿。
2. 每个文档保有独立工作簿、选区、活动表及撤销历史。切换标签不能仅靠文件快照重建会话，也不能把暂存标记为已保存。
3. 导出前完成当前单元格编辑和输入法组合；不能丢失最后输入，或把组合文本提交两次。
4. 导出字节只是快照。只有外壳实际写入／下载成功，且版本仍匹配，才能确认保存；取消、写入失败和过期响应不能清除新的修改。
5. 关闭／退出统一使用外壳未保存确认；内部快捷键或菜单不得直接销毁工作簿。会话释放包含画布事件、异步回调和候选文档。
6. 测试必须驱动实际本地 WASM 画布和文件导出，独立读取导出的 XLSX／PDF；旧兼容表格测试不能作为新默认内核的验收证据。

浏览器输入、剪贴板和打印行为也不能直接扩大为 Windows／macOS 原生 WebView、物理输入法、系统剪贴板或原生文件对话框已通过。构建和浏览器测试与安装包验收分别记录。

## 表格引擎替换轮次的验证

以下记录对应 2026-10-15 表格引擎替换轮次的快照，早于随后全局工具栏与主题调整。后续改动的检查见[全局工具栏与主题](development.md#交互约定)，不沿用此快照的通过结论。

| 命令 | 结果与范围 |
| --- | --- |
| `npm test` | 类型检查、983 项 Node 回归、83 项现有 PDF 后端测试通过。 |
| `cargo test --locked --manifest-path vendor/office-sheet/Cargo.toml -p office-sheet-ui-egui --lib embedding::` | 12 项 Rust UI 嵌入适配测试在最终双击判定修复前通过，包括同帧输入提交顺序和提交后的首次选格点击；未对该最终修复重跑此套测试。 |
| `cargo test --locked --manifest-path vendor/office-sheet/Cargo.toml -p open-office-sheet-host --lib` | 5 项宿主测试通过，覆盖输入提交、保存版本、失败导入、无效公式草稿和确认放弃关闭。 |
| `cargo test --offline --manifest-path vendor/office-sheet/Cargo.toml -p office-sheet-pdf` | 17 项表格 PDF 模块测试通过。 |
| `npm run test:browser:sheet-engine` | 该轮构建的 Chromium 主验收 9 组通过；报告为 `test-results/office-sheet-engine/report.json`。 |
| `npm run test:browser:sheet-native-helper` | 同一快照的 Chromium 自检 6 项通过；报告为 `test-results/office-sheet-native-helper/report.json`。 |

`npm run build` 生产构建、`npm run sheet:check` 源码与产物摘要检查，以及 Rust 格式、资产归属和依赖分层检查均已通过。

外壳回归覆盖文件路由、候选会话失败保护、首次保存副本、取消保存、标签会话保留及过期保存响应，使用受控宿主替身。83 项现有 PDF 后端测试属于原 PDF 工作区。它们不代替实际 WASM 表格编辑和导出验收。

2026-10-15 的主浏览器验收实际操作默认表格画布，验证中文／emoji 输入、公式重算与撤销重做、加粗、工作表切换、保存取消和过期响应、失败导入、表格与文字标签的草稿隔离。导出的 XLSX 由独立 XML 检查器核对公式、样式和重开结果；中文 PDF 由独立解析器读取；CSV／TSV 验证活动表显示值导出、中文及引号导入、原件保留。真实剪贴板复制／粘贴和拒绝权限后的错误提示、数据保留也通过。

最终的单击／双击判定修复由这轮浏览器回归验证：单击选格、加粗后再次单击保持就绪，真实双击进入编辑，Escape 退出编辑。12 项 Rust UI 单元测试是该最终修复前的结果，不声称在最终源码上重新运行。该轮原始截图保存在 `test-results/office-sheet-engine/`；README 使用后续全局工具栏与主题轮次的实际截图。

Chromium 自检使用实际默认表格画布，覆盖本地 WASM 绘制、合成中文／emoji 输入、公式和加粗、XLSX 导出与保存回执、过期保存及失败打开保护、导出文件重开，并核对源码和资源摘要。它不验证物理输入法、系统文件对话框、文件系统持久化或安装包的原生 WebView。

该轮两份浏览器报告的产品文件摘要在运行前后保持一致，源码指纹为 `93ae20863daf5fbcc4fabb9415deedeb4eece99010a0d8b21303b4323b593f11`，WASM SHA-256 为 `f2213d90d8ebb47bfe5502be04ddce74841d23c0569ec4f22028cf2f1f12baf1`；未观察到外部网络请求或旧表格引擎请求。这些摘要只标识该轮历史快照，当前构建以生成的 manifest 为准。

上述历史检查不代表完整 Excel 功能、任意文件保真或物理系统输入法验收。表格引擎随 0.9.0 发布候选版本进入三平台安装包构建，原生 WebView 与安装包结果以[本版更新说明](releases/0.9.0.md)链接的 Actions 记录为准；0.8.1 安装包不包含新的表格引擎。

## 构建

需要支持固定依赖的 Rust 工具链、`wasm32-unknown-unknown` 目标及 `wasm-bindgen-cli 0.2.129`。`npm run sheet:build` 编译本地宿主并生成 `public/office-sheet/` 资源；`npm run sheet:check` 检查其源码与产物摘要。`public/office-sheet/manifest.json` 记录上游提交、所有实际源码／字体输入的指纹，以及生成 JS／WASM 的摘要。构建缓存可以通过 `OFFICE_SHEET_TARGET_DIR` 指定。

本页不将旧兼容表格测试、上游自己的功能说明或仅通过编译当作新编辑器的端到端通过证据。实际验收结果应随本次集成测试报告或发行说明提供。

## 来源、字体与许可

原始双许可、NOTICE、资产归属及来源摘要保存在 [`public/legal/gridcraft/`](../public/legal/gridcraft/OPEN-OFFICE-INTEGRATION.md)。来源清单保留确切上游归档的 SHA-256；修改后源码以 Open Office 的发行提交和构建输入指纹为准。

OpenOffice 的标志图片依据上游品牌条款从派生源码移除；原始 NOTICE 和 ATTRIBUTION 保持原样，其中的图片引用描述上游资源集合。`craft-ui` 与文字工作区固定到相同的 `craft-libs` 提交，许可和代码来源记录复用已有法律目录。

本地画布复用 `assets/fonts/open-office/` 的 Noto Sans CJK SC Regular、Bold、DejaVu Sans Regular、Bold、Oblique、Bold Oblique 及 Noto Sans Symbols2 Regular，共七份字体；PDF 使用其中的常规／粗体和符号字体，不使用两份斜体。许可分别为 SIL OFL 1.1 和 DejaVu／Bitstream Vera，字体哈希和原始许可单独保留。字体替换可能改变尺寸和分页；这组字体不代表完整或彩色 emoji 支持。未使用可选 `storytold/craft-fonts` 仓库。

OfficeSheet 的 MIT OR Apache-2.0 不替代 PDF 内核的 AGPL 或其他依赖各自的许可；整体分发仍遵守[第三方说明](../THIRD_PARTY_NOTICES.md)。
