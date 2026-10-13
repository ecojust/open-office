# Word、Excel 与 Microsoft 365 桌面版功能对照

调研日期：2026-10-13。本文是功能清单与验收计划，不是“完全兼容 Microsoft Office”的声明。官方参考链接在本次调研中已实际读取；微软持续分批发布功能，具体许可、更新频道、平台及企业策略仍须记录。

## 对照基准与证据等级

目标分别为 **Microsoft 365 Word / Excel for Windows 桌面版**、**Microsoft 365 Word / Excel for Mac 桌面版**。Office 2024 永久版、网页版、移动版不是同一个功能集合。不能仅写“最新版”作为验收版本：实际互验须登记应用完整版本/构建、更新频道、操作系统、CPU、语言/区域、字体与许可。版本来源为微软的 [Windows 更新历史][windows-history]、[Mac 更新历史][mac-history]；本轮没有安装或运行微软 Office，也没有完成微软端的双向互验。

本文按**已公开发布的 [Open Office 0.4.0 测试版][release-040]**（prerelease）说明当前实现范围。安装包对应提交 `4788fec61d97d45bd8627e7fd7e3a4fa3bbcbe21`，[构建与发布记录 38348938454][release-run] 全部通过；后续纯文档更新不改变这些安装包的源码提交。引擎是随包 ZetaOffice / LibreOffice 24.2.8.0 WASM；原生桥负责本地文件和 PDF 进程。已有 LibreOffice 菜单、UNO 方法、能看到导入结果，均不等于对应 Microsoft 功能已兼容。

| 状态 | 本文的准确含义 |
| --- | --- |
| 有限已验 | 指定样例的真实操作、导出和重新打开已通过；只覆盖列明的字段与环境 |
| 待验证 | 可能由内核提供，但缺少本应用实际对象/文件回归或 Microsoft 双向互验；不得对用户标注为已兼容 |
| 待实现 | 专用工作流、对象接口或服务尚未纳入产品合同；应实现后再验证，不能用相近菜单代替 |
| 未接入 / 禁用 | 当前离线产品没有相应微软服务，或明确不执行宏、自动外链刷新 |

下表及后面的功能矩阵区分 0.4.0 已实现、部分支持和未完成的范围。实现新按钮、通过类型检查或通过报告合同单测，都不能直接升级为真实文档通过。所有“有限已验”项目的 **Microsoft 原版打开→编辑→保存→本应用再次打开** 仍待验证；“严格对齐 Microsoft 365”仍是目标，不能写成已完成。

### 0.4.0 测试版的验证证据

以下区分功能专项、最终完整 UI 和安装包验收。它们验证列明的样例，不是对任意文档或后续提交的自动认证。默认本地报告路径会在复跑时覆盖，固定发布证据以本页列明的提交与构建记录为准。

`tests/browser/writer-workbench.cjs` 完整回归已在真实 Chromium + 随包 WASM 中通过：中英文原文编辑、字符和段落样式、Heading 1、查找替换、表格单元格、页边距/页眉页脚/页码、批注、脚注、目录、修订设置及记录。测试执行 110 次连续状态读取，确认 revision/dirty 不变，并验证 DOCX 与 ODT 保存重开后的标题、格式和表格仍可读；证据为 `test-results/writer-workbench/report.json`。这些是对应样例的浏览器/内核结果，不是微软 Word 双向互验，也不替代新版三平台安装包验证。

Writer 增量专项及最新完整回归还验证批注导航/删除，以及接受/拒绝选中或全部修订（含实际 `w:del`）。部分选择的 DOCX XML 检查确认只有选中插入文字被接受，前后未选片段仍保留 `w:ins`，再拒绝剩余修订不会删除已接受的部分。`test-results/writer-workbench/table-proof.json` 证明改单独单元格后保存重开，其余单元格的 20pt、粗体及颜色保持。

`test-results/writer-workbench/cas-proof.json` 的实际版本冲突专项通过：晚版本安全写入保留其他格的并发内容，同文字但格式已改变时拒绝覆盖，段落格式 DOCX 重开保持。这种定向安全合并只适用于能完整读取格式指纹的单段纯文字单元格；复杂字段/对象、换行或未知格式仍拒绝过期提交并保留草稿，不宣称通用协同合并。

