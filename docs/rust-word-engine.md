# Rust 文字内核：第一阶段

**0.7.0 功能预览。** 默认“文字文档”入口已接到自研 Rust 内核，完成基础 DOCX 正文的新建、打开、编辑、排版和保存链路。安装包可用状态以发布页为准；发布流程要求本次 CI 与真实应用检查通过。[0.7.0 更新说明](releases/0.7.0.md)

## 实际执行链

`DOCX → Rust 解析 → Rust 文档模型 → Rust 编辑事务 → Rust 字形布局 → Vue SVG 界面`

`crates/word-engine` 自行实现支持范围检查、OOXML 语义读写、段落与文字模型、选区、编辑事务、撤销重做、行布局和分页。桌面通过 Tauri `word_engine_request` 调用该 crate；浏览器由 Worker 调用同一 crate 编译出的 WASM。两条路径使用同一请求协议、字体字节和布局代码。

Vue 仅收集键盘、输入法、鼠标及工具栏操作，显示 Rust 返回的字形轮廓、光标和选区矩形。正文不通过浏览器字体或 `contenteditable` 排版，也不调用旧 TypeScript DOCX 模型。新文档预检通过后才创建标签；每个 Rust 标签保留自己的会话与历史。

基础设施仍使用开源库：`word-package` 的 ZIP 校验与压缩、`roxmltree` 的通用 XML 读取、`rustybuzz` 的字体塑形、`ttf-parser` 的轮廓读取，以及 Unicode 分段、换行和文字系统识别库。固定字体包括 DejaVu Sans、Noto Sans CJK SC 和 Noto Sans Symbols2。OOXML 支持范围、编辑事务和页面布局由本仓库的 Rust 代码实现；LibreOffice 只用于独立兼容性研究与测试，不参与这条编辑执行链。依赖和字体许可随应用分发。

## 当前范围

| 已实现 | 边界 |
| --- | --- |
| 基础 DOCX 导入、导出与重新打开 | 仅接受已实现的正文语义；复杂内容明确拒绝 |
| 中英文输入、可用单色 emoji、组合字符与输入法组合事务 | UTF-16 位置与完整字形簇边界；不支持 RTL、ZWJ emoji 等输入；系统输入法仍需逐平台实测 |
| 插入、删除、换段、选区、纯文本复制粘贴、撤销重做 | 每文档最多 32 条历史、10,000 个 UTF-16 单元（含段落分隔）、500 段 |
| 粗体、斜体、字号、RGB／自动颜色、左中右对齐 | 字号 8–72 磅、半磅步进；固定字体集合；自动颜色在白纸上绘为黑色 |
| Rust 字体度量、换行、分页、光标定位与上下移动 | 单节页面、最多 200 页；中文斜体为 12° 轮廓倾斜 |
| 多标签及保存状态 | 最多同时打开 4 份 Rust 文档；实际保存成功才标记已保存 |

暂不支持表格、图片、编号、页眉页脚、批注修订、多节、任意字体、打印和 PDF 导出。DOCX 必须明确字体、字号、页面、页边距，并明确关闭孤行控制；有效的语言、主题颜色、独立段落标记格式等尚不能表示的属性会拒绝。含制表符的文件须明确默认制表位为 720 twip（36 磅），导出始终声明该值。具体正负例见[独立 DOCX 语料](../crates/word-engine/tests/fixtures/basic-docx/README.md)。

未知有效格式会阻止导入或编辑，不会静默丢弃；失败请求保留原会话、正文和撤销历史。导入的 DOCX 首次保存要求生成副本。受支持的样式会展开为有效格式保存，样式名称、未使用样式和文档元数据不保留。相同文件在其他办公软件中的分页尚不保证一致。

“兼容编辑器”明确保留内嵌办公引擎，用于复杂文字文档；旧轻量文字预览、电子表格、演示与 PDF 工作区各自保留原实现。打开失败不会自动切换引擎。

## 构建与验证

