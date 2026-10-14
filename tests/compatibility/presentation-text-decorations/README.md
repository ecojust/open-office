# 普通文字装饰样例

`ordinary-decorations.pptx` 为独立生成的单页 12 对象样例，没有复制商业文档。运行 `python tests/compatibility/presentation-text-decorations/make-fixtures.py` 可以重建；固定时间戳、源码与清单中的 SHA-256 用于检查原件未被修改。

覆盖无/单/双下划线、无/单/双删除线、组合、段落默认继承、显式关闭，以及 0% 和 50% 透明度。另两对象使用 `wavy` 和 `words`，用于验证未支持样式的提示和原始 XML 保留，不能把它们计入完整显示支持。

每个对象均为 Arial 48 pt 的 `H H`，白底、蓝边。词间空格提供不受字形干扰的装饰线采样区。画布为 338.6667 × 190.5 mm，坐标和预期含义见 `manifest.json`。

原生对照显示双下划线退化为单线，且透明文字的装饰线留有较深轮廓；产品按文件含义处理，不复制这些差异。下划线精确位置仍受字体度量影响，本专项不宣称两个产品像素一致。

真实界面测试：`node tests/browser/presentation-decorations-ui.cjs`，默认访问本机 5199；支持 `PRESENTATION_URL` 和 `PRESENTATION_DECORATIONS_UI_OUTPUT`。验证实际控件、撤销重做、局部编辑、下载重开与窄窗口，导出的 PDF 另由独立阅读器检查。
