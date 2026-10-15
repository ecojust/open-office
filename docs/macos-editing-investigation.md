# macOS 编辑后标签消失：排查记录

## 用户报告

- Open Office 0.9.0，macOS 26.5，Apple Silicon。
- 新建表格后，工作区编辑会触发问题，双击只是其中一种操作。
- 应用窗口仍在，所有文档标签消失。

0.10.0 的演示编辑器发布不包含此问题的已确认修复。

## 已确认的代码行为

文档标签保存在 Vue 内存状态中。普通编辑通知只更新对应标签的修改标记；关闭文档走单个标签的检查与移除流程。尚未找到编辑通知主动清空全部标签的路径。

返回工作台也会隐藏整个标签区域，但保留文档数组。原生诊断同时记录工作台状态、文档数量和标签可见性，用来区分区域隐藏与页面重新初始化。

当前锁定的 Tauri runtime-wry 2.12.1 在 macOS 的 WebContent 进程终止后默认重新加载 WebView。页面重载会重新建立空的标签状态，因此能够产生“窗口还在、全部标签消失”的现象。第二次原生诊断已记录到这条故障链，但尚无用户机器上的进程记录，也还不能判断进程终止的底层原因。

相较 0.9.0，0.10.0 的表格适配器、画布交互、Web host 与标签编辑通知没有行为修改。表格源码的相关发布改动是拒绝不支持格式的提示文案，以及 PDF 字体文件的资源路径迁移。

0.9.0 冷启动后直接新建 XLSX 只启动 Rust 表格，不会挂载旧 Office iframe 或演示编辑器。不过，先前打开的兼容文档会留下隐藏的旧 Office iframe。在该版本中，旧 iframe 的新建请求未检查它是否对应活动标签，收到请求会返回工作台。请求来源是旧内核的 `.uno:NewDoc` 或 `private:factory/*` 命令；没有找到普通 Grid 编辑派发这些命令的代码。0.10.0 已删除这条旧路径，第二次原生诊断仍在冷启动表格场景复现 WebContent 退出，因此旧 iframe 不是该复现的必要条件。

## 已执行的本地检查

在 Chromium 中保留一个 Word 和两个表格标签，测试了单击输入、双击编辑、功能区加粗、编辑命令及全局撤销。标签和会话仍然保留，文本与格式断言通过，没有观察到页面重启。macOS 用户代理和 Retina 比例模拟也未复现。

这些检查没有使用 Apple WKWebView，不能作为 macOS 26.5 已通过的证据。本地详细报告位于 `test-results/grid-edit-actions-focused/report.json` 等诊断输出中，未作为安装包内容发布。

提交 `ff6fb94` 的本地完整检查通过：TypeScript、344 项应用测试、83 项 PDF 测试；浏览器诊断通过 11 次可信输入和 8 项模型检查，保留一次启动及全部会话。测试将实时 `timeOrigin` getter 偏移 1 ms，确认报告继续使用原始捕获的页面身份。

## 首次 macOS 原生诊断

