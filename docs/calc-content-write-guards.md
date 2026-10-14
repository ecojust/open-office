# 表格内容写入：合并单元格、数组公式与停止型验证保护

中文公式栏、逐格数据编辑和批量数据录入现在会检查三类已知结构及规则。保护发生在当前原生表格模型中，保存时不补回旧文件内容。

## 已复现的问题

- 在 `A1:A2` 中导入 `{=ROW(A1:A2)}` 数组公式后，原 `set-cell` 或 `patch-cells` 可直接把数组成员 `A2` 写成 `99`，接口没有报错。导出的 XLSX 仍宣称数组范围为 `A1:A2`，成员缓存却变成 `99`；再次打开后原生内核重新计算，`A2` 又变回 `2`。同批普通单元格已经修改，导致用户看到的保存结果不稳定。
- 给单元格设置“整数 1–10、停止错误提示”后，三条侧栏内容入口均能直接写入 `99`、`-1` 或 `42`。原因是 UNO 内容 setter 不经过原生交互式数据验证；规则存在并不等于这些 API 自动执行规则。
- `B2:C3` 合并后，原三条内容入口仍能写入 `C2`、`B3`、`C3` 等覆盖格，产生画布上看不到的值。真实 XLSX/ODS 导出和本内核重开仍保留这些隐藏值；没有把这一现象描述为重开丢失。单格 `getIsMerged()` 对覆盖格返回 false，不能作为可写判断。

数组与验证基线输出、RPC 记录和复现脚本位于研究目录 `onlyoffice/word-calc-followup-audit/` 及其 `write-guards/` 子目录。合并格基线在 `test-results/highlight-calc-followup/before-report.json`。这些记录来自真实本地 WASM，不是模型模拟。Word 页眉页脚另有后续局部编辑保护，见 [word-decoration-editing.md](word-decoration-editing.md)。

## 处理方式

`public/office/calc-tools.js` 在 `set-cell`、`patch-cells`、`set-matrix` 写入前统一检查所有目标：

先用目标工作表的原生 `createCursorByRange(...).collapseToMergedArea()` 获取完整合并范围。校验工作表、整数坐标、上下界和包含关系，只有左上角锚点可写。覆盖格即使写空值也整批拒绝，并提示具体锚点地址；矩阵中前面的普通格不会先写入。只检查本次目标，不展开遍历整个合并区域。锚点、未合并邻居及对另一工作表的合法锚点写入继续可用。

1. 每个目标都读取真实 `getArrayFormula()`。只要目标含数组公式，整批拒绝，普通目标也不先写入；整块数组替换同样保守拒绝，提示在画布内使用完整数组编辑。
2. 读取当前单元格的原生 `Validation`，不使用可掩盖读取失败的默认值。`ANY` 正常通过；有规则且启用 STOP 错误提示时，拒绝侧栏改写并提示到画布单元格输入，由原生编辑器完成验证。
3. 不自行解释自定义公式、列表来源、日期或跨单元格依赖。因此 STOP 格中的有效值也需要使用画布输入，这是一条明确的功能边界，而不是声称已实现完整验证器。
4. warning、information，以及关闭错误提示的规则保留此前侧栏写入行为；侧栏不会额外弹出它们的原生提示。未知验证类型、未知提示状态、需要宏处理的验证及元数据读取失败均不会被当成可写许可。
5. 全部目标检查通过后才执行原有 setter。保留普通公式、数值、文本和批量输入能力；文档其他位置存在数组或验证规则不阻止普通格编辑。

这是一组已知结构和规则的写前检查，并非任意底层异常的通用事务回滚。它不扩大数组计算、动态数组或公式兼容性，也不改变原生画布编辑、复制填充等其他入口的既有语义。

## 验证

- `tests/calc-tools.test.mjs` 覆盖数组锚点/成员、整块数组、批量前部普通目标、未知元数据、原生检查异常、STOP 整数/列表/自定义规则、warning/info/无错误提示，以及普通格正例。
- `tests/browser/calc-completion.cjs` 使用单个真实 Calc WASM 实例，验证被拒操作不改变任何目标、选区或修改状态；检查合法普通编辑仍能写入；独立解析实际 XLSX 数组范围、缓存及验证规则；再重开实际 XLSX 和 ODS，确认值、公式和保护边界仍成立。
- 最终结果记录在 `test-results/calc-completion/report.json`，含实际加载的 `calc-tools.js` SHA-256。桌面各平台安装包不在本轮检查范围内。

前一轮数组与验证结果（2026-10-14）：**29 个定向 Node 测试、33 项真实 WASM 检查通过，0 个页面运行错误**。当时源码 SHA-256 为 `05ced799444ca764ed816c552b204e27c6145a333d1d3467ddf27f5b11b77078`。实际输出为 `guarded-writes.xlsx/.ods` 和 `guarded-validation.xlsx/.ods`；普通填充、撤销、跨表引用及统计的原有回归也包含在该次集中检查中。

合并格定向回归入口为 `tests/browser/calc-merged-write-guards.cjs`，输出在 `test-results/highlight-calc-followup/`。它另外检查横向、纵向、矩形合并、非活动工作表、锚点格式、矩阵空值覆盖和 XLSX/ODS 导出重开；独立文件检查计入 ODS 的 `number-columns-repeated`，不会把重复节点误算成少了覆盖格。

合并格后续结果：**33 个 Calc 定向 Node 测试、17 项真实 WASM 检查通过，0 个页面运行错误**。`report.json` 中源码散列与本轮冻结文件一致；最终文件为 `guarded-merges.xlsx/.ods` 和 `reopened-edited.xlsx/.ods`。首次 ODS 审计错误及之前已经通过的 14 项检查保留在 `report-initial-ods-repeat.json`，产品没有因此修改。
