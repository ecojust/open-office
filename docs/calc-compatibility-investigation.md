# 表格兼容性：确认根因与尚未修复的范围

2026-10-14。对既有 XLSX 风险追加真实 Calc WASM 诊断、导出 ZIP/XML 独立读取及重开检查。本轮没有更换计算内核，也没有通过改公式或回填旧缓存掩盖结果差异。

| 项目 | 本轮实际观察 | 结论 |
| --- | --- | --- |
| 布尔常量 | `Calendar!B5` 原件是无公式的 `t=b` 常量；导入后尚未保存就成为 `=TRUE()`，`ISFORMULA` 返回 TRUE；导出仍含 `TRUE()` | 差异发生在导入模型，不只是导出 XML |
| 深度隐藏 | `Lists` 原件为 `veryHidden`；首次保存变 `hidden`；现有接口只有 `IsVisible` 布尔状态 | 尚未保留独立的三态可见性，按原表名回填不可靠 |
| UNIQUE | 单独 `UNIQUE` 报 `#NAME?`、错误码 525；`COUNTA(UNIQUE(...))` 自身无错误却返回 1 | 外层 COUNTA 把内层错误计为一个非空值，掩盖了不支持的函数 |

实际样例 `Template!C7:C12` 有三个不同类别，`I32` 为 `COUNTA(_xlfn.UNIQUE(C7:C12))`。首次打开读取到原缓存 3；触发重算后变为 1；修改源数据增加一个类别后应为 4，却仍为 1，保存重开也为 1。首轮缓存正确不能证明函数受支持。

