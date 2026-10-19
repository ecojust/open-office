# 开发与构建

当前应用使用四个本地 Rust/WASM 编辑器：`vendor/office-word`、`vendor/office-sheet`、`vendor/office-presentation`、`vendor/office-pdf`。各自的 `apps/open-office-host` 提供文档会话、命令、查询与导出；Vue/Tauri 提供文件和多标签工作台。PDF 的解析、页面渲染和编辑由本地 Rust 引擎完成。

笔记本采用 `src/notes/` 中的本地 TypeScript 结构化模型，由 `NotebookEditor.vue` 和 `NotebookCanvas.vue` 提供编辑界面，以 `.oonote` 保存。它不增加第五套 WASM 引擎。格式和限制见[笔记本说明](notebook.md)，当前变更见[0.17.0 更新说明](releases/0.17.0.md)。Server、共享快照和局域网同步接口已移除；`src-tauri/src/server.rs` 仍为桌面 WebView 提供本机资源，不是共享文档服务。

画布与代码图表使用 `src/workflow/` 中的 TypeScript 文档模型、SVG 渲染器和编辑组件，以 `.owflow` 保存；格式导入与导出说明见[画布与代码图表](workflow.md)。两个工作区共享顶部文件操作、主题、标签生命周期和自动保存。

## 本地环境

