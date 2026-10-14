# 不等宽表格布局样例

运行 `python3 tests/compatibility/presentation-table-layout/make-fixtures.py` 可从本仓库自制的 `presentation-table-text/mixed-cell.pptx` 确定性生成三个单页样例。无需下载外部文稿，SHA-256 记录在 `manifest.json`。

| 样例 | 列宽（毫米） | 行高（毫米） | 外框（毫米） | 目的 |
| --- | --- | --- | --- | --- |
| matched | 20、60、40 | 10、30 | 120 × 40 | 正常不等宽高布局 |
| mismatched-frame | 20、60、40 | 10、30 | 180 × 80 | 查证外框是否独立缩放网格 |
| content-growth | 20、60、40 | 2、2 | 120 × 4 | 查证行高的最小高度语义 |

有色幻灯片背景上，第一列使用明确的纯色底纹，第二列为 `noFill`，第三列不声明填充。正文均为 10pt Arial，四边内距 1mm，没有指定单元格边框或表格样式。

2026-10-14 参考桌面软件实测：前两份文件的幻灯片画布相同；第三份的行被正文撑高，不能把声明的 2mm 视为严格固定行高。资料见 `test-results/table-layout-native-baseline-valid/` 的原生截图、报告与只读像素观察。首次生成器误保留了旧背景，修正后重新生成并完成原生验证，以当前 manifest 和 valid 记录为准。此对照不代表本应用已经实现文字自动撑高或主题表格样式。

`tests/browser/presentation-table-layout-ui.cjs` 通过实际界面编辑、缩放、下载及重开，并独立读取导出的 active-slide XML。其他专项对照共享场景的几何与 PDF，不使用截图代替可编辑表格数据。
