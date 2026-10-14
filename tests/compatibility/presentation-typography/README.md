# 段落与上下标独立语料

`spacing-baseline.pptx` 是原创 MIT 测试文件，由 `generate.py` 使用 python-pptx 建包后直接写入 DrawingML。它不是参考办公软件生成的样例，也不经过应用自己的导出器来生成预期数据。ZIP 时间戳固定，源文件 SHA-256 记录在 `manifest.json`。

四页分别覆盖：

1. 90% / 150% / 固定 12pt 行距；24pt 文字、手动换行、段前 6pt 与段后 8pt。
2. 26pt 文字的正、负、零基线；任意 18% / -10% 偏移；12.34pt 字号。
3. 列表级默认值、局部显式 0、空段落 37.2pt 段末属性。
4. 12/42/18pt 混合字形的固定 12pt 行距；首尾段距开关。

启动 `npm run dev` 后：

```sh
node tests/browser/presentation-typography.cjs
python3 tests/compatibility/presentation-typography/verify.py
```

浏览器运行生产导入、场景及导出代码；Python 使用独立 ZIP/XML 与 PyMuPDF 回读文字结构、字号和基线坐标。无操作保存比较全部文字体 XML 的元素、属性和内容；不要求序列化后的冗余命名空间、外层页名或 ZIP 字节相同。

可选官方桌面对照（需要先准备软件及独立 X 显示器）：

```sh
ONLYOFFICE_BINARY=/absolute/path/to/DesktopEditors \
ONLYOFFICE_DISPLAY=:105 \
ONLYOFFICE_MANIFEST="$PWD/tests/compatibility/presentation-typography/manifest.json" \
ONLYOFFICE_CASES=spacing-baseline \
ONLYOFFICE_VARIANTS=original,noop,styled,edited \
ONLYOFFICE_CAPTURE_ALL_SLIDES=1 \
ONLYOFFICE_EXPORTS="$PWD/test-results/presentation-typography" \
ONLYOFFICE_OUTPUT="$PWD/test-results/typography-native-final" \
node tests/compatibility/onlyoffice-desktop.mjs
```

参考截图用于观察差异，不作逐像素相等断言。数值上下标、百分比基数与参考软件固定上/下标样式、字体度量可能不同，具体结论见[第二轮报告](../../../docs/presentation-typography-iteration.md)。
