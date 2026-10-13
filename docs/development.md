# 开发与构建

[返回项目首页](../README.md)

## 本地开发


需要 Node.js 24、Python 3.12、Rust stable，以及 Tauri 对应系统的原生构建依赖。macOS 需要 Xcode Command Line Tools；Windows 需要 Visual Studio C++ Build Tools 与 WebView2。

```bash
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
```

桌面发布工作流仅由 `workflow_dispatch` 触发。选择 `platform=all` 与 `publish=true`，三种安装包通过构建及应用内自检后，才发布测试版；源码推送本身不会自动发布。

发布检查包括实际启动、文档编辑、保存重开与 PDF 独立回读。Windows x64 与 macOS ARM64 使用对应平台的真实应用；Intel 安装包原生编译后，将原封 DMG 转移到 ARM Mac，通过 Rosetta 验证 x64 应用和 PDF 进程。搬运前后校验安装包、应用文件、链接与签名，不重新构建或签名。该检查不等同于真实 Intel 显卡测试。

构建版本采用北京时间 `YYYY.MMDD.HHmm`，可通过 `OFFICE_BUILD_VERSION` 固定。每份安装包以对应 Actions 记录和提交为准。

## 目录


```text
src/                    Vue 外壳、原生文件桥、PDF 工作室
src/office/             办公内核消息桥与类型
public/office/          独立办公内核宿主与线程适配
public/office-runtime/  校验后下载的 WASM、数据与字体（不入 Git）
public/legal/           随应用分发的许可文本
pdf-backend/            受控 JSON 协议的本地 PDF 编辑器及真实文件测试
src-tauri/              Rust 文件保存、隔离静态服务器、窗口与进程管理
scripts/                资源准备、PDF 冻结、签名及原生冒烟验证
vendor/                 固定版本与资源摘要
```

