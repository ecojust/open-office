# 开发与构建

当前应用使用三个本地 Rust/WASM 编辑器：`vendor/wordcraft`、`vendor/gridcraft`、`vendor/deckcraft`。各自的 `apps/open-office-host` 提供文档会话、命令、查询与导出；Vue/Tauri 提供文件和多标签工作台。PDF 继续使用 PDF.js 与原生 PyMuPDF 后端。旧兼容办公内核和早期文档实现已移除。

## 本地环境

需要 Node.js 24、Python 3.12、Rust stable（至少 1.95）和平台的 Tauri 构建依赖。WASM 工具版本须与锁文件匹配：

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
npm run dev
```

`predev` 从仓库源码构建三套编辑器；构建脚本校验输入与产物摘要，匹配时复用缓存。`WORDCRAFT_TARGET_DIR`、`GRIDCRAFT_TARGET_DIR`、`DECKCRAFT_TARGET_DIR` 可指定 Cargo 缓存位置，`CARGO_BUILD_JOBS` 控制并发。不要同时用同一目标目录构建多个工作区。

桌面开发与打包：

```sh
npm run desktop:prepare
npm run desktop:dev
npm run desktop:build
```

准备步骤使用 PyInstaller 构建本机 PDF 后端，最终用户无需另外安装 Python。不要跨架构复制 `pdf-runtime`。Office WASM 和字体均随资源打包，构建不再下载旧办公运行时。

## 检查

```sh
npm test
npm run icons:check
npm run engine:check
npm run build
npm run word:check
npm run sheet:check
npm run deck:check
npm run test:browser:wordcraft
npm run test:browser:sheet-engine
npm run test:browser:ppt-engine
```

PPT 浏览器与原生报告使用 `src/presentation/rust/deckcraft-native-smoke.ts` 和 `scripts/deckcraft-native-smoke.mjs`，独立检查器 `scripts/deckcraft-inspect-presentation.py` 使用 ZIP/XML 和 PyMuPDF 读取实际导出，避免仅根据编辑器自己的状态判定成功。原生发布流程同时要求三套编辑器和 PDF 的安装包验收，通过后才公开安装包。

Node 单测覆盖共享文件格式、会话隔离、保存收据、失败导入、原生报告和发布门槛。各引擎的 Rust 测试按其工作区规则运行。UI 测试需要 Chromium、软件 WebGL 和足够的磁盘/内存；只生成 WASM 不表示真实界面已验证。

## 交互约定

- 顶部新建、打开、保存、另存为、导出、打印与撤销重做针对当前标签。引擎内部不另设文件操作或主题入口。
- 太阳、月亮、显示器按钮控制全局主题；切换标签或主题不能丢弃正在输入的文字。
- 文档会话独立，关闭未保存文档需确认。只在文件写入成功且收据匹配导出快照时清除脏状态，较晚编辑保持未保存。
- 导入前先解析并校验新会话，失败时保留现有文档。Office 导入第一次保存为副本；POTX/PPSX 保存为 PPTX。
- 所有操作图标来源于 `src/icons/svg/`。`npm run icons:build` 生成 Rust 图形定义，`icons:check` 检查生成结果和别名一致性。原始开源版权保留在法律文档，正常界面使用 Open Office 命名。

## 目录

```text
src/components/           三套 Rust 编辑器宿主和 PDF 工作区
src/{word,sheet,presentation}/rust/  会话桥接与真实画布验收
src/pdf/                  PDF 公共处理
src/shared/               文件格式与二进制辅助
src/icons/                原创 SVG 图标与生成输入
vendor/{wordcraft,gridcraft,deckcraft}/  固定上游源码及本地适配
assets/fonts/             字体来源、许可、字节与校验清单
public/{wordcraft,gridcraft,deckcraft}/  生成的 WASM/JS（不入 Git）
src-tauri/                本地文件、窗口与 PDF 后端桥接
pdf-backend/              PDF 编辑后端与测试
public/legal/             组件版权、来源和对应源码说明
```

旧专项文档和兼容语料保留用于历史追溯或独立样例；被移除内核的测试结果不能用于证明当前功能。发布需提供精确提交的应用源码、构建材料、许可证及适用的对应源码，见根目录第三方声明。
