# 离线 Office 导入与反复保存测试语料

这组语料供真实内置办公引擎导入、编辑、保存、重新打开测试使用。它不是 Microsoft Office / WPS 的兼容认证，也不是“导入成功即完全保真”的证明。

当前包含 **23 个独立源样例**，总文档大小 **1,123,164 bytes**：13 个原创生成场景、7 个来自 Apache POI、2 个来自 ONLYOFFICE 官方模板仓库和 1 个来自 Apache Tika 的固定版本上游样例。涵盖 DOC、DOCX、ODT、RTF、XLS、XLSX、ODS、PPT、PPTX、ODP。将同一源文件另存成另一格式不另计来源或样例数。

## 来源与许可证

- `fixtures/generated/`：本项目原创测试内容，遵循项目 MIT 许可证。生成器使用 python-docx、XlsxWriter、python-pptx、Pillow 和公开的 OOXML / ODF / RTF 格式结构；**不是 Microsoft Office、WPS、LibreOffice 或 ONLYOFFICE 实际作者会话输出**。图片为代码绘制的原创流程图，音频为数学合成的一秒纯音，无第三方设计资产。
- `fixtures/upstream/apache-poi/`：从 Apache POI 官方源码仓库 `test-data/` 原样复制，固定提交 `f3688f45b0de8934fb32736ba14efc5bbca4a580`。保留完整上游 [LICENSE](fixtures/upstream/apache-poi/LICENSE) 与 [NOTICE](fixtures/upstream/apache-poi/NOTICE)，不得误套项目 MIT 许可证。每件文件的固定下载 URL、SHA-256、字节数及文档声明的 producer 均在 [manifest.json](manifest.json) 中。
- `fixtures/upstream/onlyoffice-document-templates/`：从 ONLYOFFICE 官方 `document-templates` 仓库 `sample-mobile/` 原样复制，固定提交 `0a52fb76fa53fddf7d70da28878537cde3d29421`。保留完整 [Apache-2.0 LICENSE](fixtures/upstream/onlyoffice-document-templates/LICENSE) 和 [上游 README](fixtures/upstream/onlyoffice-document-templates/UPSTREAM-README.md)。仓库说明这些文件用于 ONLYOFFICE Documents for Android；两件文档的应用元数据均声明 `ONLYOFFICE/9.4.0.129`。未见根目录另列 NOTICE。
- `fixtures/upstream/apache-tika/`：来自 Apache Tika 固定提交 `7cb848a1ac9c3374ebaa909225ba2185a54ae074` 的 `testWPSAttachment.docx`，保留完整 [LICENSE.txt](fixtures/upstream/apache-tika/LICENSE.txt) 和 [NOTICE.txt](fixtures/upstream/apache-tika/NOTICE.txt)。应用元数据声明 WPS Office 11.1.0.10700；这是含 9 个 OLE 附件及 9 张预览图、没有正文文字的回归样例。只检查容器结构与保存后保留情况，**不运行或激活嵌入附件**。
- `producerDeclared` 只描述文件元数据中的应用程序名称。本次没有在原 Microsoft Office 或 LibreOffice 应用中观察作者保存，因此不得将其提升为已独立验证的来源或往返兼容性。
- 本轮 WPS 覆盖限于附件容器，未覆盖 WPS 复杂正文或电子表格、演示文稿。ONLYOFFICE 与 WPS 文件均须实际内核测试；来源与元数据声明不是跨应用往返兼容性的证明。
- `reproducibleTimestamp` 是固定的文档属性与 ZIP 时间，**不是实际生成日期**。第三方库版本、内嵌文件实现变化仍可能改变重建字节；当前语料由 manifest 的精确 SHA-256 锁定。

## 场景清单

