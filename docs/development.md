# 开发与构建

[返回项目首页](../README.md)

默认文字工作区接入固定版本的 [WordCraft Rust 引擎与画布界面](wordcraft-integration.md)，已随 [0.8.0](https://github.com/ecojust/open-office/releases/tag/desktop-v0.8.0-38691848013) 公开发布。[0.8.1](releases/0.8.1.md) 将内层界面限定为编辑工具，文件操作统一由 Open Office 外壳处理。旧基础 Rust 内核与测试属于历史路径，不能代替当前默认编辑器的验收。

0.9.0 的默认 XLSX／CSV／TSV 工作区接入 [GridCraft Rust 引擎与界面](gridcraft-integration.md)。ODS、旧 XLS 和显式兼容表格入口保留原办公引擎；旧 Calc 工作台测试只证明这条兼容路径。

## 全局工具栏与主题

开发版的文件操作集中在最顶部，作用于当前文档；主页保留新建与打开。太阳、月亮、显示器按钮分别选择浅色、深色和跟随系统，记忆选择并同步现有及新建的文字／表格会话。编辑区原有局部主题入口已隐藏。

2026-10-15 本轮生产构建、两引擎源码／产物摘要检查和 123 项外壳测试通过；`node tests/browser/global-shell-theme.cjs` 的 5 组 Chromium 定向验收通过。覆盖全局文件按钮及快捷键、主题记忆、两引擎跟随系统变化、待提交中文草稿保留，以及主题切换不改变内容与撤销历史；3 次实际下载经独立 DOCX／XLSX 解析核对。报告 `test-results/global-shell-theme/report.json` 记录运行前后一致的产品摘要，README 截图来自本轮。

本轮是工具栏与主题专项，没有重跑历史完整格式或原生安装包验收；历史引擎报告和哈希仍只对应各自快照。该轮验证时版本号为 0.8.1；0.9.0 发布验证另见[更新说明](releases/0.9.0.md)。

## 0.9.0 发布验证

发布候选版本包含上述工具栏、主题、表格引擎和原创 SVG 图标。安装包由 `.github/workflows/desktop-release.yml` 构建，只有 Windows x64、macOS ARM64 及 Intel 包的 Rosetta 验证全部通过才公开。确切源码与运行记录随发布说明提供。

0.9.0 本地生产构建、995 项 Node 回归及 83 项 PDF 后端测试通过。表格源码的格式、资产归属、依赖分层、功能清单与快捷键生成检查通过；完整 `cargo xtask ci` 在 Linux 桌面 Clippy 依赖编译期间因临时盘仅余 240 MiB 而停止，未完成的 Clippy 与工作区测试不计为通过。Windows／macOS 发布所需的 Rust 专项测试与安装包原生验证在发布工作流中分别执行。

## 本地开发


需要 Node.js 24、Python 3.12、Rust stable（固定的 craft-ui 依赖要求至少 1.95），以及 Tauri 对应系统的原生构建依赖。macOS 需要 Xcode Command Line Tools；Windows 需要 Visual Studio C++ Build Tools 与 WebView2。

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.129
npm ci
npm run desktop:prepare
npm run desktop:dev
```

首次准备会下载已固定 SHA256 的 ZetaOffice WASM 与 Noto 中文字体，并用 PyInstaller 构建本机架构的 PDF 内核。Python 不需要在最终用户设备上额外安装。不要把其他架构的 `pdf-runtime` 复制过来。

仅调试 Vue 界面：

```bash
npm run runtime:fetch
npm run pdf:ensure
npm run dev
```

开发服务器只在 `127.0.0.1:5198` 提供 PDF 测试桥。生产桌面应用通过 Tauri 的受控命令调用固定的本地 PDF 进程，不开放通用命令执行。直接将 `dist` 放在普通静态站点，不能获得桌面文件保存与 PDF 后端功能。

## 检查与打包

```bash
npm test
npm run build
npm run desktop:build
```

`npm test` 包括类型检查、前端与文件协议回归，以及真实本地 PDF 编辑测试。浏览器回归需要另行启动开发服务器与 Playwright；请顺序运行，避免同时启动多个高内存文档引擎。

```bash
npx playwright install chromium
npm run test:browser
npm run test:browser:word
npm run test:browser:sheet
npm run test:browser:office-ui
npm run test:browser:ppt-independent
```

`test:browser:ppt-independent` 使用完整 Vue 应用验证新的独立演示工作区，检查真实 PPTX/PDF 下载、重新打开与界面操作，并确认没有加载旧办公引擎。`ppt-workbench`、`impress` 等旧测试保留为历史引擎的回归入口，不作为当前 PPT 路由的验收证据。

默认文字界面复用 `vendor/wordcraft` 中的 Rust `WordApp` 和文档／排版引擎，由 `apps/open-office-host` 接入外壳。桌面 WebView 和浏览器均运行本地构建的 WASM；桌面文件操作继续走 Tauri。它不再以旧 `word_engine_request` 或 Vue SVG 作为默认编辑执行链。

```bash
npm run word:build
npm run word:check
npm run test:browser:wordcraft
node tests/browser/wordcraft-embedded-ui.cjs
node tests/browser/wordcraft-native-helper.cjs
```

构建脚本 `scripts/build-wordcraft.mjs` 使用锁定的 Cargo 依赖和 `wasm-bindgen 0.2.129`，生成 `public/wordcraft/` 下的 JS、WASM 与摘要清单；该目录不提交 Git。`word:check` 校验源码／字体及产物哈希，构建成功本身不等于功能验收。首次构建需下载 Rust 依赖，正常编辑不依赖远程 Office 服务。可通过 `WASM_BINDGEN`、`WORDCRAFT_TARGET_DIR` 指定工具和构建缓存路径。

默认表格使用同一版本的 `wasm-bindgen`，单独构建并验证：

```bash
npm run sheet:build
npm run sheet:check
npm run test:browser:sheet-engine
npm run test:browser:sheet-native-helper
```

`scripts/build-gridcraft.mjs` 编译 `vendor/gridcraft/apps/open-office-host`，输出 `public/gridcraft/` 和 `manifest.json`；可通过 `GRIDCRAFT_TARGET_DIR` 指定缓存。该目录不提交 Git，`npm run dev` 和生产构建都会确保其与源码／字体指纹匹配。不要把上游功能清单、旧 Calc 测试或成功编译当作新工作区的实际 UI、保存往返或安装包验收；范围见[表格集成说明](gridcraft-integration.md)。

`test:browser:sheet-engine` 检查默认 Rust 表格工作区，`test:browser:sheet-native-helper` 在浏览器中复用安装包自检逻辑，不等同于原生 WebView 验收。原 `test:browser:sheet` 仍检查兼容表格引擎。

2026-10-15 表格引擎替换轮次已通过生产构建、表格产物摘要检查、Chromium 主浏览器验收 9 组及自检流程 6 项，报告分别位于 `test-results/gridcraft-engine/report.json` 和 `test-results/gridcraft-native-helper/report.json`。这些是全局工具栏与主题调整前的快照结果；具体范围和历史指纹见[表格集成说明](gridcraft-integration.md)。该轮验证时版本号为 0.8.1；0.9.0 发布验证另见[更新说明](releases/0.9.0.md)。

WordCraft 浏览器验收自行启动临时 Vite 与 Chromium，无需另开开发服务器；运行前须安装 Playwright Chromium，并确保 `python3` 可以导入 PyMuPDF（`fitz`），以独立读取导出的 PDF。核心检查器直接调用 `python3`，仅设置 `PYTHON` 不能替代这一要求；使用虚拟环境时先激活环境。可用 `WORDCRAFT_OUTPUT` 指定独立报告目录，保留每轮的源码摘要、导出工件和失败证据。

0.8.1 的本地生产构建及三套浏览器验收通过：编辑区与外壳专项 4 组、完整文字回归 9 组、安装包自检逻辑的浏览器复用检查 6 项。第三套报告明确标记为浏览器传输，不计作原生 WebView 通过；三平台安装包仍须执行发布工作流中的独立检查。

上游字体、断词数据、WordCraft 与 craft-ui 许可原文在 `public/legal/wordcraft/`，来源固定到具体提交。本地桥接、字体适配和上游修改随本仓库源码分发。详见[第三方声明](../THIRD_PARTY_NOTICES.md)。

此次验收应覆盖实际 WordCraft 画布输入、格式、表格／图片、导出文件独立读取、保存重开、失败导入原子性，以及多标签历史与输入法提交。系统输入法、原生文件对话框、WebKit/WebView2 图形运行和实际安装包需要逐平台验收；Chromium、CLI 或旧内核 IPC 结果不能代替它们。当前验收状态见[WordCraft 集成说明](wordcraft-integration.md)。

`test:browser:wordcraft` 与 `test:browser:word-engine` 当前均指向新的 WordCraft 浏览器验收。旧 `crates/word-engine` 及 `test:native:word-engine` 保留第一阶段实现／协议的历史测试。运行旧原生命令成功只能证明旧模块仍可调用，不证明默认 WordCraft 界面通过。

以下独立文字测试仍只证明旧轻量入口及旧文档包模块：

```bash
cargo test --locked --manifest-path crates/word-package/Cargo.toml
cargo build --locked --manifest-path crates/word-package/Cargo.toml --bin word-package-cli
npm run test:browser:word-codec
npm run test:browser:word-rust
npm run test:browser:word-independent
npm run test:browser:word-libreoffice
npm run test:browser:word-indentation
npm run test:browser:word-character-format
npm run test:browser:word-highlight
npm run test:browser:word-background
npm run test:browser:word-underline
npm run test:browser:word-underline-color
npm run test:browser:word-baseline-offset
npm run test:browser:word-paragraph-spacing
npm run test:browser:word-line-rule
npm run test:browser:word-auto-color
npm run test:browser:word-page-settings
npm run test:browser:word-marker
npm run test:browser:word-spacing
npm run test:browser:word-case
npm run test:browser:word-kerning
npm run test:browser:word-import-performance
```

`word-codec`、`word-rust`、`word-indentation`、`word-character-format`、`word-highlight`、`word-background`、`word-underline`、`word-marker`、`word-spacing` 和 `word-import-performance` 自行启动临时 Vite；`word-independent`、`word-libreoffice` 需要已运行的 `npm run dev`。`word-libreoffice`、`word-indentation`、`word-character-format`、`word-highlight`、`word-background`、`word-underline`、`word-marker` 和 `word-spacing` 还需要原生 `soffice`，可用 `SOFFICE` 指定路径。`word-rust` 使用真实 Rust CLI 与浏览器中的 OOXML 编解码器，通过受控传输验证桌面分支，不替代打包后的 Tauri IPC 测试；若使用自定义 Cargo 输出目录，设置 `WORD_PACKAGE_CLI`。段落标记专项分别校验 `w:pPr/w:rPr` 与正文格式，覆盖空段格式、显式取消和受支持的字符样式引用；旧版仅含空文字片段格式的文档兼容读入，导出时写入真实段落标记。样式定义及 `docDefaults` 内的非空 `pPr/rPr` 继续拒绝。详细范围见[独立文字编辑器](independent-word.md)。

`word-spacing` 校验 ±20 磅字符间距的继承、显式零、空段、换段及负值显示下限，并使用完整原生语料和独立 Python XML 检查器核对产品导出与 LibreOffice 重存。原生输出中的其他不支持布局继续作为负例保留，不为通过测试删改输出 XML。可用 `WORD_SPACING_OUTPUT` 指定报告目录。

`word-case` 验证全部大写、小型大写与显式取消的 DOCX 往返、样式来源、原文及 UTF-16 选区、工具栏和原生 LibreOffice 对照。它自行启动临时 Vite 与 Chromium，需要原生 `soffice`；原生包保留完整字节，以独立检查器核对格式与文字。小型大写的视觉回退检查还需要 DejaVu Sans、`fc-match` 和 Python FontTools。可用 `WORD_CASE_OUTPUT` 指定独立结果目录，保留不同版本的报告。

`word-kerning` 对照 Writer 的字偶距开关行为，分别检查原始 OOXML 数值与显示效果；原生重存会将非零值统一为 2。专项覆盖真实字距面板、独立草稿、一次撤销、字号变化、正文与段落标记及原生按键语料。它自行启动 Vite 与 Chromium，需要原生 `soffice`；视觉检查还需要 Liberation Serif、`fc-match` 和 Python FontTools。用 `WORD_KERNING_OUTPUT` 指定结果目录。

`word-underline-color` 检查独立 RGB 下划线和跟随文字颜色，覆盖完整原生文件、样式继承、正文／空段标记、真实按键、菜单草稿、撤销重做及截图中的线条颜色。它自行启动 Vite 与 Chromium，需要原生 `soffice`；像素检查使用 Python Pillow。用 `WORD_UNDERLINE_COLOR_OUTPUT` 指定结果目录。显式 OOXML 下划线属性 `w:u/@w:color="auto"` 与内部跟随文字状态分别处理，前者仍作为不支持的输入拒绝。

`word-baseline-offset` 对照 Writer 的自定义基线偏移，检查半磅导入、整数百分比、改变字号后的保存取整、空段和实际格式命令的继续输入行为。它自行启动 Vite 与 Chromium，需要原生 `soffice`；测试使用完整 DOCX 原件和独立 XML 检查器，字体度量检查限于已验证的字体与当前环境，不代表原生分页一致。报告路径及运行参数见[专项语料说明](../tests/compatibility/independent-word-baseline-offset/README.md)。

`word-paragraph-spacing` 检查倍数／固定值／最小值行距、段前／段后间距、默认与样式继承、真实编辑控件和换段／合段。它自行启动 Vite 与 Chromium，并调用原生 `soffice` 重存应用输出；独立 Python 检查器读取完整 ZIP/XML 与 PDF。倍数范围采用已验证的连续稳定子集，拒绝非法规则和范围外输入。可用 `WORD_PARAGRAPH_SPACING_OUTPUT` 指定结果目录，详细来源与限制见[段落间距语料](../tests/compatibility/independent-word-paragraph-spacing/README.md)。

`word-line-rule` 专项覆盖只写行距规则、不写数值的 DOCX，通过完整原生语料核对 Writer 缺省值和样式覆盖关系，并验证实际打开、编辑、保存重开与无效输入保护。它与旧段落间距回归分别记录，不将文件语义一致当作分页一致。

`word-auto-color` 核对自动前景色与明确 RGB 的区别、样式和段落标记来源、原生 Enter 控制、颜色菜单、撤销重做及保存重开。独立 ZIP/XML/PDF 检查器对照完整 LibreOffice 原生文件；自动绘色取文字底纹，高亮不参与判断。它自行启动临时 Vite 与 Chromium，需要原生 `soffice` 和 Python PyMuPDF，可用 `WORD_AUTO_COLOR_OUTPUT` 指定报告目录。详见[自动颜色语料](../tests/compatibility/independent-word-auto-color/README.md)。

`word-page-settings` 检查单节纸张尺寸、独立方向标记、四边页边距与逐字段缺省值，覆盖实际页面面板、选区和撤销恢复、完整文件保存与原生重存。测试自行启动 Vite、Chromium 和独立配置目录下的 `soffice`，Python ZIP/XML 与 PDF 检查器分别核对文件属性和页面尺寸；不将连续正文预览当作分页验证。用 `WORD_PAGE_SETTINGS_OUTPUT` 指定结果目录，见[页面设置语料](../tests/compatibility/independent-word-page-settings/README.md)。

`word-import-performance` 在真实 Chromium 中统计每次导入的 XML／关系解析次数，验证 App 将预检通过的模型一次性交给编辑器，并检查 CRC、损坏输入和跨次导入数据修改。它是减少重复工作的正确性检查，解析次数不代表完整打开耗时。独立的前后耗时测量与复现命令见[DOCX 导入性能对照](word-import-performance.md)；运行正式测量时应暂停其他浏览器测试和编译。

Linux 开发环境可单独验证真实 Tauri/WebKitGTK 的 Word 包读写：

```bash
npm exec vite -- build
cargo build --locked --manifest-path src-tauri/Cargo.toml
npm run test:native:word-package -- --executable "$PWD/src-tauri/target/debug/open-office"
```

需要 GTK/WebKitGTK 与可用的显示会话（无桌面时使用 Xvfb）。脚本自行开启 `OPEN_OFFICE_SMOKE=1` 和 `OPEN_OFFICE_SMOKE_SCOPE=word-package-ipc`，隔离应用数据目录，并校验本次进程的结果及退出状态。此范围使用内存中的 DOCX，覆盖真实 IPC 的两轮保存重开、文字格式和无效包拒绝；不打开文件对话框或 Office 引擎。缺省 smoke scope 仍是完整原生验证。Linux 开发测试不替代 Windows/macOS 安装包的 `scripts/native-smoke.mjs` 验证，也不是端到端性能基准。

仅将 WebKit 动态库加入 `LD_LIBRARY_PATH` 可能仍无法启动：发行版 WebKitGTK 会从固定系统路径寻找 `WebKitNetworkProcess` 和 `WebKitWebProcess`，需要完整运行依赖。本次环境即因缺少该路径下的进程文件而在窗口创建前退出，尚未通过此原生 IPC 检查。

后续只读诊断确认：现有 WebKitGTK 2.52.6 release 仅在开发模式构建中支持 `WEBKIT_EXEC_PATH`（[对应源码](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/Shared/glib/ProcessExecutablePathGLib.cpp)）。工具链目录已有 helper 与依赖，但当前环境的 `bwrap` 路径映射探针因 uid-map 只读失败，且遗留 X11 socket 没有对应显示服务。此次没有重新启动实际 IPC 测试，也未修改系统文件或应用二进制；诊断记录位于 `test-results/word-package-native-followup/diagnostic.json`。

DOCX 包处理性能诊断使用优化构建，并分别记录核心、base64、JSON 与子进程传输成本：

```bash
cargo build --release --locked --manifest-path crates/word-package/Cargo.toml --bins
node scripts/benchmark-word-package.cjs
```

脚本自行启动临时服务，使用原始 LibreOffice 小文件及 100／1,000／4,000 段合成正文；运行时应暂停其他浏览器测试和编译。此项不测真实 Tauri IPC 或整份文稿的打开、保存时间。参见[测量范围和结果](word-package-performance.md)。

桌面发布工作流由 `workflow_dispatch` 触发。选择 `platform=all` 与 `publish=true`，Windows x64、macOS ARM64 与 macOS Intel 安装包通过本次构建及必要自检后，才公开测试版。[0.8.0 已公开发布](https://github.com/ecojust/open-office/releases/tag/desktop-v0.8.0-38691848013)；0.8.1 的逐平台结果以本轮 Actions 为准。默认文字工作区的真实 WebView 自动检查属于必要门槛，历史版本与本地浏览器通过记录不能代替它。

发布检查包括实际启动、文档编辑、保存重开与 PDF 独立回读。Windows x64 与 macOS ARM64 使用对应平台的真实应用；Intel 安装包原生编译后，将原封 DMG 转移到 ARM Mac，通过 Rosetta 验证 x64 应用和 PDF 进程。搬运前后校验安装包、应用文件、链接与签名，不重新构建或签名。该检查不等同于真实 Intel 显卡测试。

从 0.6.0 起，完整安装包自检在加载 Office 引擎前，先执行独立 Word 的真实 Rust IPC 两轮读写、格式保留及无效输入拒绝检查，并将结果保存到 `frontend.independentWordPackage`。报告缺失、失败或内容不完整均阻止发布；随后继续执行原有工作区检查。该模块验证不包含轻量编辑器的原生文件对话框或全部 UI 操作。独立 `word-package` crate 的单元测试也在各构建平台单独运行。

历史 0.7.0 发布还要求 `word-engine` 内核的完整安装包 IPC 验收：真实应用调用 `word_engine_request`，完成新建、编辑、排版、DOCX 导出重开及无效请求保护，再继续原有工作区检查。各平台须运行 `word-engine` 的 Rust 测试，并校验必要的原生报告；失败或缺失时不得发布。该结果与旧 `word-package` ZIP IPC 分开记录，也不代替新默认 WordCraft 的报告。

0.8.0 的完整自检新增必需的 `frontend.wordcraft`：实际挂载默认 Vue／WordCraft 编辑器，观察 WebGL 绘制，向真实 eframe 输入节点派发合成中文／emoji 输入，执行 Rust 格式命令，并验证 DOCX 导出与保存回执、过期保存拒绝、无效打开保护、默认入口重开及会话／画布／输入节点清理。`scripts/wordcraft-smoke-docx.py` 独立核对两份导出 DOCX 的正文与格式。`scripts/wordcraft-native-smoke.mjs` 只从安装目录读取四份生成产物，核对源码输入和清单摘要，再将其与 WebView 实际获取的清单、JS／WASM 摘要绑定；没有源码目录回退。

该报告必须来自原生 WebView；复用检查逻辑的 Chromium 报告会标记为浏览器，不能通过原生门槛。检查不模拟物理系统输入法，不测试系统剪贴板、原生文件对话框或磁盘保存；保存断言只涵盖导出内容与编辑器版本回执。三平台实际结果及这些未测范围应分别记录，详见[WordCraft 集成说明](wordcraft-integration.md)。

构建版本采用北京时间 `YYYY.MMDD.HHmm`，可通过 `OFFICE_BUILD_VERSION` 固定。每份安装包以对应 Actions 记录和提交为准。

## 目录


```text
src/                    Vue 外壳、原生文件桥、PDF 工作室
src/office/             办公内核消息桥与类型
src/presentation/core/  独立 PPT 文档模型、SVG/PDF 绘制、PPTX 导入导出
src/word/core/          旧轻量文字模型、输入适配、OOXML 编解码与运行时桥
src/word/rust/          WordCraft 宿主适配及保留的旧 Rust 协议模块
src/components/RustWordEditor.vue  WordCraft 画布与外壳生命周期适配
vendor/wordcraft/       固定上游 Rust 内核、egui 界面及本地 open-office-host
crates/word-engine/     0.7.0 基础 Rust 内核、CLI 与共用字体资源
crates/word-package/    独立 Rust ZIP/CRC 核心及互通测试 CLI
public/wordcraft/       默认 WordCraft WASM、JS 与构建清单（不入 Git）
public/word-engine/     旧基础 Rust 内核产物（不入 Git）
public/office/          独立办公内核宿主与线程适配
public/office-runtime/  校验后下载的 WASM、数据与字体（不入 Git）
public/legal/           随应用分发的许可文本
pdf-backend/            受控 JSON 协议的本地 PDF 编辑器及真实文件测试
src-tauri/              Rust 文件保存、隔离静态服务器、窗口与进程管理
scripts/                资源准备、PDF 冻结、签名及原生冒烟验证
vendor/                 固定版本与资源摘要
```

