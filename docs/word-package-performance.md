# DOCX 包核心性能诊断

这项基准比较 Rust ZIP 容器核心、Chromium 中的 fflate 与现有前端包处理代码，并单独记录 base64、JSON 和进程传输成本。它不测完整应用打开/保存耗时，也不测真实 Tauri IPC、系统 WebView 或文件读写。

下方实测数据保留优化前的历史结果。后续实现已采用查表 CRC，并将 XML 校验与语义读取合并为每次导入只解析一次；当前脚本使用 schemaVersion 2，指标定义见文末。旧报告与数字未重写，不能视为当前版本的耗时。

## 2026-10-14 实测结果

正式运行于 17:46:40–17:48:37 UTC，使用 Linux x86-64、Xeon Platinum 8573C（环境报告 3 个逻辑 CPU、进程可用并行度 2）、Rust 1.99.0 默认 release、Chromium 154.0.8037.57、Node 24.19.0 和 fflate 0.8.2。运行前等待其他构建与浏览器测试结束。7 个案例全部通过，源码和二进制散列在运行期间不变，无外部请求或浏览器错误。

包读取结果如下，均为毫秒，`中位数 / P95`。浏览器两列都使用当时的 Word 读取代码，只排除了逐成员 XML 解析；查表列在该次测量时是尚未进入产品的诊断变体。

| 样本 | 解压字节 | Rust 包读取 | 浏览器逐位 CRC | 浏览器查表 CRC |
| --- | ---: | ---: | ---: | ---: |
| LibreOffice 普通正文 | 14,792 | 0.089 / 0.326 | 6.75 / 9.79 | 5.53 / 10.14 |
| LibreOffice 显式格式 | 15,217 | 0.212 / 0.384 | 4.50 / 5.82 | 3.35 / 3.92 |
| LibreOffice 标题 | 14,893 | 0.106 / 0.193 | 4.60 / 6.22 | 3.49 / 5.63 |
| LibreOffice Unicode 与换行 | 14,838 | 0.076 / 0.100 | 4.26 / 5.35 | 3.60 / 5.16 |
| 100 段生成正文 | 45,635 | 0.045 / 0.065 | 6.25 / 7.72 | 3.35 / 4.66 |
| 1,000 段生成正文 | 434,632 | 0.146 / 0.298 | 57.95 / 79.00 | 15.20 / 25.25 |
| 4,000 段生成正文 | 1,731,290 | 0.825 / 1.908 | 280.75 / 507.75 | 60.65 / 83.05 |

4,000 段样本包含 219,727 个 UTF-16 单位。CRC 查表变体的读取中位数减少 78.4%，说明当时前端逐位 CRC 是可直接优化的成本，不能把两种算法的差距全归因于语言。Rust 包核心在这组样本中更快，但它没有执行 XML、OOXML 语义或 DOM 操作。

压缩写入使用相同的文件集合，Rust 为 `Compression::fast()`，fflate 为 level 1：

| 样本 | Rust 写入中位数 | fflate 写入中位数 | Rust / fflate 产物字节 |
| --- | ---: | ---: | ---: |
| LibreOffice 普通正文 | 0.226 ms | 1.27 ms | 5,863 / 5,652 |
| LibreOffice 显式格式 | 1.191 ms | 0.98 ms | 5,996 / 5,769 |
| LibreOffice 标题 | 0.919 ms | 0.92 ms | 5,924 / 5,690 |
| LibreOffice Unicode 与换行 | 0.839 ms | 1.13 ms | 5,942 / 5,727 |
| 100 段生成正文 | 0.517 ms | 1.11 ms | 3,890 / 3,989 |
| 1,000 段生成正文 | 0.357 ms | 7.70 ms | 18,933 / 19,765 |
| 4,000 段生成正文 | 1.763 ms | 26.60 ms | 68,967 / 72,028 |

Rust 写入并非所有小样本都更快。不同压缩后端也会生成不同体积的 ZIP；兼容性验证比较解压后的每个文件，而不是要求压缩包本身字节相同。当前浏览器生产写入使用 stored，不压缩：4,000 段的产物为 1,731,982 字节，含 XML 检查的写入中位数为 141.7 ms，这与上表压缩函数的工作范围不同。

4,000 段的分层成本进一步显示，原生核心耗时不等于调用方耗时：

| 指标 | 中位数 / P95 |
| --- | ---: |
| Rust 核心读取 | 0.825 / 1.908 ms |
| Rust base64 读取接口 | 2.066 / 3.060 ms |
| Rust 核心写入 | 1.763 / 2.626 ms |
| Rust base64 写入接口 | 2.708 / 4.741 ms |
| Rust 序列化解压文件集合 JSON | 1.995 / 2.914 ms |
| 浏览器解码文件集合 base64 | 9.20 / 12.05 ms |
| Node 常驻进程 JSON 管道读取 | 25.661 / 66.954 ms |
| Node 常驻进程 JSON 管道写入 | 13.087 / 24.170 ms |
| Node 每次启动 CLI 并读取 | 31.287 / 84.054 ms |
| 浏览器原始包读取，包含 XML 检查 | 405.00 / 593.70 ms |

空请求每次启动诊断进程的中位数为 3.797 ms。管道测试包括 Node 与子进程的 JSON/base64、复制和调度；它不能替代 Tauri IPC。若把解压后的大 XML 文本来回转换为 base64，仅测 Rust 核心会明显低估实际成本。

完整样本、环境和散列保存在 [word-package-performance-results.json](word-package-performance-results.json)，SHA-256 为 `9445ae8a4ff692d15a436b4bd7ce0db8da0fca80b63490989a04fd402965fa0b`。各项 P95 有明显波动，部分极短浏览器操作受计时分辨率影响出现 0；这不代表零成本。没有进行多机器或置信区间实验，也没有把短样本结果推广为稳定的产品延迟承诺。