| ID | 格式 | 核心覆盖 |
|---|---|---|
| `writer-rich` | DOCX | 中英文、标题与编号、合并表格、图片、页眉页脚、页码、超链接、分页 |
| `writer-long-report` | DOCX | 20 个显式新页分节、横竖页面混排、20 张表、分节页眉、重复图片；实际渲染页数须由 PDF 测量 |
| `writer-review-footnotes` | DOCX | 批注、插入与删除修订、脚注、嵌套与合并表格、图片 |
| `writer-unicode-tables` | RTF | Unicode 中英文、表格、页眉页脚、嵌入 PNG、字体颜色、分页 |
| `writer-original-odf` | ODT | 独立 ODF 结构、表格、图片、脚注、链接、页眉页脚、分页 |
| `calc-rich` | XLSX | 3 表、跨表公式与缓存、合并单元格、图表、命名范围、批注、验证、条件格式、隐藏表、图片、冻结、筛选、文本型公式 |
| `calc-2000-rows` | XLSX | 2000 行业务数据、4000 行内公式与 2 个汇总公式、跨表税率、4 表、数据表、图表、命名范围、打印重复表头 |
| `calc-dates-validation` | XLSX | 1904 日期系统、闰日、布尔值、前导零、文本型等号、验证列表、图标条件格式、隐藏行列、veryHidden 表 |
| `calc-original-odf` | ODS | 独立 ODF 结构、双表、跨表 SUM、缓存结果、命名范围、前导零文本 |
| `presentation-rich` | PPTX | 3 个布局、可编辑表格与图表、图片、链接、图形、讲者备注 |
| `presentation-20-slides` | PPTX | 20 页、4 个布局、5 张表、5 张图、10 个图片引用、20 份备注、2 个隐藏页 |
| `presentation-effects-media` | PPTX | 可编辑形状、淡入对象动画、淡化切换、定时推进、原创嵌入 WAV 切换声音、备注 |
| `presentation-original-odf` | ODP | 独立 ODF 结构、3 页、表格、图片、可编辑形状、备注、链接 |
| `poi-word-page-headers` | DOC | 声明 Microsoft Office Word；旧二进制格式、奇偶页页眉与多栏页脚 |
| `poi-word-footnotes` | DOCX | 声明 Microsoft Office Word；真实上游脚注与尾注部分 |
| `poi-excel-drawing-comments` | XLS | 声明 Microsoft Excel；旧二进制格式、绘图、批注、多表 |
| `poi-excel-pivots` | XLSX | 声明 Microsoft Excel；两张透视表及缓存、数据表、日期格式、3 表 |
| `poi-libreoffice-ods` | ODS | 声明 LibreOffice 4.2.8.2 Linux；多表、字体颜色、公式、实际 ODF 应用配置 |
| `poi-powerpoint-table` | PPT | 声明 Microsoft Office PowerPoint；旧二进制格式、表格图形 |
| `poi-powerpoint-smartart` | PPTX | 声明 Microsoft Macintosh PowerPoint；SmartArt、主题、渐变、透明度、图片填充 |
| `onlyoffice-mobile-word` | DOCX | 官方 ONLYOFFICE 移动端样例；声明 9.4.0.129，4 张表、7 张图、1 张可编辑图表、1 条批注、丰富布局 |
| `onlyoffice-mobile-sheet` | XLSX | 官方 ONLYOFFICE 移动端样例；声明 9.4.0.129，339 单元格、28 公式、43 合并区域、3 图表、4 图片、数据表及条件格式 |
| `tika-wps-attachments` | DOCX | Apache Tika 原样回归样例；声明 WPS Office 11.1.0.10700，9 个 OLE 附件及 9 张预览图，无正文，不执行附件 |

媒体和动画样例用于检测实际保存与播放能力，包含这些结构不等于产品已经完整支持播放。旧格式 DOC/XLS/PPT 的源解析覆盖也不同于现代 XML 格式，必须分别报告。

## 清单合同

`manifest.json` 使用 `schemaVersion: 1`。每件样例的 `path` 相对本目录，`kind` 是 `word`、`sheet` 或 `presentation`。`features` 是输入中存在的特性描述，**不是测试通过列表**。