`tests/browser/calc-workbench.cjs` 的首轮完整真实回归已通过 12 组检查，报告为 `test-results/calc-workbench/report.json`：XLSX 与 ODS 均重开验证公式、格式、工作表顺序/隐藏、命名区域及关联图表/透视表。独立 ZIP/XML 读回验证整数/列表规则、条件格式、筛选清除、冻结 `xSplit/ySplit=1`、图表与透视部件；实际透视输出“北=30”。带制表和换行的文字 `=literal\nline\ttab` 重开后保持 text，与相邻公式和数字正确区分。该轮发现的透视字段集合空显示名问题已改用实际字段 `XNamed`，并在下述同 helper 的两次 XLSX 重开中验证读回“地区”及“Sum - 销量”。

`src/office/native-workbench-smoke.ts` 使用实际 `OfficeEditor`，各自执行两次 DOCX/XLSX 重开与二次编辑；报告校验保留原有所有 PPT/PDF/基础编辑门槛。本轮无探针的 `tests/browser/office-workbench-native-contract.cjs` 已在真实 Chromium、永久 Vue 编辑器、随包 WASM 与独立 PyMuPDF 中通过相同 helper 和发布报告校验。当前正式报告为 `test-results/office-workbench-native-contract/report.json`，`ok=true`、`pageErrors=[]`。即时 Writer 操作使用与产品工具栏相同的当前目标命令通道；草稿提交仍保留严格版本和目标检查。

该次真实结果覆盖 Word 的语义标题、字符样式、表格第二次修改、页边距和页眉页脚，两次 DOCX 重开及独立读回 1 页 PDF；Calc 覆盖两次 XLSX 重开、文字 `00123` / `=SUM(9,9)` 类型保持、公式重算、排序/冻结、唯一柱形图的真实来源、透视字段源索引与 SUM、筛选首存保留及二存清除，并独立读回 3 页 PDF。PDF 按原始页/块/行合并字体片段再比对文字，保留旧文字标记的拒绝检查。**这是与原生发布共用 helper 的浏览器证据，不能单独代表安装包或微软 Office 互验结果。**

[发布构建 38348938454][release-run] 已完成 Windows x64 与 Apple Silicon 最终安装应用的真实 GUI 验收，包含 Word／Calc 工作台及已有 PPT／PDF 门槛。Intel 包在原生 x64 构建机通过构建、签名与文件清单检查，再将同一原封 DMG 送至 Apple Silicon macOS 15，经 Rosetta 运行真实 x64 App 和 PDF 进程并通过完整 GUI 门槛；发布任务随后成功。三个安装包均对应 `4788fec61d97d45bd8627e7fd7e3a4fa3bbcbe21`，但这不等同于物理 Intel GPU 验证。

图表及透视字段的内部名称不是跨格式稳定标识：真实 XLSX 往返中，嵌入图表名称可变为 `Object 1`，透视数据字段的显示标题也可带汇总前缀。验收因此要求唯一真实图表及准确的来源范围、类型、行列表头；透视字段按实际源列索引、独立读回的源表头、方向与汇总函数共同确认，同时保留真实显示名，不以名称相同或对象存在作为通过依据。

滚动视口冻结的实际专项已通过，证据为 `test-results/calc-freeze/report.json`：先从 Writer 切到 Calc，将视口及选区滚到 `Z100`，再分别冻结首行、首列、2 列/3 行及取消冻结。真实状态与独立 XLSX `xSplit/ySplit` 分别为 `0/1`、`1/0`、`2/3`、无冻结；标题区域显示正确，主体视口与 `Z100` 选区保持，同值操作不增加 revision。此专项补足首屏冻结样例覆盖不到的滚动边界，不替代完整中文 App 链路。

发布提交 `4788fec61d97d45bd8627e7fd7e3a4fa3bbcbe21` 的最终完整中文 App UI 已通过 10 项检查，`ok=true`、`errors=[]`、`httpFailures=[]`，报告默认写入 `test-results/word-sheet-ui/report.json`。实际覆盖 Writer 中文正文、同值页面提交、页眉和表格编辑及 DOCX XML 读回；Calc 覆盖带类型单格修改保持 SUM 并重算为 43、选区 `A5:B5` 冻结首行后仍保持且 XLSX `ySplit=1`、图表和透视表保存，以及 Calc→PDF→Calc→PPT 切换时保留同一个 iframe。

