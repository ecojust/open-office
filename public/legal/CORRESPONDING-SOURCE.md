# 对应源码归档说明

当前 Open Office 的文字、表格和演示编辑器分别由仓库内固定版本的 Rust 源码构建。`vendor/wordcraft/`、`vendor/gridcraft/` 和 `vendor/deckcraft/` 包含上游源码及本地宿主改动；各自的来源清单保留上游提交与许可，生成的构建清单记录实际输入、JS 和 WASM 摘要。旧办公兼容运行时不再包含在当前发行物中。

## PDF 运行时源码

`corresponding-sources-manifest.json` 固定以下三份官方归档的 URL、大小和 SHA-256：

1. PyMuPDF 1.28.2 的 PyPI 源码分发包。
2. MuPDF 1.28.2 完整源码包，包含 `thirdparty/` 源码。
3. CPython 3.12.14 源码；该版本不能代表使用其他 Python 版本的安装包。

在应用源码目录运行 `node scripts/fetch-corresponding-sources.mjs` 下载至 `artifacts/corresponding-sources/`，并生成清单副本和 `SHA256SUMS`。`--verify` 或 `--offline` 仅核验已有文件，缺失或损坏时失败；`--out-dir` 可指定源码发行目录。下载器不解压或执行归档。

PyMuPDF 源码包不能代替完整 MuPDF C/C++ 源码，因此二者分别固定。`pdf-backend/engine.py`、requirements 和 `scripts/build-pdf-backend.mjs` 也属于必须随本应用提供的构建材料。不同平台的 Python、PyInstaller 或底层库若有变化，须核对实际版本、许可和对应源码，不能沿用不匹配的记录。

## 发行材料

发行页应提供安装包、精确提交的应用源码（包含编辑器本地修改）、适用的依赖源码、许可证、构建脚本和配置、锁文件、来源清单及校验文件。源码可以独立于二进制分发，不必嵌入安装包。依赖索引包含开发或可选项，不能作为逐平台实际链接报告；按安装包实际内容核对对应源码完整性。

这些固定来源和摘要支持追溯与核验，不声称已经证明所有平台的二进制逐字节可重现。完整许可见 `THIRD_PARTY_NOTICES.md`、`DISTRIBUTION_LICENSE.md` 及同目录许可原文。
