# 当前文档 MCP 服务

Open Office 桌面版可作为本机 MCP 服务，供支持 Streamable HTTP 的 AI 客户端读取和编辑当前文档。

## 连接

1. 点击左下角的 **MCP 设置**。默认地址为 `http://127.0.0.1:19780/mcp`，可以修改端口。
2. 新配置默认允许编辑。升级后保留原有权限；工作区的 **只读 / 允许编辑** 可直接打开权限设置。需要 AI 修改文档时，勾选 **允许编辑当前文档** 并保存。
3. 复制设置中的客户端 JSON，添加到支持 HTTP MCP 的客户端。配置包含访问密钥，不要公开分享。
4. 打开任意文档，点击工作区中的 **MCP**。出现 **Running** 后即可连接。

只监听本机地址，不开放局域网。设置在桌面客户端中持久保存，但服务每次都需要手动开启。浏览器版可以查看配置，不能启动本机服务。

## 文档范围与生命周期

服务只暴露开启时的当前文档。切换文档、返回工作台、关闭当前文档或退出软件都会停止服务；切回来后需要重新开启。保存新的全局配置也会停止服务。启动失败会显示原因，不会显示 Running。

服务停止后，尚未执行的请求失效，不会继续修改旧文档或改到新文档。界面重载、连接中断时，原生服务会撤销会话或在心跳超时后停止。工具调用按顺序执行，每次请求最多等待 30 秒。

## 可用工具

当前支持以下九种工具，均支持 `document_inspect`；开启编辑权限后还提供 `document_undo` 和 `document_redo`。括号中的 `kind` 是当前文档类型标识。

| 子软件（kind） | 命令发现 / 读取 | 编辑能力 |
| --- | --- | --- |
| 文字文档（`word`） | `word_list_commands`、`word_inspect_document`、`word_query`、`word_read` | `word_execute_command`：内容替换删除、字符/段落格式、样式列表、表格、图片图形、页面布局、页眉页脚、批注修订、文档内剪贴板、表格绘制/擦除、内嵌文档导入和模板样式更新等；`word_select_text` / `word_select_range` 设置编辑位置 |
| 电子表格（`sheet`） | `sheet_list_commands`、`sheet_query`、`sheet_read_range` | `sheet_execute_command`：公式、单元格格式、行列/工作表、排序筛选、图表图片、数据透视表、批注和打印布局；`sheet_write_range` 批量写入二维数据 |
| 演示文稿（`presentation`） | `presentation_list_commands`、`presentation_describe_command`、`presentation_query`、`presentation_list_templates` | `presentation_execute_command`：页面增删复制、文字/形状/图片/表格/图表、主题母版、过渡动画、备注批注；`presentation_apply_template` 应用模板 |
| PDF（`pdf`） | `pdf_list_commands`、`pdf_query`、`pdf_read` | `pdf_execute_command`：文字图像、批注高亮、签名图章、表单及其动作/脚本内容、文档脚本内容、内嵌字体、书签链接、页面管理、水印页眉等 |
| 笔记本（`note`） | `note_read`、`note_read_page` | `note_edit`：分区/页面/子页增删改和移动，区域位置尺寸、富文本、待办及图片；`note_select_page` 显示指定页面 |
| 画布（`canvas`） | `canvas_read`、`canvas_read_elements`、`canvas_list_templates` | `canvas_edit`：全部图形、连线、笔迹和图片的内容样式、位置尺寸、锁定、组合、层级、对齐布局及模板；`canvas_select_elements` 选择或定位元素 |
| 代码图表（`diagram`） | `diagram_read`、`diagram_read_source`、`diagram_list_templates` | `diagram_update`：源码、标题、风格及模板；保留 `diagram_set_source` |
| 计划排期（`schedule`） | `schedule_read`、`schedule_read_calendar`、`schedule_read_workload` | `schedule_edit`：项目、单价、人员、事件、日历、周号、轨道高度；`schedule_import` 导入完整排期，`schedule_export` 导出 JSON／PNG；`schedule_set_view` 切换视图、缩放、选择事件，`schedule_refresh_holidays` 更新假日 |
| 日历便笺（`calendar`） | `calendar_read`、`calendar_export` | `calendar_edit`：日历本改名、每天工时与显示方式、增删改事项、移动、复制、清除指定月、每日工时分配；`calendar_set_view` 切换月份、日期／事项选择与搜索 |

