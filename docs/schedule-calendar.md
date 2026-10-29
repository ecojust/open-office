# 排期日期与文件格式

排期文件使用 `.ooschedule` 扩展名，内容是 UTF-8 JSON，`format` 为 `open-office-schedule`，`version` 为 `1`。项目、角色、事件的标识必须唯一。项目包含真实的 `startDate` / `endDate`，角色数组 `roles` 和事件数组 `events`；所有日期均为 `YYYY-MM-DD`，包含开始和结束当天。`roleId: null` 表示整体计划轨道。事件高度 `height` 为 `1` 或 `0.5`：全天高度 `1` 只允许 `slot: 0`，半高 `0.5` 的 `slot: 0` 表示上午、`slot: 1` 表示下午。同角色同一天仍只允许一个事件，不因时段不同而允许重叠；跨天事件的时段标记适用于整块事件。

旧排期的 `slot: 0` 数据可以直接读取；0.20.0 会拒绝读取包含下午 `slot: 1` 的文件，需使用支持时段的新版本。Ctrl＋滚轮缩放只改变当前视图的日期列宽，不写入事件或修改脏态。

可选的 `layout.trackHeights` 保存轨道高度：键为 `overall`、`person-<角色 id>` 或 `event-<事件 id>`，值为 84–336 范围内的 28 整数倍（像素），未指定时使用 112。删除角色或事件时同步清除对应高度。旧文件无需补充该字段；旧版应用会忽略这一可选显示设置，重新保存可能丢失自定义轨道高度，项目和事件字段保持兼容。

JSON 数据导出与 `.ooschedule` 使用相同内容格式，可无损导入当前版本；它是独立副本，不更新原文件的保存状态。PNG 导出使用同一套日期投影、行顺序和轨道高度，绘制完整当前视图，自动假日缓存仍独立于项目文件。

文件上限 4 MiB，最多 100 个角色、2000 个事件，项目最多 1096 天（3 年）。日期支持 1900–9999 年；不接受不存在的日期。事件必须处于项目日期范围内；缩短项目范围、删除仍被引用的角色和产生重叠的编辑都会被拒绝，原模型与历史保持不变。不同角色可以在同一天安排事件。

新项目的角色与事件为空，范围从本机今天所在周的周一到 8 周后的周五。先读取本机日历日期，再用 UTC 整数天进行运算，避免浏览器时区与夏令时让日期偏移。日期和事件的存储不依赖可见列序号。

可选的 `calendar.weekNumbering` 支持 `"year"`（按年）和 `"project"`（按项目），缺省为 `"year"`。两种模式均从周一开周，不改变日期投影或事件字段。设置随文件和 JSON 保存，纳入撤销／重做；旧版应用忽略这一可选字段并使用其原有的项目周号，重新保存可能丢失所选模式。

- `year`：按全年 ISO 8601 周历计算，包含 1 月 4 日的周为 W1，不以项目开始日期重新计数。标题包含 ISO 周所属年份，跨年年号可能不同于日期年号，例如 2027-01-01 属于 2026 年 W53，而 2027-01-04 属于 2027 年 W1。
- `project`：项目开始日期所在周为 W1，按实际经过周数递增，跨年不重置。修改项目开始日期会重算项目周号；即使开始日期隐藏或位于周中，也按其所在周的周一作为编号起点。

隐藏的整周仍占周序号。例如项目从 2026-02-09 开始，春节期间整周隐藏：按年显示 W7、W9；按项目显示 W1、W3。PNG 使用当前所选模式，项目周号不标成年度周号。

周末与假日默认隐藏；取消隐藏只改变投影。拖动按可见日期整天吸附，移动保留可见天数，跨角色但未横向移动时保留原始起止日期；拉伸至少保留一个可见日期，边界限制在项目范围内。真实起止日期可以跨越多个隐藏日期，隐藏日期仍参与同角色事件碰撞判断。完全落在隐藏日期中的事件仍保留在文件中，可通过日期编辑或显示隐藏日期继续调整。

