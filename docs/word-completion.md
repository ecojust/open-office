# Word 常用编辑与保存补全

本轮依据固定版本 `sdkjs`（`72b0421c0bbf9d01eed9cf14834ae47eb2df1b50`）中 `word/api.js` 的公开行为进行独立实现（REA 证据 `ev_4e0b6967d3435880c7f90ca73341d7114d318439859748c2b77ea44535adae16`，3 个文件、15 个函数、3359 个 AST 节点，0 解析失败），继续使用现有本地 Writer 内核；没有复制参考软件源码，也没有更换文档内核。

## 对照结论与实现

- 参考软件的单次替换针对当前搜索命中。本工作台此前总从选区末尾继续搜索，重复词场景会跳过当前命中。本轮先用内核检验选区是否恰好是符合大小写、全字规则的搜索结果，再替换该范围；否则继续搜索下一处。替换后推进到下一匹配，避免同文或仅大小写替换一直停在原处；同文替换不重写原有富文本。
- 删除线、上下标、高亮以字符属性增量写入，保留同一段其他文字。上、下标使用已核实的内核自动定位值（±14000）和 58% 字号比例，显式还原到正文会重置位置和字号比例。高亮清除写入透明值，避免仅改变工具栏显示。
- 超链接操作使用当前真实文字选区，在同一原生撤销上下文内先执行 `RemoveHyperlink`，再为新建或改址写入 `HyperLinkURL`；明确删除只执行前一步。保留文字和手动设置的字体、字号、粗体与颜色，链接自动外观可随移除而取消。工作台支持普通 http、https、mailto 地址，不打开链接或请求远端。清空地址并应用或点击“移除链接”会明确删除链接属性。
- 链接草稿使用已有文档版本和选区保护；选区变化后不把旧输入写入新位置。对象、多选、过大选区及不支持的地址不会写入。改址仅支持普通、属性明确的同址链接；目标窗口、名称、自定义链接样式、已绑定事件、混合或不可读属性均在修改前拒绝，请在画布中分别编辑。混合链接仍可明确统一移除。原生事件容器中仅含 `EventType=None` 的未绑定占位不会被误当成宏或脚本。

来源定位：`word/api.js` 中 `asc_replaceText`、`put_TextPrStrikeout`、`put_TextPrBaseline`、`put_TextPrHighLight`、`add_Hyperlink`、`change_Hyperlink`、`remove_Hyperlink`。研究文件位于项目外 `/workspace/open-office-research/onlyoffice/office-breadth-targeted/source/word/api.js`。

## 测试状态

- `node --test --experimental-test-isolation=none tests/writer-tools.test.mjs`：36 项通过，含输入校验、属性写入前完整预检、显式格式重置、非法链接与过期选区拒绝、当前重复词替换、同文与大小写替换推进、高级链接元数据拒绝及真实原生默认事件占位。
- 真实 WASM 文档测试：`WRITER_TARGET=completion PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/writer-workbench.cjs`，10 组通过。核对实际 DOCX XML、超链接关系、语义上下标、DOCX/ODT 导出后原生重新打开，以及字符格式、链接插入/改址/移除的一步撤销和重做。部分链接删除只删除选中字符的链接，两侧保留；报告 `test-results/writer-completion/completion-proof.json`。
- 后续元数据守卫专项：同一脚本 `WRITER_TARGET=link-metadata`，3 组通过。普通链接改址及撤销通过；含目标窗口/名称的链接拒绝改址，导出 ODT 前后全部链接属性一致；明确删除后撤销也恢复原高级属性。报告 `test-results/writer-link-metadata/report.json`。上述正式运行均未启用临时诊断注入。
- 真实 Vue UI 测试：`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/writer-completion-ui.cjs`，5 组通过：重复词同文/大小写替换推进、链接草稿改址回读、上下标还原与删除线、高亮清除后下载实际 DOCX 检查，以及 390/320 像素窗口无页面横向溢出。报告 `test-results/writer-completion-ui/report.json`；实际运行截图 `test-results/writer-completion-ui/writer-completion.png`；下载文件 `test-results/writer-completion-ui/ui-edited.docx`。

## 边界

这批功能并不表示 Word 与参考软件全面等价。项目符号与编号的工作台控制、复杂域与邮件合并、不同节的页眉页脚等仍需后续专项处理。现有画布可提供部分相关能力。本轮不新增书签跳转链接；新写入地址限 http、https、mailto，已有链接只有用户明确操作才变更，复杂或混合链接改址仍受上述保护限制。多属性写入已在首次修改前检查目标属性可用性，并在内核支持时使用同一撤销上下文；不宣称任何底层运行异常都能自动回滚。

## 实测中纠正的问题

早期候选值 ±101 会被当前内核按普通位移写出，导致 DOCX 上下标偏移接近整字号。核对内核 `include/editeng/escapementitem.hxx` 的 `MAX_ESC_POS` 和 `DFLT_ESC_AUTO_SUPER/SUB` 后，改用真正的自动常量 ±14000。测试要求导出 `w:vertAlign` 的 superscript/subscript，不能只看工具栏状态。

直接清空或覆盖旧 `HyperLinkURL` 在当前内核中会产生可撤销记录，但一次撤销不能恢复原有实际 DOCX 链接节点与关系。短链路检查已确认不是异步刷新或状态读取问题；本轮在同一上下文中先同步执行原生 `RemoveHyperlink` 再写入新地址，实际文件和选区属性均可恢复。复杂链接改址会丢失高级属性的风险通过写前拒绝控制，不以未经验证的属性写回覆盖原数据。链接自身的默认外观会随链接移除而取消，手动设置的字体、字号、粗体与颜色单独验证保留。