当前随包引擎为 24.2.8.0；[官方 UNIQUE 帮助](https://help.libreoffice.org/latest/en-US/text/scalc/01/func_unique.html)说明该函数从 24.8 起提供。只有取得实际可用、固定版本的新 WASM 构建，并完成公式、溢出与依赖重算的验证后，才能更新兼容结论。不能由桌面版支持直接推断网页内核已支持，也不能承诺升级会同时解决布尔常量和深度隐藏。

## 参考研究

固定 SDK 源 `72b0421c0bbf9d01eed9cf14834ae47eb2df1b50` 的 REA 专项解析了 16 个必要函数，5 个摘录文件、3,463 个 AST 节点、零失败，证据 `ev_e707a012fa44040875a1cd7ff196218a0064da62dee7497bd329587b2073ae82`。

参考实现将布尔值与公式分别建模，UNIQUE 产生数组供 COUNTA 遍历。不过，该固定 SDK 自身也将 `veryHidden` 转为布尔隐藏，不能照搬这项降级。研究目录另保存了 11 项隔离方法探针；它们使用最小类型桩，不属于原生参考软件验收。

## 可核对证据

- `test-results/calc-risk-investigation/report.json`：真实内核状态、错误码、源值修改和重开结果。
- `test-results/calc-risk-investigation/archive-observations.json`：原件及输出 SHA-256、单元格 XML、工作表状态。
- 研究目录 `open-office-research/onlyoffice/calc-risk-diagnostic.cjs`：本轮隔离诊断脚本。
- 研究目录 `open-office-research/onlyoffice/rea-xlsx-semantics-findings.md` 和对应 summary：源行号、哈希与 REA 证据。

上述三项继续列为**未修复**，沿用明确警示和默认另存副本。副本保护避免自动覆盖原件，不等于当前编辑中的计算语义或导出内容已经保真。

## 新版实验内核对照：尚未集成

同日继续调查发现，ZetaOffice 官方 CDN 的 `zetaoffice_latest` 四件套与现用 24.2.8.0 的完整文件哈希仍完全相同，但 [官方 WASM 开发页面](https://wiki.documentfoundation.org/Development/WASM)列出的 [TDF 测试站](https://wasm-test.libreoffice.org/)提供了另一套可实际运行的新版实验构建。

该候选的 `versionrc` 嵌入 build ID 为 **`44dcf332743801f2d2aa54c77f4411db0b53be18`**，与[同一源码提交](https://github.com/LibreOffice/core/tree/44dcf332743801f2d2aa54c77f4411db0b53be18)对应；源码版本为 **27.2.0.0.alpha0+**，不是正式稳定发行版。2026-10-14 捕获的四件套已核对 ETag、长度、SHA-256 和完整 data 内的 build ID，没有替换应用资源或将它作为生产依赖。

| 捕获资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| soffice.js | 841431 | d95a2c4260f254968eaaa1167c9323cce47aab9bf3ce2605200796dcb0e04361 |
| soffice.data.js.metadata | 179242 | ca6c88a5389e9cb667d9f217074aa160779a27c545c775f8bbe0f2014cba940d |
| soffice.data | 86707942 | 3a509a9f66335016821f9f2958d7efc3948849cd0c0e91705de4693cc0bfdd24 |
| soffice.wasm | 155891673 | fabb6ca4b6ff84940fb9fa41dec765d89720a44b4522f07990571dec4b54609a |

完整采样清单在研究目录 `open-office-research/onlyoffice/runtime-upgrade/tdf-44dcf332/capture-manifest.json`。这些哈希是对官方 HTTPS 返回字节独立计算所得；本轮未发现另行发布的签名或校验清单，不宣称有额外的发行签名证明。

在独立研究服务中沿用现有本地修补的 ZetaJS 1.2、Calc 桥接和离线策略，真实运行该候选，得到以下对照：

| 检查 | 新版候选实际结果 | 适用结论 |
| --- | --- | --- |
| 原样例 `COUNTA(_xlfn.UNIQUE(C7:C12))` | 初始 3；修改 C7 后 4，保存重开仍 4；再修改 C8 后 5，再保存重开仍 5 | 已知嵌套 UNIQUE 样例的依赖重算和两轮 XLSX 往返正确 |
| 单格直接输入 `UNIQUE(A1:A6)` | 首格得到 Marketing、无错误，B2:B6 仍为空 | 未实现该输入方式的自动溢出，不能称完整动态数组兼容 |
| 布尔常量 | 导入仍为 `=TRUE()`，ISFORMULA 为 TRUE，保存仍含公式 | 差异未修复 |
| veryHidden | 首次保存仍降为 hidden | 差异未修复 |
| 原生模块 | Writer 可新建并查询状态；Impress 返回 `Unsupported URL / type detection failed` | 该候选不能覆盖原有全部原生模块；当前独立 PPT 编辑器需按实际辅助路径评估影响 |

导出包独立读取确认 I32 的缓存依次为 3、4、5，仍保留 `COUNTA(_xlfn.UNIQUE(C7:C12))` 公式，没有回填常量。另测单格直接输入 OOXML 前缀 `_xlfn.UNIQUE(...)` 时仍报 525，而 XLSX 导入能将它识别为原生 UNIQUE；导入支持不等于公式输入接受所有前缀。本轮未覆盖全部参数、二维结果、exactly_once、空值、错误、溢出阻挡或 ODS 往返。

首次使用原桥接启动时，新版 Emscripten 未导出的 `Module.HEAPU8` 被两处可选诊断读取，触发 abort。仅在研究服务的 host 响应中移除这两处堆大小读取后，以上诊断运行完成。原始失败和适配后成功报告分别保留，未通过改公式或关闭离线策略绕过问题。

成功诊断中页面错误和外网请求均为 0，但捕获到 **509 条 Embind 自动释放警告**、一条 `__syscall_mprotect` 警告及若干 Qt 警告。日志表示本次会自动释放；没有长期内存测量，不能直接认定为新版新增泄漏，也不能据短用例通过忽略对象寿命、内存峰值和性能回归。

### 正式迁移仍缺少的条件

- **固定下载渠道**：当前地址为测试站根路径下的滚动 `soffice.*`。主页未公布版本归档；本轮探测 commit/日期子路径均为 404，尚未找到可依赖的官方不可变 URL。将新哈希直接绑定滚动地址，会在上游替换后使新机器或 CI 下载失败；需要先保存为受控、可长期获取的固定构建资产，或建立可重复自构建流程。本轮没有发布外部镜像。
- **完整来源和发行材料**：核心 build ID 已能映射到源码，但编译工具链、Qt、外部依赖、补丁及完整 SBOM/对应源码材料尚未齐备；不可复用旧内核的对应源码清单。ZetaJS 的 MIT 许可不覆盖完整 WASM，LibreOffice、Qt 及其他组件仍须按实际许可处理。
- **目标平台回归**：仅在 Linux Chromium 154.0.8037.57 完成实测，尚未验证 macOS Intel/Apple Silicon 的 WKWebView 或 Windows WebView2。候选涉及共享内存、线程、OffscreenCanvas、WASM 异常处理、BigInt 和 1 GiB 初始内存，需要在目标平台验证画布、输入、剪贴板、保存及资源释放。其 JS 未发现 `WebAssembly.Suspending`/`promising` 调用，但本次 Chromium 本身具有这些 API，不能据此宣称已做关闭 JSPI 的验证或给出未经实测的最低系统版本。

新增证据都在研究目录 `open-office-research/onlyoffice/runtime-upgrade/`：

- `README.md`、`source-findings.md`、`source-fetch-manifest.json`：官方来源、版本、构建和许可边界。
- `tdf-44dcf332/diagnostic/summary.json`、`report.json`：真实计算、模块和告警记录；其中 `ok: true` 只表示调查流程完成。
- `tdf-44dcf332/diagnostic/archive-observations.json`：导出文件哈希、公式及缓存的独立 ZIP/XML 读取。
- `tdf-44dcf332/diagnostic-unmodified-bridge/`：未适配 host 的启动失败证据。
- `tdf-44dcf332/browser-features.json`、`browser-feature-static.json`：实际浏览器特性及候选脚本静态观察。

**正式产品仍使用 24.2.8.0，以上三个生产风险仍为未修复。** 新版候选只证明其中一组 UNIQUE 计算可通过更换内核改善，尚未集成、未完成全平台和完整文档回归，也没有消除布尔常量与深度隐藏差异。
