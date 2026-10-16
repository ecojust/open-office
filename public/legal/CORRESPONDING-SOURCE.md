# 对应源码归档说明

当前文字、表格、演示和 PDF 编辑器分别从 `vendor/office-word`、`vendor/office-sheet`、`vendor/office-presentation`、`vendor/office-pdf` 的固定 Rust 源码构建。本地修改随应用源码提供；法律目录记录原始上游提交、许可及文件摘要，构建清单记录实际修改后的输入和 WASM 摘要。

`corresponding-sources-manifest.json` 提供需单独获取的固定上游归档。运行 `node scripts/fetch-corresponding-sources.mjs` 下载，`--verify` 或 `--offline` 核验，`--out-dir` 指定输出目录。下载器不执行归档内容。各依赖的精确源码链接和原始许可另见逐项依赖索引；例如适用 MPL 的音频组件须按其许可提供对应源码。已修改的 vendored 依赖须提供本仓库内的实际修改，而不能只给原版链接。

每次发行应提供精确提交的完整应用源码、四套编辑器及本地修改、构建脚本和配置、锁文件、来源与校验清单、许可证以及实际组件适用的源码材料。旧 Python/PDF 后台已从当前产品移除；历史安装包仍以各自版本的声明和材料为准。

这些记录支持来源核验，不声称已证明跨平台二进制逐字节可重现。许可原文优先于本文概述。
