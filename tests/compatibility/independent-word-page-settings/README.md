# 页面设置独立对照语料

本目录只接收独立作者输入及真实 LibreOffice 首次、再次保存的完整 DOCX/PDF。`freeze.py` 逐字节复制并保存 SHA-256，不通过产品导出建立期望。`inspect_docx.py` 使用 Python ZIP/XML 和 PyMuPDF 检查实际文件；它报告原始属性，不擅自补全缺省值。`manifest.json` 的有效页面期望来自原生首开后的完整文件，原始 XML 另存于 `sourceInspection`。

范围为单节纸张宽高、方向标志及四边距。宽高与方向标志独立比较；省略属性、部分属性、近标准尺寸、非整数磅自定义尺寸、零边距和空页眉页脚距离均有原生对照。非零装订线、负边距、占满正文区域的边距作为完整负例；原生修复件保留在研究目录。

浏览器测试执行真实控件、下载、一次撤销、选区保留、非法输入和打开失败原子性、320×400 视口取消/应用，以及保存→真实原生重存→重开。PDF 纸张框与 DOM 纸张、正文宽度分别核对；不宣称浏览器分页或全文排版等同原生。

UI 在应用时提前规范接近标准纸型的尺寸，是确保保存重开稳定的产品约定。原生属性接口可能保留自定义尺寸直到下一次 DOCX 打开，测试不把两者编辑时点描述为完全一致。

运行前需完成原生研究封存并执行 `python3 tests/compatibility/independent-word-page-settings/freeze.py`，再先做完整包导入闸门：

```sh
WORD_PAGE_SETTINGS_GATE_ONLY=1 WORD_PAGE_SETTINGS_OUTPUT=test-results/word-page-settings-gate node tests/browser/independent-word-page-settings.cjs
WORD_PAGE_SETTINGS_OUTPUT=test-results/word-page-settings-final node tests/browser/independent-word-page-settings.cjs
```

原生转换每次使用独立临时 profile，顺序运行，不连接共享 UNO 实例。原生版本及研究命令、源码、核验报告哈希见 `research-provenance.json`；没有 Microsoft Word 运行时或真实 Tauri IPC 验证。