显式草稿复核与恢复流程另有 10 项 Node 回归及真实 Vue、受控状态的负例通过。这些负例与完整 UI 是不同的覆盖范围，不能据此宣称完整 WASM UI 已自然触发晚到版本冲突并走过恢复分支。无探针 helper、完整 UI 和各平台安装包的通过记录也不扩大这一分支的验证范围。

| 0.4.0 新增入口/合同 | 实现范围 | 指定样例证据与兼容边界 |
| --- | --- | --- |
| Word 字符与段落 | 字体/字号/粗斜体/下划线/颜色/高亮，段落对齐/缩进/间距/行距，语义样式与标题导航 | 最新完整真实 Writer 样例、只读状态压力及 DOCX/ODT 往返通过；并非任意复杂文档格式已等价 |
| Word 页面 | 页面尺寸/方向/边距，页眉页脚与页码字段，分页/分段/换行 | 首轮实际样例通过；并非任意多节、奇偶页或复杂浮动版式已等价 |
| Word 表格与查替 | 新建矩形表格、原单元格读写；普通大小写/整词搜索、单次/全部替换 | 首轮真实引擎与改单格保留其他格样式专项通过；合并单元格、嵌套表格与 Word 通配符不由此覆盖 |
| Word 参考资料 | 脚注/尾注、目录生成/更新、标题导航 | 首轮脚注/目录样例通过；题注/交叉引用/书目不包含在该证明中 |
| Word 审阅 | 批注创建/导航/删除，修订开关与显示、接受/拒绝当前选择或全部更改 | 首轮与新增专项实际通过，包括部分选区接受后的 DOCX 修订标记检查；尚不代表现代线程批注/共同创作 |
| Word 草稿保护 | 编辑草稿绑定文档、revision 与 selection；截断内容提示，阻止未应用草稿被保存/切页掩盖 | 最终完整 UI 通过；显式复核/恢复另有 Node 与受控 Vue 负例，不冒充完整 WASM UI 已自然触发晚到恢复分支 |
| Calc 工作表与数据 | 新建/复制/命名/重排/隐藏/删除；选区、矩阵写入、带类型单元格 patch、行列操作与大小 | 真实样例、XLSX/ODS 往返、无探针 helper、最终中文 App UI 与所列平台原生门槛通过；未覆盖组合仍单独验收 |
| Calc 类型保护 | `number` / `text` / `formula` / `empty` 明确写入，只改编辑过的单元格，保留原公式、前导零与公式外观的普通文字 | 公式外观文字及制表/换行的 XLSX/ODS 样例通过；同发布 helper 的 `00123` 与 `=SUM(9,9)` 两次 XLSX 保存重开均为 text |
| Calc 样式、排序与冻结 | 字体/颜色/对齐/折行/数字格式、合并、行高列宽；按指定列排序并保留表头、冻结行列 | 完整 XLSX/ODS 样例通过；另通过 Writer 切换后滚至 Z100 的首行/首列/双轴/取消冻结专项，实际状态与 XLSX XML 一致 |
| Calc 持久筛选 | 使用实际 DatabaseRange 保存筛选条件，读回规则，清理筛选时清除规则；不是仅临时隐藏行 | 实际 XLSX autoFilter 与同 helper 的首存条件重开、二存清除后不复活均通过 |
| Calc 规则与名称 | 数字/列表验证、基础条件格式、命名区域，并提供真实规则数据查询 | 整数/列表规则与条件格式已独立检查 OOXML，命名区域 XLSX/ODS 重开通过；不等价于全部微软规则类型 |
| Calc 图表与透视表 | 四种基本图表、真实单元格来源；透视行字段/数据字段及 sum/count/average，删除/刷新入口 | 柱形图来源/类型/表头与 SUM 透视配置、实际聚合及 XLSX/ODS 往返通过；字段显示名修复经同 helper 实际两次 XLSX 重开验证，其余图表类型/汇总组合不由此全覆盖 |
| PDF 配套改进 | 书签导航、页码、半透明文字水印、现有撤销重做与保存流程 | 独立记录于 [PDF 能力说明](pdf-capabilities.md)，不能算 Word/Excel 分页或对象兼容性证明 |