需要 Node.js 24、Rust stable（至少 1.95）和平台的 Tauri 构建依赖。独立兼容检查还使用 Python 3.12；它不是产品运行依赖。WASM 工具版本须与锁文件匹配：

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
npm run dev
```

`predev` 从仓库源码构建四套编辑器；构建脚本校验输入与产物摘要，匹配时复用缓存。`OFFICE_WORD_TARGET_DIR`、`OFFICE_SHEET_TARGET_DIR`、`OFFICE_PRESENTATION_TARGET_DIR`、`OFFICE_PDF_TARGET_DIR` 可指定 Cargo 缓存位置，`CARGO_BUILD_JOBS` 控制并发。不要同时用同一目标目录构建多个工作区。

桌面开发与打包：

```sh
npm run desktop:prepare
npm run desktop:dev
npm run desktop:build
```

准备步骤构建前端并校验四套本地编辑器的 WASM、JS、字体及摘要。安装包无需额外的 PDF 处理进程或 Python 运行时。

## 检查

```sh
npm test
npm run icons:check
npm run engine:check
npm run branding:check
npm run build
npm run word:check
npm run sheet:check
npm run deck:check
npm run pdf:check
npm run test:browser:word
npm run test:browser:sheet-engine
npm run test:browser:ppt-engine
npm run test:browser:pdf
npm run test:browser:pdf-toolbar
npm run test:browser:notes
node tests/browser/notebook-alignment.cjs
node tests/browser/workflow-editors.cjs
```

PPT 浏览器与原生报告使用 `src/presentation/rust/office-presentation-native-smoke.ts` 和 `scripts/office-presentation-native-smoke.mjs`，独立检查器 `scripts/office-presentation-inspect-presentation.py` 使用 ZIP/XML 和独立 PDF 检查库读取实际导出，避免仅根据编辑器自己的状态判定成功。原生发布流程同时要求四套编辑器的安装包验收，通过后才公开安装包。

命名检查扫描源代码与最终构建产物，只有法律来源、历史证据、旧文件读取协议和独立检查工具的明确记录可保留原标识。可用 `node scripts/check-office-branding.mjs --no-source --log PATH` 检查本轮运行日志；日志检查不应用源代码的兼容标识例外。

Node 单测覆盖共享文件格式、会话隔离、保存收据、失败导入、原生报告和发布门槛。各引擎的 Rust 测试按其工作区规则运行。UI 测试需要 Chromium、软件 WebGL 和足够的磁盘/内存；只生成 WASM 不表示真实界面已验证。

笔记本界面验收覆盖分区、页面、待办、图片、搜索、删除确认、批量关闭、下载重开及深浅主题。PDF 操作栏验收通过真实鼠标操作检查工具与视图切换、手写签名、图章、删除确认和撤销，并独立读取导出的 PDF。两套脚本分别输出 `test-results/notebook-ui/` 和 `test-results/office-pdf-toolbar/`；这些浏览器报告不代替原生安装包验收。

## 交互约定

- 顶部新建、打开、保存、另存为、导出、打印与撤销重做针对当前标签。引擎内部不另设文件操作或主题入口。
- 太阳、月亮、显示器按钮控制全局主题；切换标签或主题不能丢弃正在输入的文字。
- 文档会话独立，关闭未保存文档需确认。批量关闭集中显示待保存文档，可全部保存、全部不保存或取消。只在文件写入成功且收据匹配导出快照时清除脏状态，较晚编辑保持未保存。
- 打开前先解析并校验新会话，失败时保留现有文档。桌面版已打开的 DOCX/XLSX/PPTX/PDF/OONOTE 使用已授权路径直接保存；另存为不能覆盖其他打开标签的文件。CSV/TSV 转换另存为 XLSX，POTX/PPSX 转换另存为 PPTX。
- 主页文档列表独立滚动，长文件名省略显示且可查看完整名称。PDF 常用编辑与视图操作使用操作栏，高级菜单保留其余已接通功能；可视签名和图章保留直接入口。
- 所有操作图标来源于 `src/icons/svg/`。`npm run icons:build` 生成 Rust 图形定义，`icons:check` 检查生成结果和别名一致性。原始开源版权保留在法律文档，正常界面使用 Open Office 命名。

## 目录

```text
src/components/           四套 Rust 编辑器宿主与笔记本编辑界面
src/{word,sheet,presentation,pdf}/rust/  会话桥接与真实画布验收
src/notes/                本地笔记本模型、会话与内容转换
src/pdf/                  PDF 公共处理
src/shared/               文件格式与二进制辅助
src/icons/                原创 SVG 图标与生成输入
vendor/office-{word,sheet,presentation,pdf}/  固定上游源码及本地适配
assets/fonts/             字体来源、许可、字节与校验清单
public/office-{word,sheet,presentation,pdf}/  生成的 WASM/JS（不入 Git）
src-tauri/                本地文件、窗口与打印支持
public/legal/             组件版权、来源和对应源码说明
```

旧专项文档和兼容语料保留用于历史追溯或独立样例；被移除内核的测试结果不能用于证明当前功能。发布需提供精确提交的应用源码、构建材料、许可证及适用的对应源码，见根目录第三方声明。

## 自动保存验证

自动保存的正常间隔为 10 秒。已到期但仍在输入、显示弹窗或存在未确认草稿时，调度器按 1.2 秒复查，并在每次尝试前重新检查文档身份和保存条件；暂缓不会计为保存成功，也不会累加失败退避。实际保存失败仍按原有退避规则重试。顶部只有在文件写入及精确版本回执均成功后才显示“已自动保存”。

`node tests/browser/word-autosave.cjs` 可在不构建的情况下检查真实 Vue 外壳、现有 Word WASM 和完整 10 秒计时，覆盖连续输入、输入法组合和编辑器弹窗暂缓后恢复，并独立解析导出 DOCX。它只在浏览器测试中替换本机读写桥，不代表原生写盘、系统输入法或修改后的 Rust 弹窗已通过验收；报告写入 `test-results/word-autosave/`。

`npm test` 包含自动保存、保存回执与真实 App 状态回归，检查未确认草稿不会被后台提交，写盘期间的新修改不会被旧回执清除。安装包原生验收使用正常的 10 秒自动保存计时器，将已选择本机位置的文档写入隔离临时文件，再通过正式文件接口读回、独立解析 DOCX 并在 Rust 编辑器中重新打开；同时检查焦点保留、无弹窗和临时文件清理。临时文件位置由验收命令提供，不声称覆盖系统文件选择器交互。浏览器测试不能代替 Windows/macOS 安装包与原生 IPC 验收。
