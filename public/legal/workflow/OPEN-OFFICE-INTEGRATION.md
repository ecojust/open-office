# 画布与代码图表来源和集成

来源：<https://github.com/ecojust/open-workflow>，固定提交 `110b86d81de3e74787ef1a34a25ecbfe50a9d2d7`。版权属于原作者，MIT 许可原文保留在同目录 `LICENSE`，本应用不声称这些模块全部原创。

本地集成位于 `src/workflow` 和 `src/components/WorkflowEditor.vue`：保留图形几何、画笔、格式读写、代码解析及 SVG 渲染，将两种编辑器直接接入 Open Office 的文件操作、多标签、保存保护及统一主题。新增会话、保存回执、草稿隔离和删除确认；未包含来源应用的独立文件外壳、存储或 Server 功能。

`.owflow` 的 `open-workflow` 格式标记以及既有类型标记保留以兼容原文件。XML、白板 JSON 和代码图表文件的格式标记、扩展名同样仅用于互操作。fflate 用于兼容 XML 中的压缩页面；许可见 `../npm/fflate@0.8.2/LICENSE`。