完整验证使用 `test:browser:sheet`、`test:browser:word`、`test:browser:office-ui`、`test:browser:office-native-contract`。其中前两者验证真实 UNO/文件往返，UI runner 验证中文工作台与永久编辑器实例，最后一个直接运行发布所用的相同 helper。0.4.0 发布提交的无探针 helper、完整 UI 和三平台安装包门槛均已通过，Intel 的运行环境按上文明确为 Rosetta。默认报告路径会被复跑覆盖，须结合对应提交、运行时间和最终状态引用，不能仅按目录名称认定通过。`test:browser:workbench-drafts` 是有意义的轻量草稿/过期状态合同回归，**不加载 WASM，因此不作为文档功能通过证据**。

0.4.0 发布提交的完整测试通过 242 项 Node 回归和 28 项真实 Python PDF 测试，发布构建中的 Rust 检查、前端构建及各平台原生门槛也已通过。中文 App 跨类型 UI、滚动冻结专项与同发布 helper 的浏览器证据见上文。该版本已作为公开测试版发布；这些结果不替代 Microsoft 原版互验，也不保证任意复杂文档无损兼容。

## Word：本地核心编辑与版式

微软的 [Word 功能与学习目录][word-home] 区分文字、页面、表格、审阅、保存及打印等任务；本产品按文档语义逐项验收。

| 类别 | 需要对齐的具体能力 | 0.4.0 当前范围与未验边界 |
| --- | --- | --- |
| 文件与正文 | 新建、打开、保存、另存为；中英文正文编辑；DOCX / ODT / PDF | DOCX/ODT 指定样例往返及 DOCX 二次编辑有限已验，PDF 有独立文字读回；任意复杂文档与微软双向互验未完成 |
| 字符样式 | 字体、字号、粗斜体、下划线、颜色、高亮、上下标、字符间距、清除格式 | 基础文字样式已实现，指定样例读回有限已验；上下标、字符间距和完整样式清除不在当前工作台验证范围 |
| 段落 | 对齐、左右/首行/悬挂缩进、段前后距、行距、制表位、孤行控制、与下段同页 | 对齐、缩进、段距和比例行距已实现，指定样例有限已验；制表位、孤行控制、同页规则及复杂分页待验证 |
| 样式体系 | 段落/字符样式、标题级别、基于其他样式、样式更新、主题字体与颜色 | 原生样式应用、语义标题和大纲导航已实现，Heading 1 往返有限已验；完整继承/主题体系未对齐 |
| 列表 | 项目符号、编号、多级列表、继续/重启编号、与标题关联 | 待验证；插入和删除中间条目后重新计算编号 |
| 页面与节 | 纸张、方向、页边距、分栏、页边框、分页符、分节符、节内不同布局 | 基础页面尺寸/方向/页边距及分页已实现；工作台的分段/换行不是分节符，横竖混排、连续分节等未验收。[节参考][word-section] |
| 页眉页脚 | 首页不同、奇偶不同、与上一节链接、页码/总页数、起始页码 | 页眉页脚文字和真实页码字段已实现，样例有限已验；首页/奇偶页/节链接及完整页码规则未对齐 |
| 表格 | 插入、行列增删、合并拆分、列宽行高、单元格边距、边框底纹、跨页重复标题 | 矩形表格插入、单元格数据及二次修改有限已验；仅写改变的格子，未改格样式有专项；其余高级结构/跨页版式待验证 |
| 图片与形状 | 插图、裁剪、旋转、透明度、替代文本、锚点、环绕、层级、组合、文本框 | 待验证；内嵌/浮动布局分别建样例，保存后仍可编辑 |
| 图表、SmartArt、嵌入对象 | 可编辑图表数据、组织图节点、对象链接/嵌入、公式对象 | 待验证；静态图片或普通形状导入不算保留原对象语义 |
| 查找替换 | 普通文本、大小写、整词、格式条件、通配符及替换范围 | 普通文本、大小写/整词、单次/全部替换已实现并有限已验；格式查替与 Word 通配符未实现对应合同 |
| 导航与视图 | 标题导航、页面导航、缩放、显示格式标记、大纲/草稿/打印布局 | 语义标题导航已实现；其余原生视图的 Microsoft 等价行为待验证 |
| 剪贴板与历史 | 撤销重做、保留/合并/纯文本粘贴、表格和图片粘贴、IME 组合输入 | 待验证；不能只在 JS 字符串层模拟剪贴板或撤销 |
| 打印与输出 | 打印范围、单双面、纸张、PDF 书签/链接/字体/无障碍标签 | PDF 基础输出有限已验；系统打印队列及高级 PDF 语义待实现/验证 |
| 无障碍 | 标题层级、图片替代文本、表头、阅读顺序、键盘操作、屏幕阅读器 | 待验证；无障碍检查器报告和标签化输出单列验收。[官方工具][word-accessibility] |