`assertions` 是独立源检查已验证的最小语义基线：

- `textIncludes`：必须保留的文本片段。
- `minimumFeatures`：最少表格、图片、图表、链接、批注等数量；统计口径由独立解析器定义，例如同一图片的多个引用可能只有一个图片部件。
- `sheetNames` / `sheetCells`：表名及选定单元格的类型、数值、原生公式。ODF 与 OOXML 的公式语法不同，不以字符串不相同直接断言数学不等价。
- `slideCount`：演示页数，包含隐藏页。

这些基线故意不把所有复杂特性简化成一项真假值。须同时查看独立检查报告中的修订、脚注、备注、动画、媒体、隐藏状态、图表/透视表部件和特性变化。文本存在与对象数量正常，也不能证明排版、字体、图形外观或公式计算百分之百保真。

本轮 corpus 静态核验：23 个文件的哈希与字节数均匹配；20 个受支持源格式的全部 manifest 断言通过独立解析器；3 个 OLE 旧格式明确标为 `unsupported`，保留基于源二进制记录、文档属性及 XLS 实际单元格读取得到的有限预期。**这是语料有效性核验，不是办公引擎兼容性结果。** 实际引擎运行报告应另行读取。

## 使用

在项目根目录执行：

```sh
# 在开发用 Python 环境中安装语料工具依赖；不会加入应用安装包。
python3 -m pip install -r tests/compatibility/requirements-generator.txt

# 只验证当前 23 件源文件，不重写。
python3 tests/compatibility/generate-fixtures.py --check

# 补齐缺失生成样例，保留已有语料和哈希。
python3 tests/compatibility/generate-fixtures.py --preserve-existing

# 主动重建全部 13 个生成样例并更新其清单；不重写上游样例。
# 不要在兼容测试正在读取语料时运行。
python3 tests/compatibility/generate-fixtures.py

# 独立解析单件文档，不启动办公引擎、不加载外部链接。
python3 tests/compatibility/inspect-output.py tests/compatibility/fixtures/generated/writer-rich.docx

# 真实 Vue / 内置 WASM 导入、修改、现代格式及 ODF 各 3 次保存重开。
COMPAT_RUN=my-new-run PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/compatibility/run.cjs
```

生成时使用：python-docx 1.2.0、XlsxWriter 3.2.9、python-pptx 1.0.2、Pillow 12.3.0、lxml 6.1.1。未安装或调用 Microsoft Office，不要求外部文档服务。

生成样例的外链指向保留域 `example.invalid`，只用于测试链接结构；测试不应联网拉取链接内容。上游文件也作为不可信输入处理，导入保持禁用宏与外链自动更新。不要为兼容性数字而降低这些约束。

可通过 `COMPAT_CASES` 选择逗号分隔的样例 ID、`COMPAT_RUN` 指定独立结果目录。反复测试产生的输出和截图属于运行产物，不能覆盖这里的源文件。若源断言失败，应先修复语料或解析器并明确记录，再评价产品；不能把测试错误算成产品兼容性失败，也不能删掉真实丢失特性使报告变绿。

## 官方桌面编辑器对照（可选）

`onlyoffice-desktop.mjs` 在 Linux 的独立显示器上运行另行安装的官方 Desktop Editors，分别打开固定源文件、当前应用三轮保存后的文件、当前应用修改后的文件。它检查官方编辑器实际加载的页数和画布，保留真实截图供人工评估。源文件复制到测试目录后打开，不覆盖语料，也不把外部软件打包进产品。

先启动开发服务，再生成本轮导出物：

```sh
PRESENTATION_COMPLEX_CASES=poi-smartart-default-list,poi-smartart-alternating-hexagons,poi-smartart-venn \
  npm run test:browser:ppt-complex

# DISPLAY 需事先指向隔离的 X / Xvfb 显示器。
ONLYOFFICE_BINARY=/absolute/path/to/desktopeditors/DesktopEditors \
ONLYOFFICE_DISPLAY=:105 \
  npm run test:compatibility:onlyoffice
```

