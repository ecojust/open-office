# Rust 文字核心第一阶段：独立 DOCX 对照

本目录保留两份独立手写 OOXML 的完整 DOCX 原件及各自经原生 LibreOffice 生成的 DOCX、ODT、PDF。原件没有使用产品的 TypeScript 或 Rust 导出器生成。`manifest.json` 记录 8 个文件的 SHA-256、原生版本和转换命令；原生输出未经过过滤或改写。

固定原生版本：LibreOfficeDev 26.8.0.0.alpha0，提交 `2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`。转换使用独立用户配置目录。命令中的 `Fontconfig error: No writable cache directories` 是原始 stderr；六次转换均正常退出并生成保留的完整文件。

| 原件 | 独立预期 |
| --- | --- |
| `basic-direct.docx` | 三段；左、居中、右对齐；中文、😀、🌍、组合重音；12/14/18 pt；自动色及明确 RGB；粗体、斜体；最后为空段且保留 18 pt 插入格式。 |
| `basic-styles.docx` | 两段；文档默认、段落样式、`basedOn`、具名字符样式逐层继承；首段居中、粗斜体、12 pt、`123456`；第二段直接覆盖为右对齐、常规体、自动色。 |

两份手写原件是基础导入的正例。两份 `native-docx/` 重存文件是明确拒绝的负例：原生增加了有效的 `lang`、`kern` 和复杂文字字号等属性，第一阶段模型无法完整表示。测试确认原始 XML 中的属性仍存在，再验证导入拒绝；不会删除这些属性以制造兼容成功。ODT、PDF 是独立原生阅读结果，不代表产品能打开 ODT/PDF，也不证明产品与原生分页逐像素一致。

基础导入范围要求正文只有普通段落和文本 run，字体明确为所有文字系统同一 `DejaVu Sans`，字号明确为 8–72 pt 的半点数值，页面和四边距明确，孤行控制明确关闭。可继承的样式属性仅限当前模型支持的格式；导出按有效值展开，不保留样式名称、未使用样式或文档元数据。`auto` 保留为语义值，白纸显示黑色。

图片、表格、编号、页眉页脚、多节、超链接、域、修订、主题字体/颜色、语言、独立段落标记格式、自定义行距和制表位等有效语义均拒绝。存在 tab 的输入必须明确声明 `defaultTabStop=720`，导出始终明确写出该值，避免不同软件采用不同缺省制表位。ZIP 完整性、命名空间、关系、MIME、DTD、重复属性和未知结构另有拒绝测试；这不是对任意 Word 或 LibreOffice 文件的兼容承诺。

可在仓库根目录运行：

```sh
cargo test --manifest-path crates/word-engine/Cargo.toml --test docx_compat
```

浏览器与 CLI 的独立 XML 校验由 `tests/browser/rust-word-docx-oracle.py` 执行，不把产品自身重新打开的结果作为唯一正确性依据。
