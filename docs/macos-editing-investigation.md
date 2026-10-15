# macOS 编辑后标签消失：排查记录

## 用户报告

- Open Office 0.9.0，macOS 26.5，Apple Silicon。
- 新建表格后，工作区编辑会触发问题，双击只是其中一种操作。
- 应用窗口仍在，所有文档标签消失。

0.10.0 的演示编辑器发布不包含此问题的已确认修复。

## 已确认的代码行为

文档标签保存在 Vue 内存状态中。普通编辑通知只更新对应标签的修改标记；关闭文档走单个标签的检查与移除流程。尚未找到编辑通知主动清空全部标签的路径。

返回工作台也会隐藏整个标签区域，但保留文档数组。原生诊断同时记录工作台状态、文档数量和标签可见性，用来区分区域隐藏与页面重新初始化。

当前锁定的 Tauri runtime-wry 2.12.1 在 macOS 的 WebContent 进程终止后默认重新加载 WebView。页面重载会重新建立空的标签状态，因此能够产生“窗口还在、全部标签消失”的现象。这是候选机制，尚无用户机器上的进程终止记录证明本次故障由它触发，也不能据此判断是内存、图形驱动还是其他原因。

相较 0.9.0，当前表格适配器、画布交互、Web host 与标签编辑通知没有行为修改。表格源码的相关发布改动是拒绝不支持格式的提示文案，以及 PDF 字体文件的资源路径迁移。

0.9.0 冷启动后直接新建 XLSX 只启动 Rust 表格，不会挂载旧 Office iframe 或演示编辑器。不过，先前打开的兼容文档会留下隐藏的旧 Office iframe。在该版本中，旧 iframe 的新建请求未检查它是否对应活动标签，收到请求会返回工作台。请求来源是旧内核的 `.uno:NewDoc` 或 `private:factory/*` 命令；没有找到普通 Grid 编辑派发这些命令的代码，不能据此确定故障原因。0.10.0 已删除这条旧路径，因此当前版本未复现也不能排除 0.9.0 多内核共存场景。

## 已执行的本地检查

在 Chromium 中保留一个 Word 和两个表格标签，测试了单击输入、双击编辑、功能区加粗、编辑命令及全局撤销。标签和会话仍然保留，文本与格式断言通过，没有观察到页面重启。macOS 用户代理和 Retina 比例模拟也未复现。

这些检查没有使用 Apple WKWebView，不能作为 macOS 26.5 已通过的证据。本地详细报告位于 `test-results/grid-edit-actions-focused/report.json` 等诊断输出中，未作为安装包内容发布。

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
