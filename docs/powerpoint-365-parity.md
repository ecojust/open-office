# PowerPoint Microsoft 365 功能对齐审计

核验日期：2026-10-13。代码基线：Open Office 0.2.0，提交 `1c21e54`；办公引擎为固定版本 ZetaOffice / LibreOffice 24.2.8.0 WASM。本文是现状与实施选择的审计，不是已经完成 Microsoft 365 功能对齐的声明，也不决定下一版架构。

**现有产品能完成基本演示文稿编辑与文件往返，但不能称为 Microsoft 365 桌面 PowerPoint 的完整替代。** “加载了 Impress 完整办公界面”不等于所有菜单在此 WASM 构建中可用，更不等于 PowerPoint 对象、播放行为和文件兼容性已通过验证。

## 1. 核验范围与证据等级

本次检查了主程序、办公适配器、原生文件桥、预览组件、已有回归脚本和现存测试结果，读取了 Microsoft 官方公开文档，并在临时环境执行了有超时限制的原生放映探测；没有重新跑完整平台测试，也没有新增产品功能。

| 标记 | 含义 |
| --- | --- |
| 已有证据 | 有实际引擎或完整应用回归结果；支持范围仅限被检查的行为和样例 |
| 有实现，未完整验证 | 能在代码中定位实现，但尚未覆盖目标平台、文档类型或复杂交互 |
| 未验证 | 原生内核可能提供能力，但没有当前固定构建中的实际操作与保存重开证据；不能作为已支持功能宣传 |
| 未实现／已禁用 | 主程序未接入此能力，或因实际故障明确禁用；不据此断言上游所有版本均不支持 |

当前直接证据：

- [`tests/browser/impress-engine.cjs`](../tests/browser/impress-engine.cjs) 与现存 `test-results/impress-engine/report.json`：真实 WASM 引擎修改既有幻灯片文本，保存重开 PPTX 与 ODP，验证两页及中文文本；插入图片、导出文件、新增页、F5／Shift+F5 路由也有实际检查。报告 `ok: true`。
- [`tests/browser/presentation-ui.cjs`](../tests/browser/presentation-ui.cjs) 与现存 `test-results/presentation-ui/report.json`：完整应用中新建、增加幻灯片、打开中文样例、导出异格式副本、重新打开、独立回读 PDF 页数和中文文本、静态预览翻页及退出。报告 `ok: true`，错误列表为空。
- [`public/office/office-worker.js`](../public/office/office-worker.js)：Impress 对象模型及导入导出过滤器；新增页只沿用当前页母版和布局；不是复制整页内容。
- [`scripts/native-smoke.mjs`](../scripts/native-smoke.mjs)：原生发布验收要求真实 PPTX／ODP 重开后的两页与指定文本，及独立 PDF 回读两页。**检查脚本存在不代表任意安装包已通过，必须关联该安装包的实际报告和摘要。**
- [`src/components/SlidePreview.vue`](../src/components/SlidePreview.vue)：通过 PDF.js 将 PDF 页渲染到 Canvas；不是逐对象演示播放引擎。
- WASM 原生放映在本轮实际调用中发生崩溃，当前产品明确拒绝 `start-presentation`／`end-presentation`，将放映、从当前页放映、排练计时及 F5 转为静态预览。不能把这些被重定向的菜单视为原功能可用，也没有足够证据断言故障源于特定编译裁剪。

这些结果不证明 PowerPoint 本身能无损重开所有输出。现有样例主要检查文字、页数、基本图片与文件流程；没有全面验证复杂图表、SmartArt、母版、动画、音视频、批注和辅助技术。

### 当前构建的动态放映与媒体核验