## Word：长文档、审阅与高级功能

| 类别 | 对齐目标 | 当前边界 |
| --- | --- | --- |
| 自动目录 | 标题级别、目录字段、超链接、页码更新、自定义样式 | 生成和更新原生目录已实现，基础样例有限已验；完整超链接、自定义样式和重分页兼容仍待验证。[官方目录][word-toc] |
| 引用与索引 | 脚注/尾注、题注、交叉引用、书签、索引、引文与书目 | 脚注/尾注入口已实现，脚注样例有限已验；题注/交叉引用/引文书目及全部刷新规则不在该证明中 |
| 修订 | 开关、插入/删除/格式修订、作者、显示模式、逐项/全部接受拒绝 | 开关/显示及接受拒绝选区或全部修订已实现，插入/删除及部分选区 DOCX 标记有限已验；完整格式修订和多作者互验待验证。[修订参考][word-tracking] |
| 批注 | 锚定范围、作者、回复、解决/重新打开、现代批注表现 | 普通批注创建/导航/删除已实现并有限已验；现代线程回复、解决状态和云通知未对齐 |
| 比较与合并 | 比较两个版本、法律黑线、合并多个审阅者的更改 | 待实现/验证；文件 SHA 冲突检测不等于正文差异比较 |
| 邮件合并 | 数据源、合并字段、条件规则、预览、信函/标签/信封、邮件发送 | 待实现/验证；本地批量文档与依赖邮件客户端的发送分开验收。[邮件合并][word-mailmerge] |
| 内容控件与表单 | 文本、日期、复选框、下拉、重复节、XML 映射、保护区域 | 待验证；控件能显示不等于可交互、数据绑定和保存均兼容 |
| 文档保护 | 编辑限制、只读建议、打开密码、数字签名、证书、敏感度标签/IRM | 普通文件冲突保护有限已验；其余待实现/验证。标签/IRM 还依赖授权服务，不能当普通密码移除 |
| 校对与语言 | 拼写、语法、词典、同义词、断字、翻译、朗读/听写、数学公式 | 待验证；基础本地校对与在线 Editor、翻译、听写分开标记，不把内核拼写菜单算成微软 Editor |
| 模板与自动化内容 | DOTX / DOTM、样式集、自动图文集、Quick Parts、域代码 | 待实现/验证；当前文件入口支持范围之外的格式不能伪装为 DOCX 打开 |

## Excel：本地数据、计算与工作簿

基于 [Excel 功能目录][excel-home] 和 [函数官方清单][excel-functions] 建样例。公式验证须同时比较**公式表达式、值、类型、错误码、依赖重算和保存重开**；同一数值不代表相同公式语义。