```sh
rustup target add wasm32-unknown-unknown
cargo test --locked --manifest-path crates/word-engine/Cargo.toml
cargo build --locked --manifest-path crates/word-engine/Cargo.toml --bin word-engine-cli
npm run word:build
npm run word:check
npm run test:browser:word-engine
```

`npm run dev` 和 `npm run build` 都先生成或校验 WASM。生成物位于忽略提交的 `public/word-engine/`，源码、字体及产物 SHA-256 写入清单。字体许可随构建复制。浏览器验收使用真实 WASM、键盘与导出文件；CLI 对照和外部 ZIP/XML 检查另行验证，不能用旧 ZIP IPC 测试代替新编辑内核测试。

原生 IPC 可在已配置 GTK/WebKitGTK 的 Linux 调试构建上单独验证：

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml
npm run test:native:word-engine -- "$PWD/src-tauri/target/debug/open-office"
```

该检查从真实 Tauri WebView 调用新命令并独立读取导出 DOCX，不代表 Windows/macOS 安装包、系统输入法或原生文件对话框已验收。

### 本次验证结果（2026-10-15）

- Rust 内核 28 项、DOCX 兼容性 8 项测试通过；899 项 Node 与 83 项 PDF 后端测试通过。
- 0.7.0 发布前浏览器复核通过 8 组验收，真实 WASM 与原生 CLI 完成 67 次协议请求对照（53 次接受、14 次明确拒绝）。覆盖输入、组合输入事务、鼠标选区、格式、撤销、多标签、失败导入和保存重开；100 段文档分页为 6 页，保存重开后正文与页数一致。
- 两份独立构造的完整 DOCX 经导入及两轮导出重开，通过外部 ZIP/XML 检查。真实 LibreOffice 另存文件包含当前未实现的 `kern`／`lang` 格式，因此仍明确拒绝；这不代表已兼容任意办公软件生成的 DOCX。
- 默认文字界面实际加载 Rust WASM，未加载内嵌 Office runtime、iframe 或旧 TypeScript 正文核心。测试期间没有页面异常、控制台错误或外部网络请求，54 个产品与产物文件前后哈希一致。
- 前端生产构建和 Linux 桌面完整编译通过。当前环境缺少 `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess`，原生窗口启动失败，尚未通过真实 Tauri IPC 运行验收。浏览器组合事件测试也不等于系统输入法验收。

本地开发证据位于 `test-results/rust-word-engine-final/`，包括构建日志和原生启动失败报告。最终 0.7.0 浏览器复核位于 `test-results/release-0.7.0/browser/`，报告 SHA-256 为 `107595b203a906cb99a5c9fbc14c3f070e2925419d5cc6aff39fef4752a43189`。这些结果目录不提交到仓库，开发和浏览器验收不能代替发布安装包检查。

0.7.0 发布要求 Windows x64、macOS ARM64 和 macOS Intel 安装包构建、自检及新文字内核的真实 Tauri IPC 检查全部通过。该检查须在完整应用中执行新建、编辑、排版、DOCX 导出重开及失败保护，并继续执行原有工作区检查；旧 `word-package` ZIP IPC 通过不能代替它。Intel DMG 使用 Rosetta 运行，仍不等同于真实 Intel 显卡实测。安装包检查结果以[发布说明](releases/0.7.0.md)及对应 Actions 记录为准。

## 后续阶段

1. 扩展字符和段落格式、页面设置、查找替换及输入无障碍能力，增加独立原件对照。
2. 在 Rust 模型与布局中实现列表、表格、图片、页眉页脚及跨页对象，再逐项开放界面。
3. 增加多节、脚注、域、批注修订和字体嵌入，完善排版差异检查、增量布局与性能测量。
4. 将表格与演示的解析、模型、计算／编辑和布局逐步迁入 Rust；达到相应兼容范围后再撤掉旧入口与资源。

Rust 并不自动保证性能提升。当前优先建立可验证的执行链，尚未给出相比旧引擎的性能提升结论。

[请求与布局协议](rust-word-protocol.md) · [开发与构建](development.md)