原有新增文字、单元格、幻灯片、PDF 文字框、笔记页面和画布图形的快捷工具继续可用。

### 调用方式

先从 `tools/list` 获取工具定义。文字、表格、演示和 PDF 的 `*_list_commands` 返回当前文档引擎支持的命令、参数说明和可用状态，再把命令名称与参数交给 `*_execute_command`。命令存在但当前不可用时，先根据提示选中对应文字、对象、工作表或页面。不会以打开手动编辑弹窗代替完成操作。

例如，文字文档先用 `word_select_text` 选择一段文字，再调用：

```json
{"name":"word_execute_command","arguments":{"command":"format.set","params":{"props":{"bold":true,"size":18}}}}
```

笔记和画布的 `*_edit` 接收结构化 `operations` 数组；同一批次整体校验、整体提交，出错不保留前半批修改。工具定义包含全部操作和字段。画布锁定对象需先显式解锁。

### 日历便笺接口

打开或新建 `.oocalendar` 日历本后，启用该文档的 MCP。`calendar_read` 支持 `month`、含端点的 `from`／`to`、搜索名称和正文的 `query`、`type:"工作日"`／`"非工作日"`；月份与日期范围取交集。每页默认 200 条、最多 500 条，通过 `offset` 分页，结果包含 `total`、`hasMore` 和 `nextOffset`。`book` 包含 `workdayHours` 与 `allocationDisplay`；每项还返回实际 `share`（0～1）、`days`、`hours`，非工作事项均为 0。份额计算包含该日全部工作事项，不受筛选和分页影响。默认返回跨月历史事项；指定 `month` 时默认附带整月实际分配天数、小时数与占比，可用 `includeHistory:false`、`includeSummary:false` 省略。

工作事项另带 `allocation:{start,end,rightNoteId}`：`start`／`end` 是从整日起点算起的 0～1 累计份额，`rightNoteId` 是胶囊中紧邻右侧的事项，末段为 `null`；非工作事项的 `allocation` 为 `null`。胶囊顺序沿用文档中的稳定顺序，可能与查询结果排序不同，调整边界前可据此确认邻项。

`calendar_edit` 接收最多 100 项原子操作：`book.title`、`book.settings`、`note.add`、`note.update`、`note.delete`、`note.move`、`note.copy`、`notes.clear_month`、`day.allocate`、`day.adjust`。任何一项无效时整批回滚，成功占一次撤销；新增与复制返回 `created` 中的事项 ID。例如：

```json
{"name":"calendar_edit","arguments":{"operations":[{"op":"note.add","note":{"title":"项目评审","date":"2026-11-04","content":"确认下一阶段安排","color":"#4376d4","type":"工作日"}}]}}
```

新增、修改与复制会记录名称、颜色、工作日属性供历史复用，历史不包含正文。`note.copy` 则复制完整事项，可用 `patch` 调整副本；删除事项与清除月份保留历史。

工时配置与分配也通过 `calendar_edit.operations` 修改：

| 操作 | 字段与行为 |
| --- | --- |
| `book.settings` | `patch.workdayHours` 设置每天工时，默认 7、范围 0.5～24、必须为 0.5 的整数倍；`patch.allocationDisplay` 为 `percent` 或 `hours`。设置会保存、可撤销；改变每天工时保留已分配比例 |
| `day.allocate` | `date` 指定日期，`allocations:[{noteId,weight}]` 完整列出该日每个工作事项一次；`weight` 为 0～1，总和必须为 1，可以包含 0，不包含非工作事项 |
| `day.adjust` | `date`、`leftNoteId` 和 `position` 指定分隔线；`position` 是从整天起点算起的累计百分数或小时数，`display` 可指定 `percent`／`hours`，省略时使用日历本设置。分别按 10 个百分点／0.5 小时吸附，只调整左侧事项及紧邻的右侧事项，二者合计不变 |