| 类别 | 对齐目标 | 0.4.0 当前范围与未验边界 |
| --- | --- | --- |
| 基本文件/单元格 | XLSX / ODS、新建/保存、文字/数字/空值/布尔/错误值 | XLSX/ODS 及二次 XLSX 保存重开有限已验；明确区分 text/number/formula/empty，前导零与公式外观文字有样例；全部布尔/错误类型语义待验证 |
| 工作表管理 | 新增、复制、删除、命名、顺序、隐藏/取消隐藏、跨表引用 | 基础管理已实现并有 XLSX/ODS 样例，保护最后可见表；任意复杂跨表引用的重命名/移动兼容待验证 |
| 编辑与选区 | 单区/多区、行列增删、拖填、序列、复制粘贴、查替、撤销重做 | 单区域读取、矩阵/带类型单格写入和行列操作已实现；完整多区、拖填、粘贴与引用重写组合待验证 |
| 单元格样式 | 数字格式、日期/货币/百分比、字体、填充/边框、对齐、折行、合并、行高列宽 | 基础格式及有内容时拒绝破坏性合并已实现，样例有限已验；全部数字格式、边框及复杂合并布局未对齐 |
| 公式基础 | 四则、比较、逻辑、引用、绝对/相对/混合引用、跨表和命名区域 | 仅 SUM 样例有限已验；其余待验证，不能由 SUM 推广为全函数兼容 |
| 函数兼容 | 聚合、条件聚合、日期、文本、查找、财务、统计、工程、信息等 | 每个函数/参数组合待验证；例如 [XLOOKUP][excel-xlookup] 的匹配/搜索模式、缺失值与返回数组需分别测试 |
| 动态数组 | FILTER / SORT / UNIQUE / SEQUENCE、溢出范围、#SPILL!、隐式交叉 | 待验证；要检查扩展/阻塞/清除后的真实溢出，不以手写填充结果替代。[动态数组][excel-arrays] |
| 新函数与自定义公式 | LET、LAMBDA、MAP/REDUCE 等辅助函数及当前函数表中的 REGEX 系列 | 待验证；按微软具体版本锁定函数清单与错误语义。[LAMBDA][excel-lambda] |
| 计算模型 | 自动/手动重算、循环/迭代、易失函数、精度、错误传播、1900/1904 日期系统 | 待验证；使用日期边界、长小数、时区无关日期、重算和缓存失效样例 |
| Excel 表格 | 结构化引用、表头/汇总行、自动扩展、表格样式、筛选 | 待验证；普通带边框区域不能冒充 Excel Table/ListObject |
| 排序筛选 | 多关键字、文本/数值/日期、自动筛选、高级条件、清除筛选 | 单列排序及单条件持久筛选已实现，首存和二存清除有限已验；多关键字/高级条件组合未对齐 |
| 数据验证 | 整数/小数/日期/列表/自定义公式、空值规则、输入提示、错误警告 | 整数/小数范围、列表及空值设置已实现；整数/列表 OOXML 有限已验，不覆盖全部输入路径、日期和自定义公式规则 |
| 条件格式 | 值/表达式、色阶、数据条、图标集、优先级、停止规则、引用范围 | 基础数值条件规则已实现并检查保存的 OOXML；色阶、数据条、图标集及完整优先级行为未对齐 |
| 视图与打印 | 冻结/拆分、缩放、分页、打印区域、重复标题、缩放至页、页眉页脚 | 冻结/取消冻结含滚动 Z100 专项有限已验，PDF 有实际页数和文字读回；高级分页与系统打印未完成对应验收 |
| 图表 | 柱/条/折线/饼/散点/组合等、系列和分类轴、数据标签、次坐标轴 | 四种基本图表入口已实现；柱形图来源/类型/表头实际往返有限已验，不能据此覆盖所有图表类型和系列属性 |
| 名称与链接 | 工作簿/工作表级名称、名称公式、外部工作簿链接及刷新策略 | 命名区域基础样例 XLSX/ODS 往返有限已验；全部作用域/名称公式待验证，自动外链更新禁用 |
| 保护与可访问性 | 单元格锁定、工作表/结构保护、密码、辅助技术、可读表格与图表 | 待验证；保护工作表不等于加密文件，不能合并为一个“保护”开关 |

## Excel：高级分析、扩展和平台差异

