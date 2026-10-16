# 开发与构建

当前应用使用四个本地 Rust/WASM 编辑器：`vendor/office-word`、`vendor/office-sheet`、`vendor/office-presentation`、`vendor/office-pdf`。各自的 `apps/open-office-host` 提供文档会话、命令、查询与导出；Vue/Tauri 提供文件和多标签工作台。PDF 的解析、页面渲染和编辑由本地 Rust 引擎完成。

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
```

PPT 浏览器与原生报告使用 `src/presentation/rust/office-presentation-native-smoke.ts` 和 `scripts/office-presentation-native-smoke.mjs`，独立检查器 `scripts/office-presentation-inspect-presentation.py` 使用 ZIP/XML 和独立 PDF 检查库读取实际导出，避免仅根据编辑器自己的状态判定成功。原生发布流程同时要求四套编辑器的安装包验收，通过后才公开安装包。

命名检查扫描源代码与最终构建产物，只有法律来源、历史证据、旧文件读取协议和独立检查工具的明确记录可保留原标识。可用 `node scripts/check-office-branding.mjs --no-source --log PATH` 检查本轮运行日志；日志检查不应用源代码的兼容标识例外。

Node 单测覆盖共享文件格式、会话隔离、保存收据、失败导入、原生报告和发布门槛。各引擎的 Rust 测试按其工作区规则运行。UI 测试需要 Chromium、软件 WebGL 和足够的磁盘/内存；只生成 WASM 不表示真实界面已验证。

## 交互约定

- 顶部新建、打开、保存、另存为、导出、打印与撤销重做针对当前标签。引擎内部不另设文件操作或主题入口。
- 太阳、月亮、显示器按钮控制全局主题；切换标签或主题不能丢弃正在输入的文字。
- 文档会话独立，关闭未保存文档需确认。只在文件写入成功且收据匹配导出快照时清除脏状态，较晚编辑保持未保存。
- 导入前先解析并校验新会话，失败时保留现有文档。Office 导入第一次保存为副本；POTX/PPSX 保存为 PPTX。
- 所有操作图标来源于 `src/icons/svg/`。`npm run icons:build` 生成 Rust 图形定义，`icons:check` 检查生成结果和别名一致性。原始开源版权保留在法律文档，正常界面使用 Open Office 命名。

## 目录

```text
src/components/           四套 Rust 编辑器宿主
src/{word,sheet,presentation,pdf}/rust/  会话桥接与真实画布验收
src/pdf/                  PDF 公共处理
src/shared/               文件格式与二进制辅助
src/icons/                原创 SVG 图标与生成输入
vendor/{word,sheet,presentation,office-pdf}/  固定上游源码及本地适配
assets/fonts/             字体来源、许可、字节与校验清单
public/{word,sheet,presentation,office-pdf}/  生成的 WASM/JS（不入 Git）
src-tauri/                本地文件、窗口与打印支持
public/legal/             组件版权、来源和对应源码说明
```

旧专项文档和兼容语料保留用于历史追溯或独立样例；被移除内核的测试结果不能用于证明当前功能。发布需提供精确提交的应用源码、构建材料、许可证及适用的对应源码，见根目录第三方声明。

## 浏览器工作区验证

`npm test` 包含自动保存、同步协议、版本冲突与真实 App 状态回归。独立 HTTP 后端测试使用 `npm run test:server`，不依赖桌面 GUI 工具链。构建 `tests/browser-server-harness` 中的 `office-browser-harness` 后，以 `OFFICE_SYNC_HARNESS=/绝对路径/office-browser-harness npm run test:browser:workspace` 运行实际 HTTP 与双浏览器的 DOCX、XLSX、PPTX、PDF 同步回归；先执行 `npm run build`。其中 XLSX 使用真实键盘输入，并检查未确认草稿不会被后台提交；其他格式通过实际 Rust 编辑命令修改，再独立检查导出文件。该验证使用打包后的界面与 Rust/WASM 引擎，不代替 macOS/Windows 安装包与原生 IPC 验收。
