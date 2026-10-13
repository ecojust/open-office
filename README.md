# Open Office

基于 Vue 3、Tauri 2 的本地办公桌面应用。一个窗口打开文字文档、电子表格、演示文稿与 PDF，文件处理在设备内完成，无需账户或远程文档服务。0.2.0 新增基于 LibreOffice Impress 的演示工作区。

Microsoft 365 桌面 PowerPoint 的功能对齐情况、引擎限制及实际验收标准见[功能对齐审计](docs/powerpoint-365-parity.md)。当前版本尚未完成全部功能对齐，后续架构选择仍待确定。

## 可用功能

| 工作区 | 文件格式 | 编辑方式 |
| --- | --- | --- |
| 文字文档 | DOCX、ODT | 完整 LibreOffice Writer 内核：段落、样式、表格、图片、页眉页脚、分页等；导出 PDF |
| 电子表格 | XLSX、ODS | 完整 Calc 内核：单元格、公式、工作表、排序、筛选、图表等；导出 PDF |
| 演示文稿 | PPTX、ODP | Impress WASM 内核：多页幻灯片、文字、形状和图片编辑；保存重开、导出 PDF、静态放映预览 |
| PDF 工作室 | PDF | 原有文字删除与替换、新增文字/图片、高亮、手绘签名、搜索、旋转、删除、排序、提取和合并页面 |

桌面外壳提供多文档标签、最近文件、本地打开、保存、另存为、未保存退出确认。保存前检查原文件摘要，避免静默覆盖外部修改；文件写入使用同目录临时文件及原子替换。

演示文稿可新增幻灯片，沿用当前页的布局与母版，不复制原页文字或图片。F5 与内置放映菜单打开基于 PDF 的逐页静态预览，支持翻页、键盘操作、Esc 退出及浏览器支持时的全屏。当前不启用 WASM 内核的原生放映；预览不播放动画、切换特效、音频或视频。

当前打印流程先导出 PDF，再由系统 PDF 阅读器执行打印；尚未集成系统打印任务管理。未应用的 PDF 编辑草稿会阻止保存或切换，需先应用或明确放弃。

这不是 Microsoft Office 或 WPS 的官方产品，不宣称与其所有功能和排版完全一致。完整办公内核的高级菜单目前为英文，中文输入与中文字体已集成。Office 宏和自动外部链接更新禁用；不支持旧 DOC/XLS/PPT 直接导入，请先转换为受支持的格式。PPTX/ODP 编辑与导出不代表完整 PowerPoint 兼容；复杂母版、特殊字体、动画和切换效果可能存在差异，交付前请检查原稿与导出结果。PDF 原文编辑针对可提取文字，扫描件需要独立 OCR。手绘签名不等于带证书的数字签名；修改已有数字签名的文件须另存副本。复杂排版和图表也请在交付前复核。

## 获取安装包

在 [GitHub Releases](https://github.com/ecojust/open-office/releases) 下载对应平台：

- Windows x64 安装程序。
- macOS Apple Silicon（M 系列）DMG。
- macOS Intel DMG。

安装包包含办公引擎、中文字体和 PDF 内核，安装后可以离线运行。办公引擎启动时需要约 1 GiB 的共享内存，建议至少 8 GiB 内存；文字、表格与演示标签复用同一个内核，不为每份文档重复启动引擎。PDF 编辑支持不超过 40 MiB、500 页的文件，超过上限时会明确报错并保留原文件。

尚未配置 Apple Developer ID 公证及 Windows 商业代码签名。macOS 包会做本地 ad-hoc 签名验证，但这不等于 Apple 公证。如果系统阻止打开，请先核对发布的 SHA256，再按系统“隐私与安全性”中针对该应用的提示允许打开；不建议关闭系统全局安全保护。

## 开发

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

## 构建与验证

```bash
npm run typecheck
npm test
npm run pdf:test
npm run desktop:build
```

通过 GitHub Actions 的 Desktop release 工作流可在 Windows x64、Apple Silicon 和 Intel 三种原生构建机上生成对应安装包。发布前必须实际启动应用，确认隔离环境与 SharedArrayBuffer 可用，再执行 Writer 原文修改后保存重开、Calc 公式往返、Impress 两页幻灯片修改后分别保存重开 PPTX/ODP，以及 PDF 中文原文替换后的重开检查。Impress 还须实际导出 PDF，由独立 PDF 内核回读确认两页；不能只凭文件存在或导出成功标志判定通过。任何一种安装包未通过时不发布。文档往返、PDF 导出与静态预览检查不等于原生动画放映或所有 PowerPoint 特性的兼容验证。

Windows 与 Apple Silicon 包在对应架构上运行上述检查。Intel 包保留原生构建、PDF 引擎测试、x86_64 架构与严格签名检查；由于 GitHub Intel 虚拟机的原生 WebGL 图形环境不可用，完整界面检查使用同一次构建的原封 Intel DMG，在 Apple Silicon macOS 15 上通过 Rosetta 运行真实 x64 App 与 PDF 进程。搬运前后校验 DMG 摘要、App 全部文件、符号链接和签名，不重建、不换成 ARM 包。报告分别记录目标架构、宿主架构与执行模式。**这不等同于已在真实 Intel GPU 上实测**，也不保证所有显卡、系统版本或复杂文档均兼容。

构建版本采用北京时间 `YYYY.MMDD.HHmm`，也可通过 `OFFICE_BUILD_VERSION` 固定，用于对应安装包与测试记录。

真实浏览器回归（先在另一终端运行 `npm run dev`）：

```bash
npx playwright install chromium
npm run test:browser
```

它使用真实 PDF 引擎生成测试文档、在界面编辑并导出，不接触用户自己的文件。若使用系统 Chromium，可指定 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`。结果及截图保存在 `test-results/`。

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

## 许可与源码

原始仓库的 MIT 许可与作者版权声明保留在 `LICENSE`。集成发行包包含 AGPL、GPL、MPL/LGPL、Apache 2.0、MIT 和 OFL 等许可组件，不能仅按 MIT 二进制软件分发。请阅读 `DISTRIBUTION_LICENSE.md`、`THIRD_PARTY_NOTICES.md` 和 `public/legal/` 中的完整许可。源码与构建脚本公开在本仓库；对应第三方源码获取脚本与发布来源说明一并提供。

项目与 Apache OpenOffice、Microsoft Office、WPS 均无隶属关系。