[诊断运行 38763519681](https://github.com/ecojust/open-office/actions/runs/38763519681) 使用提交 `cf808783494902a0db6ea93fc49d8b6ad90dc6f1`。实际系统为 macOS **26.6.2（25G83）**、Apple Silicon，并非用户的 26.5。系统输入权限与应用构建通过，两张空白表格均就绪，但首次点击前的坐标校验失败：原生采样为 1024 × 674 点，页面视口为 1024 × 642。

该运行没有发出任何 CGEvent，页面启动次数为 1、WebContent 终止次数为 0；采集器在失败后主动停止应用。因此这是诊断工具的几何校验失败，既不是编辑通过，也不是复现标签消失。[只读证据摘要](https://github.com/ecojust/open-office/actions/runs/38767971505) 将关键记录保存在检查注释中。

## 第二次原生诊断：已复现页面进程退出

[诊断运行 38768799963](https://github.com/ecojust/open-office/actions/runs/38768799963) 使用提交 `60106c13a9766a1943a94037b36fc9169c5e8053`，系统仍为 macOS **26.6.2（25G83）**、Apple Silicon。每次操作重新测量 AppKit 坐标，实际安全区域与页面 1024 × 642 视口一致，未使用猜测的标题栏偏移。

两个空白表格就绪后，系统单击 A1、输入 `42`、按 Enter 完成，Rust 模型内容断言通过。随后发送 D6 双击：请求在 9834 ms，WebContent 终止在 10131 ms，默认重载在 10160 ms，第二次页面启动在 10469 ms。没有双击完成记录，也尚未发送 D6 文本输入。原生计数为一次终止、两次启动。

这确认了双击编辑能触发页面进程退出和标签状态丢失，未确认底层原因；缺少崩溃报告不能视为没有崩溃。单击键入已使用同一个隐藏输入和 TextEdit，不能称为“首次初始化输入法失败”。下一步核查系统退出日志，并对鼠标事件中的焦点/选区行为做单变量验证。

[完整受限摘要](https://github.com/ecojust/open-office/actions/runs/38772145687) 显示系统日志只保留了最早 8 MiB，最后时间为 16:38:02.843，早于退出 5.452 秒。日志中的启动期 RBS、Jetsam Boost 和网络沙箱消息不能据此归因本次退出。退出前最后一次采样的 WebContent 为约 634 MiB RSS；退出后出现新 PID，同样不能据此认定内存杀死。采集器已改为保留最后 8 MiB，并记录截断和丢弃字节数。

候选提交 `011bcab00626225224cf4dbbfca27339ced16c5c` 只阻止表格 canvas 的左键 `mousedown` 浏览器默认行为，保留 pointer 事件、传播、焦点桥接和隐藏输入样式。Chromium 的八项真实编辑检查、全局按钮到表格的真实键盘焦点回归与 TypeScript 检查通过。

[原生候选验证 38772234421](https://github.com/ecojust/open-office/actions/runs/38772234421) 在编辑开始前被诊断脚本的 boot marker 检查拦截：已记录一次 `document-start`，但未发出 CGEvent，终止次数为 0。该运行不能评价候选改动。原检查要求初始化时捕获的时间与再次读取 `performance.timeOrigin` 严格相等；WebKit 上游 `Performance::timeOrigin()` 使用 `approximate<WallTime>()`，会根据当前单调时钟与墙上时钟换算，不能假定多次浮点读取完全相同。该运行未记录两个值，不能据此确认具体失败子条件。诊断应以初始化生成的不可变 UUID、捕获时间和原生启动计数共同识别页面，并保留失败详情。

采集器本轮已正确保留末尾 8 MiB 日志（总量约 9.6 MiB），没有编辑阶段的进程退出可供分析。候选改动尚不能称为已确认修复。

提交 `ff6fb94eb113c7bf9432338953cd2fa9c999bb73` 保留同一候选产品改动，修正诊断身份读取后进行[下一轮原生验证 38774688910](https://github.com/ecojust/open-office/actions/runs/38774688910)。本轮实际发出四项系统输入：A1 单击、键入 `42`、Enter 均完成；D6 双击请求在 10181 ms，进程终止在 10425 ms，随后重载。WebKit 日志给出 `reason=Crash`，原生计数为两次启动、一次终止。因此该鼠标默认行为候选无效，已从产品代码撤回。

本轮末尾日志覆盖崩溃，未提供异常栈或具体信号，也未发现 `.ips` 文件。WebContent 退出前最近采样约 769 MiB RSS，仍不足以认定内存杀死。后续检查聚焦双击事件回调中同步进入编辑的路径，并继续读取崩溃时刻上下文。

[按进程读取的上下文 38776905521](https://github.com/ecojust/open-office/actions/runs/38776905521) 检查崩溃时刻前后各一秒。应用 PID 15706 有 1741 条记录，最近十条仅描述 `reason=Crash` 和关闭过程；WebContent PID 15734 没有直接日志。没有取得底层异常证据。

## 延后双击进入编辑：已验证无效并撤回

eframe 0.36.2 的网页 `pointerup` 处理器会同步运行编辑器逻辑。当前候选让双击请求在后续 egui 帧才创建单元格编辑器，绑定文档、版本、工作表和单元格，并纳入保存与切换标签前的输入屏障。过渡期间的键入由现有输入队列保留。焦点桥接、隐藏输入样式和渲染器保持原有行为。

这只是待原生验证的时序候选。帧号隔开同次布局重试，但后续帧也可能由另一次 DOM 事件触发，不能保证一定来自动画帧回调。新增 Rust 回归覆盖真实 egui 指针序列、布局重试、快速键入与 Enter、过期请求，以及 F2 原路径；测试必须实际执行后才能记为通过。

候选仅用于 `work/macos-deferred-cell-edit` 隔离实验，不合入主分支、不发布。复核仍发现首次编辑焦点建立与输入回放之间的新点击可能改变目标；若该机制能阻止原生崩溃，发布前必须补齐后继指针的顺序处理与回归。仅有当前回归通过不代表这个边界已修复。

本地格式检查通过；编译检查发现并修正 `Context` 借用错误后，严格 Clippy 被未改动的生成文件 `office_icons.rs` 中 91 处浮点精度提示阻断，不能记为完整 `xtask ci` 通过。相关诊断与安装包校验的 80 项 Node 测试通过。Rust 行为测试与重建后的原生输入测试交由实验工作流分别执行。

诊断收尾仅在已记录进程终止时等待最多十秒，采集稳定的异步崩溃报告，并记录目录可读性。等待前固定保存主日志尾部；等待阶段单独保留日志，避免覆盖崩溃时刻。两段日志分别限制在 8 MiB，不改变失败判定。

[原生实验 38778645803](https://github.com/ecojust/open-office/actions/runs/38778645803) 使用隔离提交 `f64bcc58f280be910e2a6e788b6f6fb755bce02a`。A1 输入 `42` 和 Enter 成功，D6 双击请求在 12121 ms，WebContent 在 12560 ms 终止，日志仍为 `reason=Crash`。延后一帧未解决原生故障，因此撤回该候选及其输入队列，不继续扩展这一机制。

[新增证据摘要 38780506188](https://github.com/ecojust/open-office/actions/runs/38780506188) 显示用户 ReportCrash 服务已运行（PID 546），两类 disabled 查询均未列出对应服务；系统 Root 服务未运行不能解释为被禁用。两个崩溃目录均可读取，在十秒、21 次扫描内没有新 `.ips` 或 `.crash`。等待阶段日志为零字节，仍未取得底层异常栈，不能由此归因内存、GPU 或输入法。

同一实验的 Rust 回归已编译，但四项测试均失败；已读到的直接错误是测试工具未清理 `TexturesDelta`，这组结果未完成有效的行为验证，合并单元格回归没有运行。[失败日志摘要 38780497091](https://github.com/ecojust/open-office/actions/runs/38780497091) 保留错误。候选的否决依据是独立原生复现，不能把这次测试工具错误称为已证明的产品输入回归。

下一步保持原始产品逻辑，使用 F2 进入同一单元格编辑路径做原生对照，并尝试在当前系统允许的权限内取得准确 WebContent 进程的异常栈。默认发布验收仍必须通过真实双击，不接受 F2 对照代替。

F2 对照通过工作流 `edit_entry=f2` 或采集器 `--edit-entry f2` 启用，执行单击 D6、真实 F2、输入和 Enter，共 12 项系统动作。其报告使用独立的 `sheet-f2-native-typing`、`f2Value` 和 `diagnosticOnly`，不生成双击成功证据。默认双击的 11 项动作保持不变，两种路径的 Chromium 观测均通过，仍不能替代 macOS 对照。

`debug_webcontent=true` 或 `--lldb` 会在首次输入前，读取当前 WKWebView 的只读进程标识并尝试一次限时附加。只有确认同一 PID 已附加并继续运行后才发送输入；被系统拒绝时，确认未附加或已分离后继续无调试器的对照。不会修改系统保护、签名或隐私权限。异常停止时限量记录调用栈、寄存器及加载映像，退出前分离调试器。调试器可能改变时序，因此发布校验明确拒绝所有请求过 LLDB 的诊断报告。系统日志另纳入 runningboardd、launchd 和 kernel 退出记录，只有精确进程号关联的记录进入摘要，不能凭日志关键词直接判定原因。

[首次 F2/LLDB 运行 38784012150](https://github.com/ecojust/open-office/actions/runs/38784012150) 完成构建，但采集器收尾的 `kill EPERM` 中断最终报告保存，留下的是旧 `preflight-passed` 报告。[只读检查 38788191716](https://github.com/ecojust/open-office/actions/runs/38788191716) 确认调试 trace 为零字节，未留下输入、生命周期或调用栈证据。因此不能把该轮解释为 F2 成功、失败或未发送输入。采集器已改为先保存 native/frontend 证据，各收尾错误独立记录并保留原始错误，最后覆盖预检报告；下一轮先运行无调试器 F2 对照。

Linux WPE 的 Playwright WebKit 2336（报告版本 26.5）另做了只读对照。F2 的 12 项动作、8 项模型检查通过；DPR1、双击零派发延迟的 11 项动作、8 项检查也通过，包括 D6 实际写入、粗体、撤销、Word 输入及三个标签身份保留，未观察到页面崩溃。DPR2、80 ms 派发延迟的双击未进入编辑：两次 pointerup 的观测间隔约 827 ms，超过 egui 的 300 ms 双击阈值，Rust 编辑器为 null，标签仍在。三轮外围脚本均因一条 ResizeObserver 告警而标为失败，不能将核心编辑断言通过描述为整套测试通过，也不能将 Linux WPE 的结果替代 macOS WKWebView 验证。

## 原生检查的判定要求

使用 macOS 系统级键鼠事件，校验浏览器收到的事件确为可信输入，并检查实际文档内容、全部标签和会话身份。记录测试机实际 macOS 小版本，不能将其他 26.x 小版本称为 26.5。

WebContent 终止次数与页面启动代次必须保存在原生进程中，避免页面重启后重新执行测试掩盖故障。记录终止后保留 Tauri 默认的重新加载行为。系统输入权限不足应报告阻断，不能降级为 JavaScript 模拟事件后称为原生输入通过。

只有取得可复现触发路径或对应故障证据后，才能确定修复方案。仅禁止重新加载不能视为修复编辑故障。

## 运行独立诊断

GitHub Actions 的 **Diagnose macOS editing with real OS input**（`.github/workflows/macos-editing-diagnostic.yml`）支持手动运行。它使用 `macos-26` ARM runner，先记录实际系统版本并编译 Swift 输入工具，检查系统事件权限和键盘布局，再构建应用。缺少权限或非 US/ABC 输入源会明确阻断，不修改系统隐私权限，也不会回退到 DOM 合成事件。

在 Apple Silicon Mac 的仓库根目录，使用当前源码构建的应用可执行相同检查：

```bash
xcrun swiftc scripts/macos-os-input.swift -o /tmp/open-office-os-input
node scripts/macos-editing-diagnostic.mjs --helper /tmp/open-office-os-input --preflight
GITHUB_SHA="$(git rev-parse HEAD)" node scripts/macos-editing-diagnostic.mjs \
  --helper /tmp/open-office-os-input \
  --app "$PWD/src-tauri/target/release/bundle/macos/Open Office.app"
```

先创建两个完全空白的表格，再通过系统 CGEvent 单击输入、双击输入、功能区加粗和全局撤销，最后创建 Word 作输入对照。采集器同时校验 Rust 模型内容、原始会话身份、标签可见性以及原生启动代次。CGEvent 经过系统输入路径，但不代表物理键盘或中文输入法组合输入已经验证。

输出位于 `artifacts/macos-editing/`：`report.json` 是结果，`actions.json` 保存系统输入回执，`frontend-report.json` 保存可信事件与模型观测，`native-diagnostics.json` 保存启动及终止记录；另外保留系统 WebKit 日志和本次运行产生的相关崩溃报告（若系统提供）。工作流上传同名诊断 artifact。权限预检通过只表示可以开始，不能解释为编辑测试通过；本地 Chromium 通过也不能代替这项原生验证。