默认测试上面三份 SmartArt。`ONLYOFFICE_CASES` 可选择复杂专项清单中的其他 ID；对应导出文件必须先生成。`ONLYOFFICE_EXPORTS` 可指定复杂专项输出目录，`ONLYOFFICE_OUTPUT` 可指定本次官方对照记录目录，`ONLYOFFICE_DEBUG_PORT` 可覆盖默认本机调试端口 9232。调试端口已被占用时测试会拒绝启动，不连接或关闭现有应用。

`ONLYOFFICE_VARIANTS` 默认是 `original,noop,edited`，分别对应原件、`noop-3.pptx` 与 `edited.pptx`。也可指定如 `format-color,format-size`，读取每个样例输出目录下的同名 PPTX，以验证实际格式修改后的文件。

测试命令仅管理自己启动的进程组。`report.json` 记录文件指纹、页数、画布及截图；自动断言通过只说明这些检查成立，不代表逐像素一致，也不代表动画播放或任意复杂文档无损兼容。此入口不替代 Windows/macOS 安装包验证。

## 补充排版样例

新增独立语料与回读脚本见 [presentation-typography](presentation-typography/README.md)。官方桌面测试支持 `ONLYOFFICE_MANIFEST` 指定该语料清单，以及 `ONLYOFFICE_CAPTURE_ALL_SLIDES=1` 逐页截图；默认行为仍使用原复杂文档语料和第一页截图。

### SmartArt 节点编辑与双向读回

启动开发服务后运行 `node tests/browser/smartart-text.cjs` 和 `node tests/browser/smartart-text-ui.cjs`。专项用固定节点 ID 独立读取数据与缓存，不以生产映射器作为唯一判定。设置 `SMARTART_TEXT_OUTPUT` 可隔离输出。

生产构建后用 `npm run preview` 启动 4198，再运行 `node tests/browser/smartart-production.cjs`。此检查不使用开发模块或 Vue 内部接口。

官方桌面重开可设置 `ONLYOFFICE_EXPORTS=test-results/smartart-text`、`ONLYOFFICE_VARIANTS=edited,edited-cycle-3`，其余安装和显示环境要求同上。双向编辑必须先在隔离的官方程序中真实修改并保存，再运行 `SMARTART_NATIVE_RETURN=/absolute/path/native-bidirectional-return.pptx node tests/browser/smartart-native-return.cjs`；此场景固定检查先前本应用改成 Plan Q4、后由参考软件普通输入改成 Native Q4 的 Venn 节点。

本轮证据及支持范围见 [节点编辑说明](../../docs/smartart-text-editing.md)。

父子图示关联专项：`node tests/browser/smartart-child-text.cjs`。它用固定 GUID 核对父节点不变，覆盖隐式/显式父连接、空子节点、同文父子及异常关系。生产页面可用 `SMARTART_PRODUCTION_CHILD=1 node tests/browser/smartart-production.cjs` 检查同一子节点入口。

### 局部文字格式

开发服务启动后运行 `node tests/browser/presentation-range-format.cjs`。它从固定排版语料派生测试副本，独立按 UTF-16 字符核对原生 run 属性、段落不变量与包部件，检查三次保存重开、操作顺序、撤销和异常拒绝。输出为 `test-results/presentation-range-format/`。

生产构建后启动 `npm run preview`，运行 `node tests/browser/presentation-range-ui.cjs`。这条测试通过真实界面选择文字、修改六种格式、撤销重做和下载重开，不调用开发模块或组件内部接口。`PRESENTATION_URL` 可选择服务地址，`PRESENTATION_RANGE_UI_OUTPUT` 可隔离输出目录。支持范围见[局部格式说明](../../docs/presentation-range-format.md)。
