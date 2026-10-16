# OfficeWord 核心独立对照

`independent-rich.docx` 和 `independent-seed.docx` 由本目录 `generate.py` 直接写入标准 OOXML 部件，未调用 Open Office、OfficeWord 或 LibreOffice 导出器。`colors.png` 是 Python 标准库生成的 2×2 RGBA 图片。

完整原件、LibreOffice 原生回存的 DOCX、原生 PDF 均保留；没有删除原生输出的样式、属性或部件来迎合导入器。原生版本为 LibreOfficeDev 26.8.0.0.alpha0，提交 `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`。`manifest.json` 记录文件 SHA-256、独立 profile 下的实际转换命令及 stdout/stderr。原生回存存在字体、段落和包结构规范化，所以比较已声明的语义，不要求字节相同。

`inspect_docx.py` 只使用 Python 标准库 ZIP/XML 读取 DOCX，独立解析正文、表格单元格、页眉页脚、样式继承、文字属性、段落属性、图片关系和 PAGE 域。`--pdf` 使用 PyMuPDF 提取真正 PDF 的文字与文字跨度。该检查器不调用产品解析器，不将自身输出作为所有 OOXML 的兼容结论。

`tests/office-word-core.test.mjs` 的普通 Node 测试验证冻结语料哈希，以及手写原件和完整原生回存的已知语义。本目录 `run.mjs` 导出的 `runOfficeWordCore(adapter, outdir)` 由真实浏览器验收调用，通过正式 host WASM API 执行打开、编辑、格式、表格、图片、页眉页脚、DOCX 重存与重开和 PDF 导出。普通 Node 测试本身不证明 WASM 已运行。实际结果以浏览器报告为准。

对照的 OfficeWord 上游提交是 `3292ba05d3c15c003823be6849e87a1c6e205242`。其 DOCX 读取器明确采用宽容解析，未知标记可能被跳过；部分图表、SmartArt、OLE、宏和附属部件有保留机制，但不等于任意 Word 文件无损重存。此样例只证明列出的具体内容，不能外推为全部 Word 兼容或性能改进。

运行语料检查：

```sh
node --test --experimental-test-isolation=none tests/office-word-core.test.mjs
python3 tests/compatibility/office-word-core/inspect_docx.py tests/compatibility/office-word-core/independent-rich.docx
python3 tests/compatibility/office-word-core/inspect_docx.py --pdf tests/compatibility/office-word-core/native-pdf/independent-rich.pdf
```

重新运行 `generate.py` 会重新生成原件及初始 manifest；不要在验收过程中运行。保留的原生文件由 manifest 中的转换流程生成，生成器不会将原生输出当作手写原件覆盖。
