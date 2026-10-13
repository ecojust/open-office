# 内置演示工作区与 PowerPoint 功能对照

> 历史记录：本文主体描述旧的 WASM 演示工作区及其测试。2026-10-13 后续源码已将 PPT 路由替换为独立模型、SVG 画布与 OOXML 读写；当前范围和验证结果见[独立演示工作区](standalone-presentation.md)。旧 PPT／ODP 支持及旧引擎验证不能套用于新内核，原安装包测试也不代表新内核已通过桌面验收。

更新日期：2026-10-13。新版采用**独立内置编辑器与本地放映器**，不要求用户安装 Microsoft Office、WPS 或桌面 LibreOffice，不接入远程文档编辑服务。可编辑幻灯片由随包的 ZetaOffice / LibreOffice 24.2.8.0 WASM 处理；PPTX 转场、媒体及其保存由独立的 OOXML 模块处理。

**范围与版本：**产品永久聚焦本地文档与本地放映，不提供账户、云盘、云协作、云 AI 或在线素材服务。这些能力不属于待补齐差距。0.4.0 测试版已发布；本次本地范围说明及云服务入口策略是发布后的源码更新，尚未生成或发布新安装包。已有功能证据保持原验证范围，详见[本地办公范围](local-only.md)。

## 本轮完成的编辑能力

发布后复杂文件测试发现导入图表的原生导出可能丢失内嵌数据工作簿。源码新增受原生修改记录与对象身份约束的工作簿保留/生成逻辑，实际图表修改、转场组合、重排与复制专项通过；只比较显示值相同不会授权恢复旧数据。复制图表按当前数据生成独立工作簿，不包括源工作簿全部隐藏数据或公式。无法确认的绑定会拒绝保存。该修复尚未进入 0.4.0 安装包，完整证据与边界见[复杂文件报告](compatibility-results.md)。

- 幻灯片新增、复制、删除、前后移动、重命名与隐藏；普通布局、页面尺寸、纯色背景和演讲者备注。
- 当前页对象选择与列表；文本框、矩形、椭圆、直线和图片；文字内容、字体、字号、粗体、斜体、下划线、文字颜色与段落对齐。
- 对象位置、大小、旋转、填充、线条颜色和宽度；前后层级、对象对齐、均匀分布、组合及取消组合。
- 真正的可编辑表格，包含单元格数据读取与修改；侧栏范围为 1–30 行、1–20 列。
- 真正的可编辑柱状图、条形图、折线图和饼图；可修改类别、系列、数值及标题，不是把图表渲染成图片后插入。侧栏范围为 1–100 个类别、1–20 个系列，饼图使用一个非负系列。
- PPTX／ODP 保存、重新打开及 PDF 导出。文件保存继续使用本地摘要冲突检查、原子写入、未保存退出确认。

对象模块已执行真实 Chromium + 当前随包 WASM 操作：修改文字样式、插入基本形状、选择与组合、编辑表格和图表数据，保存 PPTX 后重新读取数据并再次编辑。输入边界另外由 `tests/presentation-objects.test.mjs` 检查，包含非有限数值、非法枚举、超限内容、稀疏数组、过期对象 ID，确认拒绝请求不会先写入文档。边界测试不是 UNO 仿真验收的替代品。

`tests/browser/presentation-workbench.cjs` 已通过真实 WASM 页面管理、对象、备注、表格、图表及 PPTX／ODP 保存重开回归，包含 100 次连续属性读取及 PDF 隐藏页独立检查。`presentation-native-contract.cjs` 在 Chromium 中执行发布所用的同一验证函数，已通过三页文稿、隐藏页、可编辑表格／图表、页名／备注、转场／音频二次保存和实际 PDF 放映画布检查。这些浏览器结果不替代目标安装包验收；不能把历史 0.2.0 安装包的通过记录当作新版已通过。

独立放映器与功能保存已在 Linux Chromium 中通过 `tests/browser/presentation-player.cjs` 的 18 项实际检查，使用 PDF.js 页面、真实 Web Animations 及用户手势触发的 WAV／WebM 播放：六种转场、隐藏页跳过、自动换片、媒体延迟、缩放与快速翻页恢复、备注与计时、激光笔、黑屏／白屏、退出清理均有回归；还检查删除页恢复后的媒体保留、内存上限与纯转场声音保留。`tests/browser/pptx-package.cjs` 的 20 项检查覆盖包处理，并实际验证 UNO 导出后恢复效果与媒体关联。这些是所述浏览器环境的结果；Windows WebView2、macOS WKWebView 与目标安装包还须分别验收。

## 使用与保存规则

