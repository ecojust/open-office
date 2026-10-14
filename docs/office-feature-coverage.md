# 全模块功能覆盖与 REA 对照

更新：2026-10-14。本文覆盖 Open Office 的文字、表格、演示与 PDF 四个本地工作区，区分已有能力、本轮补充和仍需实现的能力。后续成果见[完整迭代记录](rea-compatibility-progress.md)，包括[文字列表与表格格式一致性](word-list-and-sheet-format.md)及[窗口与实际输入检查](office-viewport-validation.md)。它是源码工作记录，不是新安装包发布记录，也不是任意复杂文件无损兼容声明。账户、云盘、云协作与云 AI 继续按[本地办公范围](local-only.md)排除。

## 当前架构与已有能力

| 工作区 | 当前实际内核 | 已有产品能力 | 仍需重点补齐 |
| --- | --- | --- | --- |
| 文字 | 随包 ZetaOffice / LibreOffice WASM，通过受限 UNO 协议读写真实文档 | DOCX/ODT 打开与保存，字符与段落格式、普通列表与重新编号、样式和标题导航，矩形表格与单元格编辑，页边距/页眉页脚/页码，脚注、目录、批注及修订 | 完整多节版式，复杂表格编辑，环绕与锚点工作流，交叉引用与题注，复杂嵌入对象保真；独立文字内核尚未替换 |
| 表格 | 同一个随包 WASM 实例，使用 Calc 文档模型 | XLSX/ODS，类型明确的单元格与矩阵编辑、公式计算，工作表管理、混合格式提示与富文本单属性写入、格式/合并/行列，排序/筛选/冻结，基础数据验证/条件格式、名称、四类图表与基础透视 | 动态数组与新函数兼容性，复杂规则管理，完整透视和图表体系，表结构引用、外部数据的本地工作流；独立表格内核尚未替换 |
| 演示 | 独立 Vue + PPTX 模型 + SVG 场景 + PDF 导出 | 页面及对象编辑、表格和基本图表数据、历史，混合文字显示、普通文本框改字保留格式、局部文字格式、受支持 SmartArt 节点改字、备注、基础转场与嵌入媒体 | 完整富文本内容编辑，母版设计，SmartArt 结构与布局重算，完整对象动画/路径动画、高级图表与排版 |
| PDF | PDF.js 显示，桌面包内 PyMuPDF 修改文件 | 原文区域替换，文字/图片/高亮/手绘，搜索，页序/旋转/删除/提取/合并，页码、水印、目录导航，简单 AcroForm 文本与独立复选框填写，权限和签名副本保护 | OCR、表单设计与复杂表单填写、证书签名与验证、PDF/UA、跨页重排及 PDF 转可编辑文档 |

表中的“已有”以工作区实现为准，具体通过范围仍见[文字/表格记录](word-excel-365-parity.md)、[演示工作区](standalone-presentation.md)、[PDF 能力](pdf-capabilities.md)。旧版本安装包测试不自动覆盖新增源码；引擎存在方法也不代表完整产品工作流已完成。

## 本轮针对性补充及验收要求

下表描述本轮实施目标；最终通过状态及实际截图见[本轮整体验证](office-completion-results.md)和各专项报告，不能从 REA 静态解析推导“应用测试通过”。

| 工作区 | 补充项目 | REA 对照得出的实现原则 | 必须验证的实际结果 |
| --- | --- | --- | --- |
| 通用 | 格式明确的另存为 | 只展示当前编辑器真实支持的导出格式；另一格式作为副本保留原文稿，不能提前清除未保存状态 | 格式与实际文件一致，取消/冲突不丢失修改，重命名后的后续保存沿用新名称，弹窗键盘与窄窗操作 |
| 文字 | 当前搜索匹配的单次替换 | 优先替换当前匹配，然后选中下一处；同文替换不重写正文，避免跳过当前结果或停在同一项 | 两个重复词，连续单次替换，大小写/整词与保存后正文 |
| 文字 | 基础超链接创建、改址、移除 | 目标 URL 与显示文字独立；使用原生删除及属性写入组合记录撤销，特殊链接属性在改址前保护 | DOCX relationships 与 hyperlink XML、显示文字不变、部分选择不影响两侧、撤销/重做；高级元数据拒绝前后保持不变 |
| 文字 | 删除线、上下标、高亮入口 | 只提交明确修改的属性；关闭或清除是有效命令，不能与“未指定”混淆 | 实际 run 样式与保存重开；混合选区中的未修改属性保留 |
| 表格 | 向下、向右填充 | 交由文档模型复制公式并调整引用；一次历史动作，保留选区 | 相对、绝对、混合及跨表引用，数字和公式外观文字，导出公式与重算结果，撤销 |
| 表格 | 选区统计 | 区分非空计数、数值计数、错误与文本；不可对显示文字简单 Number() 转换；默认仅统计可见行，可切换包含隐藏行，隐藏列仍计入 | 文本数字、空格、零、公式文字结果、错误、日期序列，隐藏行口径切换；读取不改变 revision/dirty；大型范围预算 |
| 表格 | 单格已有规则查看 | 从真实模型读取数据验证与条件格式，只读展示；不能完整表示的规则不得装作默认值 | 单格规则读回及保存重开，同版本刷新保留结果；仅读取不覆盖原规则；未扩展单条编辑/删除或筛选管理 |
| 演示 | 指定段落的行距、段距和对齐 | 段落属性与字符属性分离；按真实 `a:p` 定位，不把 `a:br` 当新段落 | 仅选中段落的 `a:pPr` 改动，保留原 run/未知 XML、显式 0、段前后单位，保存/撤销 |
| 演示 | 文本框垂直对齐、换行和内边距 | 复制并局部更新 `a:bodyPr`；0 值内边距有效，不重建正文 | `anchor`、`wrap`、四侧 inset 写回与画布/PDF，取消/过期草稿保护 |
| PDF | 批注列表、便签、备注修改和删除 | 内容/作者与几何/外观分离；普通备注编辑不重建讨论树；删除对象与清空备注含义不同 | Text/Highlight/Ink 字段、AP/几何/颜色/透明度不变，保存回读、定位与撤销；锁定/富文本/关联讨论只读 |

