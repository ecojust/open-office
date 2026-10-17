# 内置演示模板

这里的 100 套模板为 Open Office 原创设计，采用项目根目录的 MIT 许可证。
每套包含封面、内容、结尾三页；文字和矢量图形均可编辑，没有外链资源、下载素材或嵌入字体。

运行 `python scripts/generate-presentation-templates.py` 可重新生成全部 PPTX、对应封面 SVG 和 `manifest.json`。需要安装 `python-pptx` 和 `fonttools`。
PPTX 与 SVG 共用同一组绘图指令，确保预览中的内容、配色和布局对应真实封面。现代无衬线文字使用应用已打包的 WenQuanYi Micro Hei；书卷风标题使用 LXGW WenKai。SVG 预览将相同字体的字形转换为路径，不依赖用户系统字体；PPTX 正文始终保留可编辑文字。字体授权说明见 `assets/fonts/ui/` 和 `assets/fonts/deck/`，字形路径依照对应字体许可证使用。