普通页面内容、对象几何、文字、表格、图表和备注以当前编辑器模型为准。PPTX 的切换、播放时序和媒体以该文稿的 OOXML 功能源为准；中文侧栏修改的是这一来源。保存时先生成最新的可编辑文稿，再按页面对应关系合并功能数据及所需媒体文件，结果写在 **PPTX 文件本身**，不是只存于浏览器或私有旁文件。

- 请使用中文侧栏的“切换与计时”“本页音视频”修改相应效果；内核高级菜单中的同类设置不作为这部分保存的权威来源。
- 页面普通编辑、排序及隐藏状态以最新编辑结果为准；复制页会维护功能对应关系。旧时序引用若无法唯一对应到新对象，导出会明确失败，保留未保存状态，不伪称已经保真保存。
- 含转场、媒体或原有对象动画的文稿保留为 PPTX；当前不把这些特性降级转换成 ODP。PDF 是静态页面副本，不承载动画、转场或音视频。
- 清空效果后，请先保存并重新打开 PPTX，再转换 ODP，以免原始内核中的旧效果重新出现。会话保留删除页的效果快照供撤销恢复，历史超过 128 MiB 时会在修改前提示先保存重开。
- 原文件不支持的动画时序可以在满足引用校验时保留，但**保留 XML 不表示本应用可以播放或编辑这些动画**。改动对象后的任意复杂动画仍需专门兼容验证。
- 外部媒体关系不会触发自动下载；本地嵌入文件与浏览器支持的编解码器才是离线播放范围。保存取消、冲突、压缩包或关联校验失败均不能清除未保存状态。

## 功能矩阵

“对象级已验证”表示当前 WASM 的实际模型操作及指定样例通过；不表示所有目标安装包、全部输入文件或 Microsoft PowerPoint 双向往返均已通过。下列播放验证范围是 Linux Chromium，不替代目标桌面 WebView 的安装包测试。

| 功能 | 当前范围 | 未完成的边界 |
| --- | --- | --- |
| 页面编排、普通布局、背景、尺寸、备注 | 已实现；有真实引擎回归入口 | 节、自定义放映、完整主题和母版设计器尚未对齐 |
| 文本、基本形状、图片、对象属性 | 对象级已验证，中文工作台接入 | 图片高级裁剪、透明度、连接线、复杂文本布局等仍按各项单独验证 |
| 层级、对齐、分布、组合 | 真实 UNO 对象操作，非画面模拟 | 不承诺与 PowerPoint 任意复杂组合及动画关系无损互换 |
| 表格与图表 | 表格单元格、四种图表及数据编辑已实现；PPTX 数据往返已有真实证据 | 所有图表类型、嵌入 Excel 工作簿及全部样式未对齐；联网刷新永久排除 |
| 页面切换与自动换片 | 独立 OOXML 读写；淡化、推进、擦除、覆盖、揭开、拆分六种转场及自动计时已有实际播放回归；也可设为无切换 | 不能称为 Morph、Zoom，也不等于逐对象动画；其他原文件转场不会冒充全部支持 |
| 本地音频与视频 | PPTX 嵌入和关系恢复；实际 WAV／WebM 解码、用户点击播放与延迟启动已验证 | 受系统编解码器限制；不等于内核画布原生播放；跨页音频、裁剪、书签、字幕等未完整对齐；在线媒体永久排除 |
| SmartArt | 未实现专用节点／布局编辑器 | 导入后可见或转换成普通形状，不等于保留 SmartArt 编辑语义 |
| 逐对象动画、动作路径、触发器 | 尚未实现完整时间轴编辑与播放 | 不用页面转场替代此项；Windows／Mac 原版功能也存在差异 |
| Morph、Zoom | 未实现 | 普通 CSS 淡化／移动不是 Microsoft Morph 的对象匹配与补间 |
| 放映辅助 | 单窗口备注、计时、激光笔、黑屏／白屏和键盘翻页已验证 | 双屏演讲者视图、录制及导出视频尚未完成；自动换片不等于排练录制 |
| 本地批注、审阅与历史 | 本地原文件冲突保护已有；完整本地审阅和版本恢复仍需独立实现与验证 | 最近文件与摘要校验不能称为文档版本历史 |
| 打印 | 导出 PDF 后由系统阅读器打印 | 尚非系统打印队列、讲义／备注纸张设置的完整集成 |
| 文件与访问能力 | PPTX、ODP；宏与自动外链更新禁用 | 旧 PPT、PPTM、加密交互、企业权限保护、全部 OOXML 扩展和无障碍导出未完整支持 |

本项目的目标是持续完善本地文档与放映能力，当前不宣称 Microsoft 365 PowerPoint 全功能、完全一致或任意文档无损兼容。Windows 与 macOS 的 Microsoft 原版也并非同一功能集合；验收必须固定版本、字体、显示环境及功能样例。[ms-compare]