查表 CRC 已用于 Word 路径；首次打开的重复完整导入和单次导入中的重复 XML 解析也已消除。后续仍需减少大文件集合的 base64/JSON 往返，并在真实发布版 Tauri 中测打开与保存。如果继续迁移 XML/OOXML 到 Rust，应让原生端直接消费已授权文件或原生字节缓冲，返回紧凑文档模型，避免先把全部 XML 送回前端解析。上述历史数据用于定位成本，不能推导“纯 Rust 界面必然更快”。

## 复现

先安装项目依赖和 Rust 工具链，构建优化版诊断程序：

```sh
cargo build --release --locked --manifest-path crates/word-package/Cargo.toml --bins
node scripts/benchmark-word-package.cjs
```

自定义目标目录时设置 `WORD_PACKAGE_BENCH=/绝对路径/release/word-package-bench`；同目录应有 `word-package-cli`，也可通过 `WORD_PACKAGE_CLI` 指定。`RUSTC` 用来记录编译器版本，`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器。结果、实际输入文档和 Vite 缓存写入 `test-results/word-package-performance/`，可用 `WORD_PACKAGE_BENCH_OUTPUT` 改路径。

`WORD_PACKAGE_BENCH_SMOKE=1` 仅用于快速验证：1 次预热、3 个样本、最大 100 段，不作为性能结论。正式模式每项预热 5 个批次、测量 25 个批次；小于 15,000 字节的输入每批执行 10 次，较大输入执行 2 次，报告每次操作平均耗时的中位数与最近秩 P95。Node 进程传输每个样本执行一次。P95 是批次均值的分位数，不能当作单次操作延迟的 P95。

运行时暂停其他构建、浏览器测试与代码修改。脚本检查参与测量的源码与二进制 SHA-256 前后相同；原始报告保留全部样本、输入及包内文件散列、编译器、浏览器和机器信息。

## 各项测量的范围

| 指标 | 包含的工作 |
| --- | --- |
| Rust `coreRead` / `coreWrite` | 直接调用生产 `read_package` / `write_package`，包括边界与结构校验、分配、解压/压缩和 CRC；不含 JSON、base64 或进程启动 |
| Rust `base64Read` / `base64Write` | 实际生产 base64 接口，包括核心处理与编码/解码；写入接口测试用的输入克隆在计时外 |
| Rust `json*` | JSON 请求反序列化或解压后文件集合响应序列化，单独计时 |
| Chromium `checkedPackageBitwiseCrc` | 当前 Word 私有 `readParts` 的诊断变体，仅将 CRC 循环替换为旧的逐位算法；保留 ZIP 检查与 fflate Inflate |
| Chromium `checkedPackageTableCrc` | 当前生产 `readParts`，使用 256 项查表循环；XML 校验已移至后续语义导入阶段 |
| Chromium `checkedPackageTableCrcWithXml` | schemaVersion 2 的诊断组合：当前 `readParts` 加每个 XML/rels 一次语法校验，不含 OOXML 语义与模型转换；不能当作完整导入耗时 |
| Chromium `rawFflateUnzipNoCrcValidation` | 原始 fflate `unzipSync`，不做应用的路径、边界、CRC 拒绝检查，不能与安全读取器视为等价工作量 |
| Chromium `rawFflateZipLevel1` | fflate `zipSync` 的 level 1 压缩，不做应用的输入验证；Rust 使用 `Compression::fast()`，后端算法和压缩率仍不同 |
| Chromium `actualStoredWritePartsWithXml` | 当前浏览器生产写入函数，包括 XML 检查与 ZIP 写出，使用 stored 不压缩；不含模型转 OOXML |
| Chromium `browser*Base64` | 实际前端 base64 辅助函数，分别测压缩包和文件集合的编码/解码 |
| Node `nodePersistentBridge*` | Node JSON.stringify → 常驻 Rust 子进程 stdin → Rust 解析、base64 接口、JSON 响应 → Node JSON.parse；明确不是 Tauri IPC |
| Node `nodeOneShotCliRead` / `nodeOneShotProcessPing` | 每次创建进程并完成读取或空 ping，包含启动、管道、JSON 与结束；不能计为 Rust 核心处理时间 |

包读取变体通过基准专用 Vite 插件从当前 `docx.ts` 创建，精确断言被替换代码只出现一次，记录每个变体散列。生产文件不变。这样不复制整套读取实现，也不会静默跟丢产品变化。三个读取变体对输入及 Rust 输出的所有成员做字节对比；再修改 ZIP 两份 CRC 字段而保留压缩内容，要求三者及 Rust 均拒绝。历史 schemaVersion 1 报告中的 `actualReadPartsWithXml` 指当时自带 XML 预校验的真实读取器；它与当前诊断组合的代码路径不同。

四个小样本是兼容性语料中的原始 LibreOffice DOCX，读取前比对语料清单 SHA-256。另三个样本使用确定性的中英文段落、不同颜色和粗体，通过真实 OOXML 导出器生成 100、1,000、4,000 段文档；必须能由真实导入器读回，正文完全一致。生成样本不标作 LibreOffice 编写的文档。

当前 Rust 包限制为压缩包 16 MiB、解压总量 32 MiB、单文件 4 MiB、256 个成员、文件名 1,024 UTF-8 字节。独立文字模型上限为 5,000 段、250,000 个 UTF-16 单位；基准不把不存在的图片/表格支持用于凑大文件。

各项独立计时的中位数不能相减后当作精确开销，也不能相加推算真实 Tauri 耗时。单机短样本结果适合定位成本，最终迁移决策仍应测发布版的打开、保存、内存和交互响应。