`calendar.extraHolidays` 添加假日，`calendar.excludedHolidays` 将某日从官方假日中排除；同一天不能出现在两组内。两组可保留项目范围外的有效日期，便于之后扩大范围。取消某日的假日身份不会取消周末规则。调休上班的周六、周日默认仍隐藏。

## 自动获取与缓存

按项目日期请求相关年度公告；由于下一年的公告可能包含上一年十二月安排，项目涉及十二月时还会检查下一年度。只允许请求以下固定来源的四位年份 JSON，主源失败后使用备用源：

- `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json`
- `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json`

来源为 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)，按国务院公告整理。JSON 包含 `year`、`papers`、`days[{date,name,isOffDay}]`，其中 `papers` 仅用于验证结构，不会访问其中链接。公告年份与具体日期年份可能不同，按日期合并时较新公告覆盖较早公告。`isOffDay: false` 表示补班，不能当作假日；周末隐藏仍独立生效。

打开项目、修改年份范围、切回项目时检查缓存；当前项目每 24 小时再次检查。有效表缓存 24 小时，失败重试有 5 分钟冷却，手动「更新假日」可立即重试。主源及备用源可能还有自己的 HTTP 缓存，不保证公告发布即刻可见。

按年度持久化最多 12 份已验证缓存，每个来源请求含响应读取最多 5 秒，响应上限 256 KiB，HTTP 并发最多 2。年度数据整体校验后才原子替换；空表、畸形数据或失败响应不覆盖上一份有效数据。存储不可用时仍可使用本次内存数据。尚未取得有效表的年份会提示，并使用已有缓存、内置数据及手动规则，不推测农历假期或尚未取得的官方安排。

浏览器预览使用当前站点的本地存储；桌面版通过专用 IPC 将缓存原子保存到应用数据目录的 `schedule-holidays.json`，避免每次启动的随机本机端口导致缓存失效。桌面缓存接口只接受固定年度键、最多 12 项且总文件不超过 3 MiB，不接受任意路径。磁盘缓存读取或写入失败不会丢弃本次会话已取得的数据。

联网只发送年度 URL，不携带凭据、Referer 或文档内容。桌面端 CSP 仅放行上述两个目录的连接；不添加通用代理或第三方运行时依赖。自动获取不会改写事件或标记文档未保存；拖动中的日期列冻结，新的日历投影延迟到拖动结束后生效。手动新增／排除假日始终优先。

[CalendarNote](https://github.com/ecojust/CalendarNote) 的参考实现使用 `lunar-typescript` 内置 `HolidayUtil` 区分放假和补班，本身不自动下载年度公告。本实现保留类似的自动识别体验，并通过年度数据更新覆盖后续年份，不引入该库。

## 内置中国大陆假日兜底

应用离线内置 2025 和 2026 年国务院公布的放假调休日期。日期均包含首尾：

| 年份 | 放假区间 |
| --- | --- |
| 2025 | 01-01；01-28～02-04；04-04～04-06；05-01～05-05；05-31～06-02；10-01～10-08 |
| 2026 | 01-01～01-03；02-15～02-23；04-04～04-06；05-01～05-05；06-19～06-21；09-25～09-27；10-01～10-07 |

官方来源：

- [国务院办公厅关于2025年部分节假日安排的通知](https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm)，国办发明电〔2024〕12号，2024-11-12。
- [国务院办公厅关于2026年部分节假日安排的通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)，国办发明电〔2025〕7号，2025-11-04。

内置表的交叉核对来源为 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)，固定提交 [dcecbce230a57639cc8967ec9e2465e744880fd8](https://github.com/NateScarlet/holiday-cn/tree/dcecbce230a57639cc8967ec9e2465e744880fd8)。自动获取到有效年度表后优先使用该表；没有有效在线数据或内置表的年份通过 `unknownHolidayYears` 明确返回。来源不可用不代表官方尚未公布。

## holiday-cn 数据许可

MIT License

Copyright (c) 2019 NateScarlet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