| 能力 | 微软官方范围/差异 | 本应用状态 |
| --- | --- | --- |
| 数据透视表/图 | 行列字段、聚合、筛选、分组、计算字段、刷新、切片器/时间线分别验收；平台具体操作有独立说明。[透视表][excel-pivot] | 真实透视对象、单行字段/数据字段及 sum/count/average 已实现，SUM 配置和结果往返有限已验；其余汇总组合、多字段、切片器/时间线与透视图未对齐 |
| Power Query | Windows 与 Microsoft 365 Mac 均有体验，但连接器和导入/刷新范围不同；微软提供逐平台来源表。不能笼统说 Mac 没有 Power Query。[来源矩阵][excel-query] | 未实现兼容 M 查询引擎/完整连接器合同；普通 CSV 导入不能算 Power Query |
| Power Pivot / 数据模型 / DAX | 微软以独立功能说明；不可将 Mac 的基础透视表、Power Query 与 Windows Power Pivot 插件视为同一能力。[Power Pivot][excel-powerpivot] | 待实现；关系、度量值、DAX 与模型刷新单列，不把普通 SUM 透视结果冒充数据模型 |
| 假设分析 | Goal Seek、Scenario Manager、数据表、Solver、Analysis ToolPak 等 | 待实现/验证；区分内核相似算法、微软加载项与数值/约束结果一致性 |
| Python in Excel | Python 在 Microsoft Cloud 的隔离容器执行，不是调用用户本地 Python。可用平台/频道/许可随官方表变化。[可用性][excel-python-availability] [安全模型][excel-python-security] | 未接入；随包用于 PDF 的 Python 完全不是 Python in Excel，不能作为功能实现证据 |
| VBA | 微软 Windows 与 Mac 桌面应用均有 VBA，Mac 对文件/跨进程访问有沙箱差异。[Mac VBA][office-mac-vba] | 宏执行禁用；LibreOffice Basic/UNO 与 VBA 对象模型不同，不能自动称兼容 |
| COM、VSTO、ActiveX、原生 XLL | 属于需要按 Windows 技术栈/位数/加载项类型单独核查的能力；Mac 官方文档明确不支持第三方 COM 加载项 | 未实现；不能在 Tauri/WASM 中假设可装即用，也不为实现表格功能默认启用外部代码 |
| Office Add-ins | 微软的 JavaScript 扩展平台覆盖多个 Office 客户端，但 API requirement sets 与宿主支持不同。[平台说明][office-addins] | 未接入 Office.js 宿主；普通网页 iframe 或自定义插件接口不能算 Microsoft 加载项兼容 |
| Office Scripts | 有 Windows、Mac、Web 的平台/版本、许可和联网要求，脚本与 Power Automate/云存储联动；不是 VBA 的离线替代。[平台限制][office-scripts-limits] | 未接入；本产品内部 JS 自动化不宣称与 Office Scripts 等价 |

Windows 与 macOS 的字体度量、系统打印、输入法、快捷键、文件授权及 WebView 行为也必须分别测试。0.4.0 的原封 Intel 安装包已在 Apple Silicon 上经 Rosetta 完成实际 x64 GUI 验收；**Rosetta 通过不是 Intel 实机 GPU/字体/打印全部通过**。

## 云服务与账号功能

| 类别 | 原版包含的服务边界 | 当前产品 |
| --- | --- | --- |
| 共同创作 | OneDrive/SharePoint、权限、协作光标、合并冲突、现代批注通知 | 未接入；本地标签切换和摘要冲突检查不等于实时多人协作 |
| 自动保存与版本历史 | 云文件 AutoSave、历史版本恢复及组织留存策略 | 未接入；本地保存、最近文件、撤销栈均不能替代历史版本服务 |
| Copilot | Word 内容生成/改写与 Excel 数据/公式/分析等；模式、许可、账号、管理员设置决定可用范围。[Word][word-copilot] [Excel][excel-copilot] | 未接入；不在离线引擎中伪造“微软 Copilot”入口 |
| 在线校对/语音/翻译 | Microsoft Editor 高级能力、翻译、听写、联网素材和模板 | 待实现/验证；本地可用部分单独说明，不承诺离线覆盖在线结果 |
| 企业治理 | 敏感度标签、IRM、条件访问、组织资产、审计/DLP | 未接入；文件格式支持不能代替组织身份、策略和解密授权 |
| 联机数据 | 云数据类型、连接器刷新、组织数据、脚本调度 | 未接入；不得把缓存结果显示正确当成刷新/身份验证已通过 |

## 现行真实对象回归合同

现有 `scripts/native-smoke.mjs::validateFrontendReport` 保留隔离环境、Writer 正文 DOCX 往返、Calc SUM 重算、Impress PPTX/ODP/PDF、PPT 工作台以及独立 PDF 原文替换的门槛，并已追加 Word／Calc 工作台二次保存重开检查。原生流程另检查架构、签名和实际安装布局。每次发布仍须实际运行这些检查，不能仅凭校验器存在判定通过。

现行流程已生成带合同版本的 `wordWorkbench`、`sheetWorkbench` 结构化报告；真实 Vue `OfficeEditor` 调用工作台对象 API，各执行两次保存重开以检查关键行为。报告中的成功标记来自读回值的断言，而不是按钮执行后直接置 `true`。合同已实现不等于候选提交已通过，仍须运行并审核对应报告。