## 永久排除的在线能力

账户、云盘、共同创作、在线共享、云版本历史、Designer、Copilot、组织云资产和在线音视频均不在产品范围，也不列入后续开发计划。保留本地图片与媒体、离线编辑、保存和放映；文件格式支持不代表服务接入。

## 后续验收方式

1. 用真实可编辑对象检查修改与保存重开，分别验证本应用与指定 PowerPoint 版本；截图只能证明外观，不能证明可编辑性。
2. 播放能力用真实转场、自动换页及媒体样例检查，记录时间、交互、解码和错误恢复；保留动画标记不得算作动画播放通过。
3. Windows WebView2、Apple Silicon WKWebView 以及 Intel 包各记录实际构建与运行报告；Intel 包经 Rosetta 验证须明确标注，不能冒充真实 Intel GPU 验证。
4. 复杂母版、SmartArt、动画、Morph、媒体、批注、字体和辅助技术建立独立样例组，不用少量基本文档概括全部兼容性。

## 附录：此前固定引擎的放映与媒体调查

下列是选择独立播放器的历史依据。它说明当前固定 WASM 构建的限制，不取消上述已经实现的编辑功能，也不等于所有 LibreOffice 版本都不支持放映。

- 0.2.0 的实际安装包验证记录为 [Actions 38325471381](https://github.com/ecojust/open-office/actions/runs/38325471381)。Windows、Apple Silicon 和原封 Intel DMG 的 Rosetta 验证通过；这些既有检查的范围仍是基本编辑、保存重开与 PDF 导出，不包括动画放映验收。
- 在 Linux Chromium 中修正探测服务的 CSS MIME 后，确认实际画布与像素缓冲均为 1440×1000、worker WebGL 可用，重新验证三种调用。原生 `XPresentation.start()` 仍出现 `memory access out of bounds`，随后 `isRunning()` 为 false、放映控制器不存在；`startWithArguments(IsFullScreen=false)` 未在 20 秒内返回，后续 UNO 查询也在 5 秒后超时。**这些是该测试环境的结果，不是 Windows／macOS 放映验收，也不证明所有替代窗口化方案不可行。**
- `Preview=true` 的单页预览在正确画布上能返回 `running=true`，无动画样例在 3 秒后已自动结束。源码将它视为动画预览模式，指定动画节点时还会禁用页面切换；此次未使用真实动画或媒体样例，因此调用能返回既不是完整放映成功，也不证明实际动画播放。[lo-preview]
- 属性式窗口化和指定 `ParentWindow` 仅在首轮默认尺寸画布上探测，未作相同条件的复核，保留为初步结果。未定位原生崩溃的具体 C++ 根因，不能将其归因于媒体裁剪。此次有限探测没有找到可安全开启完整放映的 JavaScript 配置方案。
- 从本机随包 `soffice.data` 的 `versionrc` 读取的核心 build ID 为 `efaf0670b4d055f838a2849becb10f08aa06a257`。按 `soffice.data.js.metadata` 中的文件偏移提取 `services/services.rdb`，其中有 `com.sun.star.presentation.SlideShow` 和 VCL／Cairo Canvas 服务，但没有 avmedia 组件或 `com.sun.star.media.Manager`。
- 同一构建的官方源码在默认 WASM strip 配置中设置 `enable_avmedia=no`；Qt 5.15 官方文档也明确 QtMultimedia 不适用于该 WASM 平台。因此不能通过打开一个菜单或放映开关，获得这份固定内核中缺失的原生音视频后端。[lo-wasm-config][qt5-wasm]
- 仅重新下载并核对了官方 CDN 的 `soffice.js` 与 `soffice.data.js.metadata`，两者与锁定摘要一致；未重新下载所有大型二进制，也不能据此声称已排查所有商业或私有构建。此次公开版本调查未找到可直接替换且明确修复放映的发行版。


## 官方功能参考

- [Microsoft：各平台 PowerPoint 功能比较][ms-compare]。
- [Microsoft：Morph 的适用范围][ms-morph]；[录制、旁白和时间][ms-record]。
- 范围排除参考：[Microsoft：共同创作][ms-collaboration]；[Copilot 制作演示文稿][ms-copilot]（均不是本应用的实现目标）。
- [Microsoft：无障碍演示文稿][ms-accessibility]。
- [LibreOffice：Office 文档转换的已知差异][lo-compat]。

Office Add-in 是运行在 Office 内的扩展，不是可嵌入 Tauri 的完整桌面 PowerPoint 引擎。本产品已选择独立内置路线，不依赖安装 Office，也不引入 WOPI 云端编辑服务。[ms-addins]

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
