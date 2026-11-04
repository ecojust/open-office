# 日历便笺来源和集成

来源：<https://github.com/ecojust/CalendarNote>，固定提交 `2e8c3f072f304ed1c6624456ff1267c18fed151f`。Copyright (c) 2026 桔子桑，MIT 许可原文逐字保留在同目录 `LICENSE`。本应用保留其来源，不声称日历事项的全部设计与实现均为原创。

本地集成位于 `src/calendar/` 和 `src/components/CalendarEditor.vue`。参考原项目 `src/App.vue`、`src/components/CalendarView.vue`、`src/components/NoteForm.vue`、`src/components/NoteCard.vue` 的月历、事项属性、拖动复制、农历和工作日统计功能，以新的 Vue/CSS 界面与 TypeScript 文档模型接入 Open Office 文件操作、多标签、保存保护、主题、打印、全屏和 MCP。

主要调整：日期单击只选中，通过明确的日期详情入口打开黄历；新建自定义事项可以搜索并复用跨月历史的名称、颜色与是否需要上班，正文保留当前输入；所有月份及历史事项随 `.oocalendar` 文档保存。修改经过可撤销的文档会话，删除和清除当月需要确认。未引入来源应用的独立窗口外壳、壁纸、二维码、品牌图片、FullCalendar、Element Plus 或 SQLite 存储层。

农历、节气与黄历由 `lunar-typescript@1.8.6` 提供，Copyright (c) 2020 6tail，MIT 许可；原文和精确 npm 来源见 [`../npm/lunar-typescript@1.8.6/`](../npm/lunar-typescript@1.8.6/source-manifest.json)。中国大陆法定假日复用 Open Office 的 holiday-cn 年度数据及缓存，其许可见 [`../holiday-cn-LICENSE.txt`](../holiday-cn-LICENSE.txt)。

`.oocalendar` 使用 `open-office-calendar` 格式标记与版本 1，是 Open Office 的文档格式，不声称与原应用 SQLite 数据库直接互通。上游版权、原始许可与免责条款不因集成改名而改变。