1. **Word 样例**：中英标题和正文、实际字符/段落样式、2×2 原生表格、页边距、页眉页脚、查找替换。DOCX 保存重开后读回对象、再次修改表格/正文再保存重开；PDF 由独立后端读取文字和页数。目录、修订、批注、脚注在各自真实接口稳定后增加，不能塞进未测的笼统 `allFeatures: true`。
2. **Calc 样例**：工作表新增/命名、数据矩阵、SUM 与编辑后的依赖重算、字体/数字格式、排序、冻结。可编辑图表和透视表必须读取实际对象及数据；校验规则、隐藏筛选行和条件格式需专门查询合同，只有执行动作而没有读回不算保存通过。
3. **二次保存与错误路径**：重开后修改原对象再保存；旧 revision、跨文档 ID、越界范围、非法规则应在修改前拒绝；失败导出不得清除 dirty，保存冲突不得覆盖外部文件。
4. **独立校验**：DOCX/XLSX 包中检查相关 OOXML 部件/关系；PDF 由独立引擎读回。OOXML 检查不是微软渲染器验收，也不能替代真实可编辑对象。
5. **门槛负例**：测试缺失工作台报告、错文本/错单元格、样式退化、图表被图像代替、第二次保存丢失、旧报告伪 `ok:true` 均拒绝发布。原生报告仅包含生成的固定样例和必要结构化结果，不包含用户文档。
6. **原版互验另建记录**：在真实 Microsoft 365 Windows 与 Mac 环境，用固定样例做双向保存、对象编辑、公式重算、分页与打印比较。记录实际支持及差异，不在没有安装 Office 的环境里宣称完成。

0.4.0 测试版已发布；软件版本号本身不增加兼容性证明。新增对象 API、真实回归、三平台最终应用与 Microsoft 原版互验分别记账，按实际结果逐项更新。

## 官方来源

下列为功能基准资料；各页的“适用于”与许可/平台说明优先于产品宣传摘要。

[windows-history]: https://learn.microsoft.com/en-us/officeupdates/update-history-microsoft365-apps-by-date
[mac-history]: https://learn.microsoft.com/en-us/officeupdates/update-history-office-for-mac
[release-040]: https://github.com/ecojust/open-office/releases/tag/desktop-v0.4.0-38348938454
[release-run]: https://github.com/ecojust/open-office/actions/runs/38348938454
[word-home]: https://support.microsoft.com/en-us/word/
[word-section]: https://support.microsoft.com/en-us/word/insert-a-section-break
[word-accessibility]: https://support.microsoft.com/en-us/accessibility/word/accessibility-tools-for-word
[word-toc]: https://support.microsoft.com/en-us/word/training/insert-a-table-of-contents
[word-tracking]: https://support.microsoft.com/en-us/word/training/track-changes-in-word
[word-mailmerge]: https://support.microsoft.com/en-us/word/use-mail-merge-for-bulk-email-letters-labels-and-envelopes
[word-copilot]: https://support.microsoft.com/en-us/word/copilot/draft-and-add-content-with-copilot-in-word
[excel-home]: https://support.microsoft.com/en-us/excel/
[excel-functions]: https://support.microsoft.com/en-us/excel/excel-functions-alphabetical
[excel-xlookup]: https://support.microsoft.com/en-us/excel/functions/xlookup-function
[excel-arrays]: https://support.microsoft.com/en-us/excel/dynamic-array-formulas-and-spilled-array-behavior
[excel-lambda]: https://support.microsoft.com/en-us/excel/functions/lambda-function
[excel-pivot]: https://support.microsoft.com/en-us/excel/get-started/create-a-pivottable-to-analyze-worksheet-data
[excel-query]: https://support.microsoft.com/en-us/excel/power-query-data-sources-in-excel-versions
[excel-powerpivot]: https://support.microsoft.com/en-us/excel/power-pivot-overview-and-learning
[excel-python-availability]: https://support.microsoft.com/en-us/excel/python/python-in-excel-availability
[excel-python-security]: https://support.microsoft.com/en-us/excel/python/data-security-and-python-in-excel
[excel-copilot]: https://support.microsoft.com/en-us/excel/copilot/get-started-with-copilot-in-excel
[office-mac-vba]: https://learn.microsoft.com/en-us/office/vba/api/overview/office-mac
[office-addins]: https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins
[office-scripts-limits]: https://learn.microsoft.com/en-us/office/dev/scripts/testing/platform-limits
