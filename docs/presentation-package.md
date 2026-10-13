# PPTX 包处理接口

`src/presentation/pptx-package.ts` 在浏览器中读取、修改真正的 OOXML ZIP 包。它不启动 Office、不执行宏，也不下载文档里的外部关系。普通幻灯片内容由 UNO 编辑；此模块负责 UNO 可能丢失的转场、媒体和动画 XML，并将这些内容写回实际导出的 PPTX，而不是另存私有配置。

## API

所有页索引从 0 开始，输入为 `Uint8Array | ArrayBuffer`，修改接口返回新的 `Uint8Array`，失败不修改输入。可选 `options.signal` 支持取消；浏览器默认使用 `DOMParser` / `XMLSerializer`，其他环境可通过 `options.xml` 注入符合 DOM 接口的解析器。

```ts
const presentation = await parsePptxPackage(bytes)
const changed = await patchPptxPackage(bytes, {
  slides: [{
    slideIndex: 0,
    transition: {
      type: 'push', direction: 'l', durationMs: 700,
      advanceAfterMs: 5000, advanceOnClick: true,
    },
  }],
})
const named = await patchPptxPageNames(changed, ['开场', '总结'])
const saved = await transplantPresentationFeatures(original, unoExport, [
  { sourceIndex: 1, targetIndex: 0 },
  { sourceIndex: 0, targetIndex: 1 },
])
```

`parsePptxPackage` 返回原始页面顺序、EMU 尺寸，以及每页 `name`（`cSld@name`）、标题、备注、隐藏状态、转场、内嵌媒体和不支持动画标记。`transition.durationMs === null` 表示文件没有明确时长；`speed` 保留原始 slow/med/fast，不把推算时长伪称为原值。未知转场返回 `type: 'unknown', supported: false`。

转场写入支持 `none / fade / push / wipe / cover / uncover / split`。push、wipe 的方向为 `l/r/u/d`；cover、uncover 还支持 `lu/ru/ld/rd`；split 为 `in/out`，另带 `orientation: 'horz' | 'vert'`。none、fade 不接收方向。`advanceAfterMs: null` 关闭自动换页，时间单位均为整数毫秒。

## 内嵌媒体

`PptxPatch.slides[].addMedia` 接收以下对象；`removeMediaIds` 接收同页解析结果中的媒体 `id`。

```ts
{
  kind: 'audio', name: '旁白.wav', mimeType: 'audio/wav',
  data: new Uint8Array(await file.arrayBuffer()),
  rect: { x: 0.05, y: 0.85, width: 0.3, height: 0.1 },
  start: 'click', loop: false,
}
```

位置相对整张幻灯片归一化到 0–1。新增媒体支持 MP3/WAV/OGG、MP4/WebM，会检查扩展 MIME 对应的文件头，并写入实际媒体、预览图片、关系和播放时间树。浏览器能否解码具体编解码器，以及是否允许自动有声播放，仍由运行平台决定。

解析结果包含实际媒体字节、位置、旋转、开始方式与循环标记；不明确的原播放时序返回 `start: 'unknown'`。外部媒体 `external: true, data: null`，不发网络请求。不可靠的组合变换返回 `rect: null` 和警告，不猜测坐标。

## 导出时的保留边界

- 显式映射可应对页面移动、复制、删除；一个源页可对应多个目标页，目标页不能重复。不提供映射时仅接受相同页数并按原顺序对应。
- 映射页的媒体和转场/时间树以源包为准，`none` 或删除也会真实应用。目标普通文字、图片、布局、备注、页名与当前隐藏状态保留。因此应通过本应用的效果面板管理这些效果，避免使用内嵌引擎菜单另加效果后被源包覆盖。
- 原始未知动画、Morph 等 XML 及其关系依赖会保留，但这不表示播放器已实现其视觉效果。普通对象动画的形状编号仅在源和目标都有唯一同名对象时重映射；不能确认时抛出 `ANIMATION_MAPPING`，停止本次保存并提示处理对象名称/原动画。
- 内嵌媒体按唯一形状名称去重，也清除本模块媒体被 UNO 降为普通海报后的对应形状。相同媒体内容可复用，避免反复保存增加相同附件。
- 无关 ZIP 文件项保留原始压缩内容。数字签名包拒绝修改，以免冒充签名仍有效。严格 OOXML 可读取、改页名与删除媒体；新增效果目前要求标准 transitional PPTX。

## 限制与验证

ZIP 输入/输出最多 100 MiB、总展开量 256 MiB、4096 个文件、单 XML 8 MiB、单媒体/文件项 64 MiB、500 页；UI 可采用更严格限额。拒绝路径穿越、重复/大小写歧义路径、符号链接、加密 ZIP、ZIP64、越界数据和 DTD/实体声明；异步解压有 15 秒终止上限。修改完成前不会覆盖原文件。

```sh
node --test --experimental-test-isolation=none tests/pptx-package-safety.test.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/browser/pptx-package.cjs
```

浏览器测试使用真实 XML DOM、异步 ZIP 解压和实际两页 PPTX，覆盖媒体字节、七类转场、页名/备注/顺序、目标隐藏状态保留、未知效果与命名空间、动画编号重映射、重复保存、显式删除、签名与外链拒绝。另已用真实 WASM 编辑器读取补丁后的媒体 PPTX，并成功导出 PPTX/PDF。这些证据不等同于 Microsoft PowerPoint 全格式或所有平台编解码器兼容认证。

fflate 0.8.2 的 MIT 许可原文位于 `public/legal/npm/fflate@0.8.2/LICENSE`，随前端资源一并打包。
