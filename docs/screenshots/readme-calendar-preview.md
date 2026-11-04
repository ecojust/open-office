# README 日历便笺开发版预览图来源

- 生成日期：2026-11-04；主页为 09:47 UTC（北京时间 17:47），日历工时胶囊图为 10:00 UTC（北京时间 18:00）。
- 开发分支：`feat/calendar-notes`。两张图片分别记录当时的实际开发界面，不是同一次构建的截图。
- 主页基础提交：[`7176f795b871438281820284283d1d14aa15a6da`](https://github.com/ecojust/open-office/commit/7176f795b871438281820284283d1d14aa15a6da)，拍摄时包含尚未提交的九工具主页改动。
- 日历图基础为本地提交 `f31b274d36ef75c768a1702a3d4807c5588c723c`，另包含其后尚未提交的同日工时分配改动。完整截图源码状态由下方各自文件 SHA-256 记录；本地提交不表示已上传或发布。
- 版本说明：开发分支尚未升级版本号，所以主页仍显示 `0.23.1`；这些图不表示已发布的 0.23.1 含有日历便笺或工时胶囊。
- 运行环境：本地 Vite 独立端口，在 Chromium 154.0.8037.57 中运行实际 Vue 工作台和日历组件。未复制或重建 WASM；拍摄脚本未注入或修改界面 DOM/CSS。
- 画面规格：1600 × 1050、浅色主题、中文界面，原始 PNG 截图；未拼接、重绘或后期修改，不是原生安装包截图。
- 示例资料：导入虚构的[城市书房十一月日历本](calendar-notes-example.oocalendar)，包含 2026 年 11 月的 27 条事项、6 类历史事项。25 条工作事项分布在 19 个日期，按每天 7 小时合计 133 小时；另有 2 条年假，不占工时。11 月 4 日的两项为 30%／70%，11 月 6 日的三项为 50%／30%／20%，11 月 25 日的两项为 3／4 小时（百分比分别约为 42.86%／57.14%）。
- 节假日资料：使用本次工作中实际下载的 [holiday-cn 2026 年数据](https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json)，让浏览器请求返回该次下载的相同字节；不是虚构假日或测试占位返回。农历、节气由当前应用的 lunar-typescript 1.8.6 本地计算。
- 截图用途：展示实际界面与示例内容；不替代完整功能测试或各平台原生安装包验收。

| 画面 | 内容 |
| --- | --- |
| [home-calendar-preview.png](home-calendar-preview.png) | 九种创作工具入口，3 × 3 排列，包括日历便笺 |
| [calendar-notes-preview.png](calendar-notes-preview.png) | 2026 年 11 月月历、同日工时胶囊、独立年假事项、农历节气及实际天数／小时／占比 |

## 图像和资料校验

| 文件／资料 | SHA-256 |
| --- | --- |
| `home-calendar-preview.png` | `c655e4a0dc902094c53b07bc314b5be437931f2648202d1ecb8ce1419dcb613f` |
| `calendar-notes-preview.png` | `fc77eb8b396d061e89c5d9031375144e7f3d08ba236e4f69b062b8f11dec6198` |
| `calendar-notes-example.oocalendar` | `978fbda4512b7a9514e969c80db4bbc3678dbb0b7a797e9defec6a6b7d3eb44f` |
| 实际下载的 holiday-cn `2026.json` | `0dcfd8004351e132ce15e8444de4df123265b3f490f7e2f8346631122cb5b709` |

## 主页拍摄时的相关源码

保留 09:47 主页拍摄时的原记录，不用后续日历实现的 SHA 替换。该次拍摄前后下列文件校验一致。

| 文件 | SHA-256 |
| --- | --- |
| `src/App.vue` | `03df5dfb8c32bf32a94651413488d4187964e1dfd8050b6306d3ebaa67271679` |
| `src/style.css` | `0d9133038683ea066b545241e1e69da18a32338d05a8b6897cefa9099cd5bb54` |
| `src/components/CalendarEditor.vue` | `d5395f0945bd2f0003d18eb082d22a15e08f7b78637ad38cac182d3fff47da97` |
| `src/calendar/model.ts` | `6d6da8cf439b06a56bedc797638c5ea6f4b948272866ad2e464dd1bff685ed4b` |
| `src/calendar/session.ts` | `ef2c06ac36687733a7f770b24bef80273cbfc3435263b8e4810e453290463bfc` |
| `src/calendar/calendar.ts` | `c28c14cdc0e6c15a2df3649d9335228d0ab1858b6a0cfa8f98cee9b00bef7720` |
| `src/calendar/almanac.ts` | `2a3fc9563ab34f9c5cc746fbc35d0c89725fc50f5b96ec5245ff4c51efc6b5d2` |
| `src/shared/document.ts` | `996fbb1d28f0d53d0ac7c25ef345a47b1bd6c3a19752e6632b01fcae556697f3` |
| `src/schedule/holidays.ts` | `643398ea044d6fcb8c1c5b4fab9b2906acb5c9c23cb4cde1a9d9ecb722d944fe` |
| `src/schedule/holiday-native.ts` | `cd086b8c90040e052f0d62bc74246d87e5048247048b2e03b2e8183c6a929aa6` |
| `package-lock.json` | `fd90561c3eb8ed085c236fe4b69a657d40a2bcafbad9eb21596384576672aafb` |

## 日历工时胶囊拍摄时的相关源码

记录 10:00 新日历图实际使用的源码，包括新增分配模型和胶囊组件。该次拍摄前后下列文件校验一致。

| 文件 | SHA-256 |
| --- | --- |
| `src/App.vue` | `03df5dfb8c32bf32a94651413488d4187964e1dfd8050b6306d3ebaa67271679` |
| `src/style.css` | `0d9133038683ea066b545241e1e69da18a32338d05a8b6897cefa9099cd5bb54` |
| `src/components/CalendarEditor.vue` | `6ff502e1050985da11c31319af10f563dade06d82d80ee7f9bcdef5ecca03378` |
| `src/calendar/model.ts` | `ea7b8a0d30c7a399c29ba76af5f37d04815bcc721b52ffafc8f43f80f5b63923` |
| `src/calendar/session.ts` | `df4e956f7cc1b9e63e6741ac66b4fede9a0274d05d3e4de902c440b71dca9f42` |
| `src/calendar/calendar.ts` | `96b8d39a825cdf58d8bd09617fdeba181c956545dd38f4d7bc4442f8da005305` |
| `src/calendar/almanac.ts` | `2a3fc9563ab34f9c5cc746fbc35d0c89725fc50f5b96ec5245ff4c51efc6b5d2` |
| `src/calendar/allocation.ts` | `0c6282664fa613cb1edd6a8952294da719353fc6b8fe035260f050ae83620f59` |
| `src/calendar/components/CalendarWorkCapsule.vue` | `8890a764755019362482c9441767a8f8b0c84b820dbfcecebc195474e55ed5a4` |
| `src/shared/document.ts` | `996fbb1d28f0d53d0ac7c25ef345a47b1bd6c3a19752e6632b01fcae556697f3` |
| `src/schedule/holidays.ts` | `643398ea044d6fcb8c1c5b4fab9b2906acb5c9c23cb4cde1a9d9ecb722d944fe` |
| `src/schedule/holiday-native.ts` | `cd086b8c90040e052f0d62bc74246d87e5048247048b2e03b2e8183c6a929aa6` |
| `package-lock.json` | `fd90561c3eb8ed085c236fe4b69a657d40a2bcafbad9eb21596384576672aafb` |

## 复现内容

在对应源码状态运行 Vue 工作台，选择浅色主题，以 1600 × 1050 窗口拍摄主页。日历图通过「打开」导入同目录的 `calendar-notes-example.oocalendar`，切换到 2026 年 11 月，选择 11 月 4 日，使用「百分比」显示并等待农历、节假日信息加载后拍摄。示例日历本使用正式文件格式，包含保存的工时设置和比例，不含验收用脚本或 HTML 测试内容。

文字、表格、演示、PDF、笔记、画布、代码图表与排期的旧预览仍来自 0.23.0，来源和校验保留在 [readme-0.23.0.md](readme-0.23.0.md)。
