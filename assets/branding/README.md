# Open Office 青牛图标

使用用户指定的 [b14f 应用目录](https://apps.b14f.com/#/) 中，属于 Open Office 的青绿色生肖牛图案。原始画稿来自该页面实际使用的 [open-family.png](https://apps.b14f.com/showcase/open-family.png)，于 2026-10-17 获取，保留在 `open-family-source.png`，未经重绘或替换。

- 原图尺寸：1918 × 820 像素。
- 原图 SHA-256：`90e609e33185119f1418327f11c5afc0431a3c6f95f187d31a261615728728f0`。
- 图块区域：左侧青牛圆角底板，`x=142, y=151, width=390, height=396`。保留黑色和米白色雕刻纹理、青绿色底板和原始比例。
- 导出时通过 SVG 视口选取该图块，并将图块外的目录背景裁为透明。图标不包含名称文字或其他图案。

重新生成资源：

```sh
node scripts/build-brand-icon.mjs
```

该命令仅调用已安装的 Tauri 图标转换工具，不构建应用。它生成顶部品牌图 `public/brand-mark.png`、浏览器图标 `public/favicon.png`，以及 `src-tauri/icons/` 中配置使用的 PNG、ICO、ICNS 资源。源文件校验失败时会停止，防止意外换用其他图案。

这里的画稿是用户指定使用的外部品牌资源，来源如上，不因存放于本仓库而重新授予许可证。