- 0.2.0 的实际安装包验证记录为 [Actions 38325471381](https://github.com/ecojust/open-office/actions/runs/38325471381)。Windows、Apple Silicon 和原封 Intel DMG 的 Rosetta 验证通过；这些既有检查的范围仍是基本编辑、保存重开与 PDF 导出，不包括动画放映验收。
- 原生 `XPresentation.start()` 曾在真实 Chromium 中出现 `memory access out of bounds`；当前产品仍禁用完整放映。最新一轮全屏、窗口化和 `ParentWindow` 探测发现测试服务的 CSS MIME 有遗漏，画布停留在默认尺寸，因此这轮结果只作初步记录，**不据此判定所有窗口化方案不可行**。正在使用正确画布复核。尚未定位原生崩溃根因，不能将其归因于媒体裁剪。
- `Preview=true` 的单页预览在初步探测中能返回 `running=true`，无动画样例随后自动结束；该探测同样需要正确画布复核。源码将它视为动画预览模式，指定动画节点时还会禁用页面切换；调用能返回既不是完整放映成功，也不证明实际动画播放。[lo-preview]
- 从本机随包 `soffice.data` 的 `versionrc` 读取的核心 build ID 为 `efaf0670b4d055f838a2849becb10f08aa06a257`。按 `soffice.data.js.metadata` 中的文件偏移提取 `services/services.rdb`，其中有 `com.sun.star.presentation.SlideShow` 和 VCL／Cairo Canvas 服务，但没有 avmedia 组件或 `com.sun.star.media.Manager`。
- 同一构建的官方源码在默认 WASM strip 配置中设置 `enable_avmedia=no`；Qt 5.15 官方文档也明确 QtMultimedia 不适用于该 WASM 平台。因此不能通过打开一个菜单或放映开关，获得这份固定内核中缺失的原生音视频后端。[lo-wasm-config][qt5-wasm]
- 仅重新下载并核对了官方 CDN 的 `soffice.js` 与 `soffice.data.js.metadata`，两者与锁定摘要一致；未重新下载所有大型二进制，也不能据此声称已排查所有商业或私有构建。此次公开版本调查未找到可直接替换且明确修复放映的发行版。

## 2. “Microsoft 365 桌面版”需要固定基线

Microsoft 的[官方跨平台比较表][ms-compare]明确说明其清单不是穷举，而且 Windows 与 Mac 不完全相同。例如：

- 幻灯片母版编辑、图表、SmartArt、演讲者视图、录制和自定义放映列为 Windows／Mac 桌面能力；网页版并不全部具备。
- **动画触发器**在该表中列为 Windows PC 支持、Mac 不支持；不能用一个平台的结果替代另一个平台。
- 快捷键体系、可定制快捷键、媒体能力也有平台或订阅条件差异。
- Copilot 功能取决于许可证、组织设置、更新渠道及分批开放状态；不是所有标有 Microsoft 365 的安装都会拥有同一能力。[ms-copilot]

验收基线应记录：Windows／macOS 版本、PowerPoint 完整版本与更新渠道、许可证类型、启用的云服务、测试字体、目标显示器及音视频设备。分别建立 Windows 和 Mac 矩阵；服务更新后复核。不能先承诺一个没有版本边界的“全部功能、完全一致”。

## 3. 核心能力矩阵与实际验收标准

下表的验收标准是后续完成该项时必须得到的证据，**不是当前已通过的结果**。

| 能力 | Open Office 0.2.0 状态与实质差距 | 达到该项的实际验收标准 |
| --- | --- | --- |
| 基本文字、形状、图片、多页编辑 | **已有有限证据**：文字修改、中文、图片插入、新增页、基本导出。复杂文本布局、组合、连接线、选择与对齐等原生菜单仍不能仅凭存在视为通过 | 在真实 UI 创建和修改文本框、形状、组合、连接线及图片；检查层级、旋转、裁剪、透明度、撤销重做；保存后由本应用和目标 PowerPoint 双向重开，内容仍可编辑 |
| 幻灯片管理、备注、节、自定义放映 | **已有部分证据**：新增页。删除／复制／重排／隐藏页、节、备注编辑、自定义放映未被现有矩阵完整覆盖 | 含多个节、隐藏页、备注的样例完成增删复制排序与撤销；双向重开保持顺序、隐藏状态及备注；自定义放映必须实际按所选顺序播放 |
| 母版、布局、占位符、主题与模板 | **有实现但未完整验证**：新增页继承母版和布局。母版编辑、主题颜色／字体、不同母版并存、占位符继承和模板往返未验证 | 创建至少两个母版及多个布局，修改母版后子页正确联动；区分占位符与普通文本框；验证主题字体／颜色、页眉页脚、页码、背景、页面尺寸及重置布局；由 PowerPoint 重开保持可继续编辑的结构 |
| 表格、图表和数据源 | **未验证**：Impress 菜单或 UNO 服务不等于当前构建已验证。没有图表类型、系列、标签、嵌入工作簿及外链的往返矩阵；自动外链更新当前明确禁用 | 对约定图表类型逐一修改数据、系列、轴、标签和样式；重开后仍是可编辑图表而不是图片；嵌入工作簿与关系正确；链接刷新需要单独授权、失败提示及离线行为验证 |
| SmartArt | **未验证／无完整对齐实现**：不能将“导入后可见”或转为普通形状当作保留 SmartArt 编辑能力 | PowerPoint 创建层级、流程、循环等样例；本应用更改节点与布局后回到 PowerPoint，仍可在 SmartArt 文本窗格与设计工具中修改；保留节点、布局、样式和关联关系，而非栅格化 |
| 动画、时序、路径、触发器 | **播放已禁用；编辑及往返未验证**。静态 PDF 不包含逐对象时间轴。Windows／Mac 目标功能还需分别界定 | 实际播放进入／强调／退出、按段落、动作路径、开始条件、延迟与重复；检查点按序列、音画同步及暂停继续；PPTX 双向重开仍可编辑动画；Windows 专属触发器单独验收 |
| 页面切换、Morph、Zoom | **未实现对齐、未验证保真**。Morph 不等于普通淡入淡出；静态预览不能验收任何对象补间或交互导航 | 使用目标 PowerPoint 制作对象、文字、图片 Morph 及约定 Zoom 样例，检查对象身份、运动、裁剪、时长及返回行为；双向重开后行为一致。官方说明 Morph 本身也有适用限制，例如图表不参与 Morph；按官方定义验收，不自行扩张定义。[ms-morph] |
| 音频、视频、在线媒体 | **当前固定 WASM 构建缺少原生媒体后端，产品流程未实现**：已核对源码配置和实际服务清单；没有对应原生选取、嵌入、播放与保存重开回归。此结论不扩展为上游所有 Impress 版本均无媒体功能 | 使用本地音视频验证嵌入和链接、播放顺序、裁剪、书签、淡入淡出、跨页音频及字幕；明确支持编解码器；离线仍能播放嵌入媒体；在线源失败需可恢复；验证文件重开后的媒体字节和关系 |
| 演讲者视图、双屏、笔／激光笔 | **未实现**：现有全屏是 PDF 静态页面，不提供观众屏与演讲者屏、备注／下一页／计时器 | 两个真实显示器测试观众画面、演讲者备注、下一页、计时、屏幕切换、休眠及热插拔；实际使用笔／激光笔并验证保存选择；不能只用两个浏览器窗口截图替代设备验证 |
| 排练计时、录制、摄像头、导出视频 | **未实现**：排练菜单被转为静态预览；没有语音、墨迹、摄像头录制或视频导出。Microsoft 的录制包含旁白、时间、墨迹与视频，并可导出视频文件。[ms-record] | 完成多页旁白／摄像头／墨迹录制、局部重录、清除录制及重排页面；保存重开并真实播放，导出视频可被独立播放器读取；验证时长、同步、字幕、麦克风权限、取消与错误恢复 |
| 批注、回复、@提及、审阅 | **本地批注未验证；云协作未实现**。不能将内核可能存在的批注菜单等同 Microsoft 365 现代批注和任务 | 由 PowerPoint 制作批注线程，测试作者、锚点、回复、解决状态和删除的双向往返；@提及通知及任务必须在真实已授权账户间验证；仅本地文本批注应单独标明范围 |
| 共同创作、冲突处理、版本历史 | **未实现**：本应用的“最近文件”和摘要冲突保护不是历史版本或多人编辑。Microsoft 官方共同创作与历史版本依赖 OneDrive／SharePoint 等服务。[ms-collaboration] | 两个真实账户同时改同一文件；验证在线状态、光标／修订、冲突处理、离线重连、权限撤回、版本恢复及审计；不得用模拟在线头像或定时覆盖整个 PPTX 当作共同创作 |
| Designer／Copilot 与组织资产 | **未实现**：无设计服务、Microsoft 365 登录、Copilot 授权或租户资产接入 | 按选定许可证与组织策略测试生成、改写、摘要、基于来源制稿及组织模板；记录数据发送边界、引用、联网与额度失败；本地模型或第三方模型只能作为独立 AI 能力，不能称为 Microsoft Copilot 等价服务。[ms-copilot] |
| 文件格式与显示保真 | **已有基本 PPTX／ODP 往返证据，全面保真未验证**。不接受旧 PPT；PPTM／POTX／PPSX 等不在当前扩展名白名单。宏及自动外链更新被禁用 | 建立 PowerPoint 生成的真实样例库；固定字体和 DPI，比较逐页视觉输出，同时检查 OOXML 结构、图表／媒体／SmartArt／备注／批注／时间轴等仍可编辑；改变一处后重开，不能只比较未编辑的原文件；加密、缺字体、外链及未知扩展有明确处理规则 |
| 无障碍创作、阅读与导出 | **只有部分外壳键盘／ARIA 支持**。Canvas 预览的“第 N 页”标签不向读屏软件提供整页文本、对象及阅读顺序；未验证内核辅助技术桥、替代文本、检查器或带标签 PDF | Windows 实测 NVDA／目标读屏软件，Mac 实测 VoiceOver；验证键盘完成编辑、对象名称、焦点、阅读顺序、图片替代文本、对比度提示、媒体字幕与独立可访问 PDF；带标签输出需由检查工具及读屏软件回读。[ms-accessibility] |
| 打印、扩展及受保护文档 | **部分／未实现**：打印通过 PDF 后交系统阅读器；旧格式、加密交互、宏／插件不是当前兼容承诺 | 幻灯片／讲义／备注的纸张、缩放、双面等需实际打印或独立系统队列验证；VBA、插件、密码和企业保护须分别定义支持及信任模型，不能为了通过兼容检查自动执行宏或解除保护 |

保真测试必须区分“视觉相似”“对象仍可编辑”“播放行为相同”“跨应用双向往返”四种结论。一个漂亮截图或成功保存的 PPTX 不能替代后三项。

## 4. 可以选择的实施路线

当前尚待明确是否接受用户设备安装并授权 Microsoft PowerPoint。本节保留选项，不选择新架构。

| 路线 | 实际能解决什么 | 主要代价与不能承诺的部分 |
| --- | --- | --- |
| 继续使用现有 ZetaOffice WASM + UNO | 保留离线、同一 Vue／Tauri 窗口及现有文件流程；逐项补本地编辑、布局、母版、图表、备注等能力的桥接与验证 | 动态放映故障必须在真实构建中修复或更换引擎；为 PDF 预览加按钮不能变成动画播放器。SmartArt、Morph、媒体和现代批注仍需独立兼容工程；不能承诺 Microsoft 365 全功能 |
| 使用原生 LibreOffice 进程及 UNO | 可针对官方原生放映、媒体及演讲者能力建立离线实现；先用独立原生窗口验证比直接重写播放器更具体 | 原生 API 能力仍须在发行包中实测；嵌入 Tauri 画布、输入、窗口生命周期和多屏是单独工程。LibreOffice 官方本身列出 PowerPoint 导入导出限制，不等于 PowerPoint 引擎。[lo-start][lo-compat] |
| 换其他第三方演示引擎 | 可能改善某些格式、编辑界面或播放体验 | 必须用相同矩阵和样例实测，并核对离线许可、分发、原生平台和安全接口；营销页中的“兼容 Microsoft Office”不能作为全功能或无损保证 |
| 依赖本机正版 PowerPoint | 由真正 PowerPoint 处理其本身的母版、SmartArt、Morph、动画、媒体与播放；Open Office 可作为文件入口或配套工作台 | 用户需要安装、激活相应平台的 PowerPoint；云／AI 仍需对应服务与许可证。正式 PowerPoint 窗口与 Office Add-in 都不是可任意再分发、嵌入 Tauri 的 Microsoft 私有编辑器内核。插件 API 可扩展 Office，不保证每个桌面功能都有程序化接口。[ms-addins] |
| 独立实现全部 PowerPoint 能力 | 可完全控制自己的文档模型、UI、播放器和协作服务 | 涉及排版、OOXML 兼容、对象图、动画时间轴、媒体、辅助技术、跨平台原生集成和长期兼容维护；属于持续平台工程。不能以一次菜单改版或接通几个 UNO 命令交付，也不能复制 Microsoft 专有云服务 |

**路线的关键取舍：**“无需 PowerPoint、完全离线、独立应用”与“Microsoft 365 桌面及其云服务全部一致”不能仅靠当前开源内核同时获得。若选择独立产品，应按明确功能矩阵交付并持续标注差距；若完整微软行为是不可变要求，应评估实际 Microsoft 应用／服务依赖，而不是把替代实现宣传成原生同等功能。

### 若允许依赖本机 PowerPoint：可审阅的最小联动设计

这是待选择的方案，尚未实现或实机验收。

1. 提供独立的“使用本机 PowerPoint 打开”入口。原始 PPTX、PPTM 或加密文件不进入 LibreOffice，不转换、不重新保存；密码、宏和受保护视图由 PowerPoint 自行处理。原生通道和内置编辑器使用不同的格式白名单。
2. Windows 根据官方 App Paths 注册信息定位 PowerPoint；macOS 根据 `com.microsoft.Powerpoint` 查询 NSWorkspace，再指定该应用打开文件。仅通过已批准文件的内部能力 ID 启动，前端不能传入任意程序路径。未安装时明确提示，不自动下载或安装 Office。[ms-app-paths][apple-open-app]
3. 有未保存修改时，用户可保留内部编辑并打开磁盘版本，或显式导出新 PPTX 副本后打开；副本必须说明经过格式转换。取消、启动失败或外部冲突都不覆盖原件、不清除未保存状态。
4. 外部编辑期间挂起内部同文件的写入；返回后核对文件摘要，再让用户选择重新加载或保留内存版本。不得自动用旧模型覆盖新文件，退出 Open Office 也不得结束用户的 PowerPoint 进程。
5. 联动成功仅表示打开请求已发送，不表示文件已经解密、编辑或保存。需要在真实 Windows／Mac 的已授权 PowerPoint 上检查文件原始字节、默认文件关联不同、未安装、受保护文档、未保存内容、外部修改和取消等情况。

此方案使用单独的原生 PowerPoint 窗口；它不代表把完整 PowerPoint 编辑内核嵌进 Tauri。微软云端功能仍取决于该安装的账号、订阅和组织设置。

## 5. 不依赖最终路线的下一步验收工作

1. 固定 Microsoft 365 Windows／Mac 的具体版本和服务范围，明确是否包括 Windows 专属功能、云协作及 Copilot；不将平台差异当成本应用 bug，也不借平台差异缩减用户已选择的目标。
2. 建立由目标 PowerPoint 生成的原始样例：母版／主题、图表、SmartArt、动画、Morph、音视频、演讲者备注、现代批注、无障碍、复杂字体各独立一组，并保留组合样例。
3. 每个样例同时保存原 PPTX、对象结构清单、字体清单、截图／PDF、涉及播放时的参考视频；明确哪些差异不能接受。
4. 对每条拟支持能力执行“实际操作 → 保存 → 本应用重开 → 目标 PowerPoint 重开 → 再编辑与播放”。把未知或降级结果保留在报告中，不用截图取代可编辑性验证。
5. 分平台检查实际安装包，关联提交号、依赖摘要和执行环境；Rosetta 下运行 Intel 二进制需要单独记录，不能写成真实 Intel GPU 验证。
6. 动态放映、媒体和无障碍必须有专门运行时回归；继续保留当前保存副本、摘要冲突、未保存退出及宏／外链限制，架构迁移不能回退数据保护。

## 6. 官方来源

以下页面于 2026-10-13 核阅。Microsoft 的功能会按平台、许可证、更新渠道和组织策略变化；官方比较表也自称非完整清单。

- [Microsoft：Compare PowerPoint features on different platforms][ms-compare] — 编辑、设计、SmartArt、图表、协作、媒体、放映及 Windows／Mac 差异。
- [Microsoft：Use the Morph transition in PowerPoint][ms-morph] — Morph 对象与许可条件、图表限制。
- [Microsoft：Record a slide show with narration and slide timings][ms-record] — 录音、计时、墨迹、摄像头、Cameo 和视频导出。
- [Microsoft：Work together on PowerPoint presentations][ms-collaboration] — OneDrive／SharePoint、共同创作、评论、任务、冲突及历史版本。
- [Microsoft：Create a new presentation with Copilot in PowerPoint][ms-copilot] — Copilot 功能、许可证／组织设置、分批开放条件。
- [Microsoft：Make your PowerPoint presentations accessible to people with disabilities][ms-accessibility] — 检查器、替代文本、阅读顺序、字幕、带标签 PDF 和读屏测试。
- [Microsoft Learn：Office Add-ins platform overview][ms-addins] — Office Add-ins 用于扩展 Office 宿主，而不是独立替代整个 PowerPoint 应用。
- [LibreOffice：Starting LibreOffice Software With Parameters][lo-start] — 原生 `--show` 与 UNO 接入参数。
- [LibreOffice：About Converting Microsoft Office Documents][lo-compat] — 官方承认的 PowerPoint 对象、版式、母版、分组和多媒体兼容差异。

[ms-compare]: https://support.microsoft.com/en-us/powerpoint/compare-powerpoint-features-on-different-platforms
[ms-morph]: https://support.microsoft.com/en-us/powerpoint/training/use-the-morph-transition-in-powerpoint
[ms-record]: https://support.microsoft.com/en-us/powerpoint/training/record-a-slide-show-with-narration-and-slide-timings
[ms-collaboration]: https://support.microsoft.com/en-us/powerpoint/work-together-on-powerpoint-presentations
[ms-copilot]: https://support.microsoft.com/en-us/powerpoint/copilot/create-a-new-presentation-with-copilot-in-powerpoint
[ms-accessibility]: https://support.microsoft.com/en-us/accessibility/powerpoint/make-your-powerpoint-presentations-accessible-to-people-with-disabilities
[ms-addins]: https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins
[lo-start]: https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html
[lo-compat]: https://help.libreoffice.org/latest/en-US/text/shared/guide/ms_import_export_limitations.html
[lo-wasm-config]: https://github.com/LibreOffice/core/blob/efaf0670b4d055f838a2849becb10f08aa06a257/configure.ac#L3215
[qt5-wasm]: https://doc.qt.io/archives/qt-5.15/wasm.html#supported-qt-modules
[ms-app-paths]: https://learn.microsoft.com/en-us/windows/win32/shell/app-registration
[apple-open-app]: https://developer.apple.com/documentation/appkit/nsworkspace/open(_:withapplicationat:configuration:completionhandler:)
[lo-preview]: https://github.com/LibreOffice/core/blob/efaf0670b4d055f838a2849becb10f08aa06a257/sd/source/ui/slideshow/slideshowimpl.cxx#L3295
