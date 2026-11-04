# README 日历便笺开发版预览图来源

- 生成日期：2026-11-04；日历图为 09:45 UTC（北京时间 17:45），主页在实际三列布局调整后于 09:47 UTC（北京时间 17:47）重拍。
- 开发分支：`feat/calendar-notes`，截图包含当时尚未提交的日历集成改动。
- 基础提交：[`7176f795b871438281820284283d1d14aa15a6da`](https://github.com/ecojust/open-office/commit/7176f795b871438281820284283d1d14aa15a6da)。该提交是开发起点，完整截图源码状态由下方相关文件 SHA-256 记录。
- 版本说明：开发分支尚未升级版本号，所以主页仍显示 `0.23.1`；这些图展示当前开发界面，不表示已发布的 0.23.1 含有日历便笺。
- 运行环境：本地 Vite 独立端口，在 Chromium 154.0.8037.57 中运行实际 Vue 工作台和日历组件。未复制或重建 WASM；拍摄脚本未注入或修改界面 DOM/CSS，主页使用本分支实际的三列布局。
- 画面规格：1600 × 1050、浅色主题、中文界面，原始 PNG 截图；未拼接、重绘或后期修改，不是原生安装包截图。
- 示例资料：导入虚构的[城市书房十一月日历本](calendar-notes-example.oocalendar)，包含 2026 年 11 月的 22 条事项、6 类历史事项。5 类工作事项分布在 19 个日期，共计 19 天；另有 2 条年假。同一天两条工作事项各计 0.5 天。
- 节假日资料：先实际下载 [holiday-cn 2026 年数据](https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json)，再让浏览器请求使用该次下载的相同字节；不是虚构假日或测试占位返回。农历、节气由当前应用的 lunar-typescript 1.8.6 本地计算。
- 截图用途：展示实际界面与示例内容；不替代完整功能测试或各平台原生安装包验收。

| 画面 | 内容 |
| --- | --- |
| [home-calendar-preview.png](home-calendar-preview.png) | 九种创作工具入口，3 × 3 排列，包括日历便笺 |
| [calendar-notes-preview.png](calendar-notes-preview.png) | 2026 年 11 月月历、工作与年假事项、农历节气及工作天数占比 |

## 图像和资料校验

| 文件／资料 | SHA-256 |
| --- | --- |
| `home-calendar-preview.png` | `c655e4a0dc902094c53b07bc314b5be437931f2648202d1ecb8ce1419dcb613f` |
| `calendar-notes-preview.png` | `7cae6a26bdf609ec4ca827c15897eaac9b6ff0d1324cedaa20610f681e82a66d` |
| `calendar-notes-example.oocalendar` | `d53b26990480250eeeded82f7e4264a436c58360fce304c6938923e648d2f93b` |
| 实际下载的 holiday-cn `2026.json` | `0dcfd8004351e132ce15e8444de4df123265b3f490f7e2f8346631122cb5b709` |

## 拍摄时的相关源码

两次拍摄各自开始与结束时的源码校验一致。日历原图保留 09:45 的实际源码记录；主页重拍时已包含三列卡片布局和日历右键菜单焦点修复，不能以新 SHA 替代旧图的源码。文档和截图本身不包含在这个源码列表中。

两次拍摄之间发生变化的文件：

| 文件 | 日历图 09:45 SHA-256 | 主页图 09:47 SHA-256 |
| --- | --- | --- |
| `src/style.css` | `a6345ee92168a99da3467d2b8a63e7287756cc4479ebb6260b1f1e929a7caf5f` | `0d9133038683ea066b545241e1e69da18a32338d05a8b6897cefa9099cd5bb54` |
| `src/components/CalendarEditor.vue` | `a5d652659141e4d70a16886a5bc868111464a644d667b215d2b7decbf01c2e45` | `d5395f0945bd2f0003d18eb082d22a15e08f7b78637ad38cac182d3fff47da97` |

两次拍摄一致的相关文件：

| 文件 | SHA-256 |
| --- | --- |
| `src/App.vue` | `03df5dfb8c32bf32a94651413488d4187964e1dfd8050b6306d3ebaa67271679` |
| `src/calendar/model.ts` | `6d6da8cf439b06a56bedc797638c5ea6f4b948272866ad2e464dd1bff685ed4b` |
| `src/calendar/session.ts` | `ef2c06ac36687733a7f770b24bef80273cbfc3435263b8e4810e453290463bfc` |
| `src/calendar/calendar.ts` | `c28c14cdc0e6c15a2df3649d9335228d0ab1858b6a0cfa8f98cee9b00bef7720` |
| `src/calendar/almanac.ts` | `2a3fc9563ab34f9c5cc746fbc35d0c89725fc50f5b96ec5245ff4c51efc6b5d2` |
| `src/shared/document.ts` | `996fbb1d28f0d53d0ac7c25ef345a47b1bd6c3a19752e6632b01fcae556697f3` |
| `src/schedule/holidays.ts` | `643398ea044d6fcb8c1c5b4fab9b2906acb5c9c23cb4cde1a9d9ecb722d944fe` |
| `src/schedule/holiday-native.ts` | `cd086b8c90040e052f0d62bc74246d87e5048247048b2e03b2e8183c6a929aa6` |
| `package-lock.json` | `fd90561c3eb8ed085c236fe4b69a657d40a2bcafbad9eb21596384576672aafb` |

## 复现内容

在上述源码状态运行 Vue 工作台，选择浅色主题，以 1600 × 1050 窗口拍摄主页。通过「打开」导入同目录的 `calendar-notes-example.oocalendar`，切换到 2026 年 11 月，选择 11 月 4 日，等待农历和节假日信息加载后拍摄。示例日历本使用正式文件格式，不含验收用脚本或 HTML 测试内容。

文字、表格、演示、PDF、笔记、画布、代码图表与排期的旧预览仍来自 0.23.0，来源和校验保留在 [readme-0.23.0.md](readme-0.23.0.md)。