例如将默认每天工时设为 7 小时，并按小时显示：

```json
{"name":"calendar_edit","arguments":{"operations":[{"op":"book.settings","patch":{"workdayHours":7,"allocationDisplay":"hours"}}]}}
```

工作事项新增、删除、跨日移动、复制或改变工作属性后，受影响日期重新平均分配；只改名称、正文、颜色保留比例。一批中的操作按顺序处理：先新增再 `day.allocate` 保留最后的显式分配，先分配再新增则再次均分。要指定精确分配，使用 `day.allocate`，不要向 `note.update.patch` 传 `weight`。月统计中 `days` 为实际份额之和，`hours = days × workdayHours`；非工作事项不占工时。

`calendar_set_view` 接受 `month`、`selectedDate`、`selectedNoteId`、`search`；选择事项会定位其日期和月份，`selectedNoteId:null` 清除事项选择。它只改变视图，不产生文件修改或撤销记录，只读权限下也可使用。`calendar_export({format:"json"})` 返回完整 `book`，包含全部月份及历史，不写入文件或标记已保存；超过 7 MiB 时通过界面保存。保存与自动保存沿用现有文件操作。格式、统计口径与历史事项使用方式见[日历便笺说明](calendar-notes.md)。

### 计划排期接口

先打开或新建一份排期，再启用该文档的 MCP。`schedule_read` 返回完整 `project`、当前 `view` 和修订状态 `state`。`schedule_edit` 支持以下操作，一次最多 100 项，成功只占一次撤销，任何日期、冲突、人员引用或字段错误均整批回滚。

| 操作 | 参数与用途 |
| --- | --- |
| `project.update` | `patch` 更新名称、起止日期、`dailyRate` 人天单价；单价 `null` 清空，`0` 为零单价 |
| `role.add` / `role.update` / `role.delete` | 新增 `role`，或按 `roleId` 修改 `patch`／删除；有事件的人员须先移动或删除其事件 |
| `role.reorder` | `roleIds` 列出所有人员 ID，调整轨道顺序 |
| `event.add` / `event.update` / `event.delete` | 新增 `event`，或按 `eventId` 修改 `patch`／删除；`roleId:null` 为整体计划 |
| `event.copy` | 按 `eventId` 复制，`patch` 可指定日期、负责人等；保留来源内容及行高 |
| `calendar.update` | `patch` 调整周末／假日显示、`weekNumbering`、手动新增／排除假日 |
| `track.height` / `track.reset` | `key` 为 `overall`、`person-人员ID` 或 `event-事件ID`；高度 84–336px，按 28px 刻度；重置不传 `key` 表示全部 |

例如设置单价并安排一个下午任务：

```json
{"name":"schedule_edit","arguments":{"operations":[{"op":"project.update","patch":{"dailyRate":1000}},{"op":"event.add","event":{"roleId":"person_a","title":"界面评审","startDate":"2026-10-29","endDate":"2026-10-29","height":0.5,"slot":1}}]}}
```

示例中的人员 ID 须替换为 `schedule_read` 返回的真实值，日期须在项目范围内。新增人员或事件可显式指定 ID，也可使用返回的 `created`。全天为 `height:1, slot:0`，上午／下午为 `height:0.5, slot:0/1`；同一人员同一天仍只允许一个事件。

`schedule_read_calendar` 返回可见日期、周号、假日和独立于显示过滤的 `workingDates`。`schedule_read_workload` 返回月度工时、人员和项目总人天及预算，金额单位为元；未设置单价时预算为 `null`。可按 `roleId` 筛选，或用 `basis:"month"` 读取完整月份容量；`projectTotalDays`、`projectBudget` 始终保留项目合计。默认 `basis:"project"` 与界面一致。

`schedule_set_view` 接受 `mode:"people"`（人员）或 `"global"`（事件）、`dayWidth`（36–160）及 `selectedEventId`（`null` 清除选择），只改变显示，不修改保存状态。`schedule_refresh_holidays` 使用内置假日来源，最多等待 8 秒；返回 `refreshing:true` 时表示后台仍在更新，可稍后读取日历。更新失败时沿用缓存，返回实际状态。