表格统计默认仅包含可见行，与本轮分析中参考程序跳过高度为 0 的隐藏行的策略一致；用户可切换为包含隐藏行。隐藏列在两种模式下都计入。界面须明确当前口径，这一策略对照不代表所有数值格式或公式语义均已完全一致。

## 研究证据与边界

参考软件为官方 ONLYOFFICE Desktop Editors 10.0.0-169，SDK 源固定在 `72b0421c0bbf9d01eed9cf14834ae47eb2df1b50`。新增下载文件同时对照官方 Git tree 的 blob SHA-1 与本地 SHA-256。REA 6.4.0 只处理必要函数的惰性源码摘录，不执行参考程序，也未将其源码复制进产品。

文字与表格专项：3 个摘录文件、15 个函数、24,675 字节、3,359 个 AST 节点，零解析失败。证据 `ev_4e0b6967d3435880c7f90ca73341d7114d318439859748c2b77ea44535adae16`；完整源码位置、摘录哈希和 REA 函数节点记录于研究目录的 `rea-office-breadth-summary.json`、`office-breadth-targeted/focus-manifest.json`。应用图覆盖完整，但语义图覆盖为 unknown，不能视为动态调用链已经全覆盖。

PDF 与 PPT 属性专项：4 个摘录文件、14 个函数、10,136 字节、1,276 个 AST 节点，零解析失败。证据 `ev_4c228dce2d584e8d6311d5a9adc929ad1f195ff4d47970ceae845618a265ae1b`，细节见研究目录 `rea-office-detail-summary.json` 与 `office-detail-targeted/focus-manifest.json`；同样仅为静态分析，语义覆盖仍是 unknown。

对应的固定源码入口：

- [Word 当前替换与字符属性](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/word/api.js)：`asc_replaceText`、`put_TextPrStrikeout`、`put_TextPrBaseline`、`put_LineHighLight`、超链接 add/change/remove。
- [表格公共入口](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/cell/api.js)：`asc_FillCells`、`asc_getDataValidationProps`、`asc_getCF`。
- [表格模型视图](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/cell/view/WorksheetView.js)：`applySeriesSettings` 与 `getSelectionMathInfo`。本轮未解析更深层公式偏移实现，因此相对引用正确性必须由本应用真实引擎及 XLSX XML 验证。
- [PPT 公共入口](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/slide/api.js)与[文本框属性](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/common/Drawings/Format/Shape.js)：段落格式是属性增量，`setVerticalAlign` 和 `setPaddings` 保留其余 body 属性。
- [PDF 批注字段](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/pdf/src/annotations/base.js)与[删除流程](https://github.com/ONLYOFFICE/sdkjs/blob/72b0421c0bbf9d01eed9cf14834ae47eb2df1b50/pdf/src/document.js)：备注与回复结构、对象外观分开建模。

前六轮 PPT 的实际官方软件打开、双向编辑与独立 XML/PDF 回读记录见 [REA 进展](rea-compatibility-progress.md)。本轮静态证据不替代真实应用操作，也不替代 Windows WebView2、macOS WKWebView 或安装包验证。

## 架构约束与后续优先级

继续将产品界面、命令校验、文档模型、文件导出分开：格式变更提交增量补丁，读取不写回，草稿绑定文档与 revision，保存必须写成功后才标记已保存。公式、版式和批注对象均由对应模型编辑，避免用 DOM 表象或预览图片替代文档语义。

Word/表格若另行替换内核，优先保留当前受限命令合同并在同一份文件集上双轨验证；不能只替换 iframe 或引入官方 Vue 包就称为独立离线内核。ONLYOFFICE 的桌面方案还依赖原生转换与渲染，网页 SDK 包装本身不是完整离线编辑器。研究用源码与产品实现保持分离，发布前仍遵循各现有依赖许可与对应源码要求。

后续先处理会造成内容损失的兼容问题，再补高频编辑，最后扩展高级设计器：已知 XLSX 布尔类型/veryHidden/UNIQUE 重算和 DOCX 特定嵌入附件风险仍需跟踪；现有另存副本保护不等于这些兼容问题已修复。完整替换或新增能力应以“打开→编辑→导出→另一读取器核对→重新编辑”的证据完成，而非菜单数量。