`schedule_import` 的 `project` 接收完整排期对象，原子替换内容并保留当前文档及项目 ID，可撤销。`schedule_export` 的 `format:"json"` 返回完整 `project`；`format:"png"` 返回 `mimeType`、`encoding:"base64"`、`base64`、`width`、`height`、`scale`，客户端解码后即可保存 PNG。可指定 `mode` 和 `dayWidth`，不改变当前界面。PNG 包含全部日期、轨道、非零月度胶囊及总工时；单次返回超过 7 MiB 会明确报错，可降低日宽或通过界面导出。

所有排期接口沿用当前文档权限与会话。导出不写入文件或标记已保存；保存和自动保存继续由现有文件操作负责。

文字文档的 `edit.copy` / `edit.cut`、无参数 `edit.paste` / `edit.pasteMerge` / `edit.pasteText` 使用当前文档的内部剪贴板，不访问系统剪贴板。`edit.clipboardItems` 可读取历史，`edit.pasteClipboardItem` / `edit.pasteAllClipboard` 可粘贴历史内容；`edit.repeat` 会重新检查被重复命令的文档权限与参数。`table.draw` 必须提供 page、x0、y0、x1、y1，`table.eraser` 必须提供 page、x、y，不能只打开画笔模式。

`insert.textFromFile` / `insert.object`、`styles.copyFrom`、`tools.attachTemplate` / `tools.updateStyles` 接收 `name`（仅文件名与扩展名）和 `data`（文档字节的 base64）；样式复制还需提供 `styles`。它们不会读取该名称对应的本机文件，也不替换当前文档身份。`styles.organizer` 无参数时列出当前文档样式，提供 name/data 时可检查素材文档样式。导入内容和更新样式支持正常撤销。

PDF 的 `text_font_import` 使用 `params.path` 引用 `assets` 中的字体文件名，字体须通过现有字体嵌入校验。`form_actions` / `form_set_actions` 读取或替换字段动作；`form_set_script` 编辑字段的验证、格式或计算脚本；`js_document_scripts` / `js_set_document_script` 读取、增删或修改文档内保存的脚本内容。脚本运行沿用 PDF 引擎的既有规则；MCP 不开放 `js_run` 控制台或系统命令。

文字定位的 `off` 使用 UTF-8 字节偏移；按文字定位时优先用 `word_select_text`。工作表、幻灯片索引从 0 开始。PDF 新命令的页码和对象序号从 **1** 开始，旧 `pdf_add_text` 的 `page` 仍从 **0** 开始，具体以命令说明为准。

图片等素材以内嵌数据传入，不能引用本机路径。PDF `assets` 是素材名到 base64 的映射，命令文件字段仅引用该映射；不会读取其他文件。HTTP 请求体最多 8 MiB，工具参数最多 7 MiB，各软件可设置更小的单素材上限。读取时省略图片二进制，大文本和集合按工具说明限制或分页。

### 页面与保存

MCP 使用当前界面的同一个文档、选区和历史。编辑完成后同步重绘正文/工作表/幻灯片与缩略图/PDF，笔记与画布更新页面和属性面板，代码图表更新源码与预览，日历便笺更新事项、历史选择与月度统计；未保存标记及撤销重做状态同时更新。操作仍可用顶部撤销、重做，或 `document_undo` / `document_redo`。

保存和自动保存继续使用原有文件操作；新建文档仍需先选定保存位置。正在输入、拖动或打开手动编辑弹窗时，请先结束该操作再调用 MCP。服务不提供任意脚本执行、系统命令或访问其他文件的工具。

## 协议

地址 `/mcp`，使用 `Authorization: Bearer <访问密钥>` 鉴权。支持 `initialize`、`ping`、`tools/list`、`tools/call`，以 JSON 返回结果。客户端须保存初始化响应中的 `Mcp-Session-Id`，并在后续请求中携带该请求头；旧文档的会话不能访问新文档。支持取消请求和通过 HTTP DELETE 断开客户端。只读配置不会公布或执行编辑工具，不提供 SSE 推送。
