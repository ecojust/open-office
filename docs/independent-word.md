# 独立文字编辑器

工作台新增“轻量文字文档（预览）”，提供独立的新建和打开 DOCX 入口。现有“文字文档”和普通“打开文件”入口继续使用 LibreOffice / ZetaOffice，保留原有格式支持和成熟编辑能力。

此版本是独立正文模型、输入界面和 DOCX 读写的首个可验证实现，不表示已经重现 LibreOffice Writer 或 Microsoft Word 的全部功能，也不声称复杂文档排版一致。

## 支持范围与使用方式

- 新建基础文字文档，通过独立界面编辑已支持的正文、文字和段落格式，保存为 DOCX。
- 从“打开 DOCX”进入独立编辑器时，先检查文件是否属于已实现的 DOCX 子集。发现未支持的内容或格式时停止打开，不生成可编辑标签，不自动删除或降级这些内容。
- 复杂文档、DOC、RTF 和 ODT 请使用原有文字入口。独立编辑器不提供图片、查找、打印、PDF 或 ODT 导出入口。
- 外部导入的 DOCX 首次保存必须另存副本。桌面版继续使用现有本地文件对话框与保存冲突检查；浏览器版下载文件。
- 保存、撤销、重做、切换标签与未保存修改的关闭确认沿用应用合同。最近文件仍通过原有入口打开；若要使用独立模式，应从轻量文字区域重新选择文件。

当前支持中英文与 emoji、段落与软换行、选区粗体/斜体/单／双下划线、上下标、单／双删除线、标准色高亮、自定义文字背景色、字号/颜色、前三个标题级别、段落对齐和撤销重做。基础 DOCX 可保留中西文字体、语言标记、默认制表位、行距、段落间距、孤行控制、与下段同页和段中不分页设置。分页属性可保存，浏览器连续视图尚不执行 Writer 的分页算法；字体显示仍取决于系统可用字体。

“大小写显示”菜单提供原样、全部大写和小型大写。它保存字符格式，不改写原始文字；取消效果写入显式的原样格式，覆盖继承值。支持 ASCII 字母，以及无大小写映射的中文、标点和 emoji。原生 Writer 与浏览器对 `ß`、部分希腊字母等存在字符映射差异，因此启用效果时暂不接受非 ASCII 大小写字符、组合音标，或特定语言环境中的 ASCII 字母；原样文字仍按原有范围支持。常见 emoji 和汉字的变体选择符继续保留。遇到不支持的组合会拒绝此次导入、格式或输入操作并保留原文。小型大写字形取决于字体与浏览器，不承诺与原生 Writer 的字形比例、行宽和分页一致。

当前暂不支持的语言规则包括土耳其语、阿塞拜疆语、希腊语、立陶宛语和爱尔兰语中的 ASCII 字母大写效果。组合标记的限制也包括键帽 emoji（如 `1️⃣`），普通 emoji、肤色、ZWJ 序列及变体选择符可继续使用。含大小写效果的选区复制、剪切时，纯文本取自原始文稿，并提供带格式的 HTML；不会把显示转换后的字符串当作正文。编辑器粘贴仍采用纯文本。

字体缺少专用小型大写字形时，正文和菜单预览允许浏览器合成小型大写，局部保留在复制的 HTML 中；粗体、斜体的合成设置不变。该显示回退不改变原文，也不承诺与 Writer 的字形缩放比例、字体度量或分页完全一致。

大小写格式按 Writer 的单一属性处理。同一段落或字符样式的继承链采用覆盖；段落与显式命名字符样式同时启用同一种效果时，Writer 会生成直接取消格式，段尾 Enter 后继续保留。不同效果则使用字符样式的值，直接格式最终优先。正文和段落标记分别解析。一个 `rPr` 同时启用两种效果，或将小型大写与明确关闭全部大写混写时，原生结果依赖 XML 顺序，当前拒绝这些歧义组合。

选中文字后，工具栏的上标／下标按钮可切换相应格式，再次点击恢复普通基线。下划线和删除线各有独立菜单，可明确选择无、单线或双线；主按钮用于添加单线或取消现有单／双线。混合选区会显示混合状态，一次操作可整体撤销。两种线型独立绘制并保存，可与上下标叠加。上下标保存原始字号，显示时单独缩小字形，继续输入或保存不会反复缩小字号。

“字距”菜单可设置 −20 至 20 磅的字符间距，按 0.05 磅递增；正值加宽，负值紧缩，“恢复常规”写入显式 0，覆盖继承的间距。混合选区未修改时保留各自的值，应用形成一次可撤销编辑；取消、切换选区或修改文稿会丢弃过期草稿。空段可以设置后续输入的间距。

同一面板的“字偶距”独立设置字体中 AV 等字偶的间距调整。启用与关闭分别写入 `w:kern=2` 和 `w:kern=0`；与字符间距同时修改时，只形成一次可撤销编辑。混合状态未修改时保留各片段的原值，“恢复常规（0 磅）”只清除字符间距。正文、独立段落标记和后续输入分别保留设置。

字偶距显示遵循 Writer 的开关行为：`w:kern` 为 0 时关闭，非零时启用，不根据当前字号判断。原生对照覆盖 8 磅、12 磅与 `w:kern` 的 0、1、2、24、28、800；非零值均启用，原生重存后统一为 2。因此也接受先前保守拒绝的值 1。模型以磅存储数值，DOCX 按半磅单位编码；自身保存往返保留原值，支持 `w:kern` 为 0–800 的整数（模型值 0–400，步长 0.5）。显式命名字符样式中的开关即使与段落相同，也能在段尾 Enter 后继续保留。此处对齐 Writer，不宣称实现 Microsoft Word 的字号阈值规则。

字符水平缩放 `w:w` 仍明确拒绝。Writer 的缩放参与字形宽度与行分割；无宽度变体的字体使用 CSS `font-stretch` 不会获得同样效果，`inline-block` 加 `scaleX` 虽改变绘制宽度，却保留原占位并引入额外换行边界。当前没有用这类近似方式扩大导入范围。有限浏览器探针确认的是排版差异，未发现原文选区损坏，也不将其推断为所有选区行为的保证。

字符间距保存为 `w:rPr/w:spacing`，与 `w:kern` 字偶距阈值、段落间距分别处理。依据 Writer 的整数 twip 计算，负间距的显示下限为实际字形字号的六分之一；上下标先按 58% 缩小字号再计算该下限，正间距保持绝对磅值。例如 12 磅正文的下限为 −2 磅，其上下标为 −1.15 磅。模型与 DOCX 始终保留设定的原值，改变字号后重新计算显示值。当前范围之外、缺少数值和非整数 twip 的输入明确拒绝；没有扩展复杂文字脚本或双向排版支持。浏览器连续视图仍不承诺原生字体度量和分页像素一致。

段落样式、文档默认值、显式命名字符样式和直接格式的间距按来源叠加。命名字符样式的间距即使与当前段落相同，也保留为显式覆盖，段尾 Enter 后不会被后续段落样式替换；普通继承值则随后续样式改变。默认字符样式只在显式引用时生效。段落标记间距与正文分别保留。

下划线支持明确的 `w:u val="single/double/none"` 和不透明 RGB 线条颜色，保留段落、命名字符样式和直接格式的继承与取消。下划线菜单可选择自定义颜色或“跟随文字颜色”，颜色与正文、删除线分别保存；仅修改颜色不会自动开启下划线，取消线条后再次开启仍保留选定颜色。颜色草稿应用后形成一次可撤销编辑，取消或切换选区不应用草稿。

默认字符样式中的下划线只在显式引用时应用；直接下划线在段尾 Enter 后继续保留。导入区分同一 `basedOn` 样式链中的颜色继承与新的字符样式／直接下划线覆盖；线型与颜色作为组合属性保存，防止只改颜色时丢失线型。内部的 `underlineColor: 'auto'` 表示跟随文字，导出时省略 `w:u` 的颜色属性。原始 OOXML `color="auto"` 在受测 Writer 中会变成白色，本轮继续明确拒绝；不能将它等同于省略颜色。主题色、波浪线、仅单词下划线和缺少类型仍拒绝导入。

选中整段正文并只改下划线颜色时，若正文线型一致，段落标记也记录该线型与新颜色，继续输入或换段保持相同效果。该行为经过 Writer 实际下划线菜单命令、保存重开与按键对照。混合线型选区改色时，应用保留各片段原有线型；这是产品自身约定，受测 Writer 在混合线型下会禁用颜色控件，不能将二者称作同一菜单行为。

含独立下划线颜色、双线或下划线／删除线组合的选区，复制和剪切时由编辑器生成带格式的 HTML，保留两层线条，避免浏览器默认复制将其合并。纯文本保留原文；编辑器自身粘贴仍按目标插入格式处理纯文本。窄屏菜单的内容可滚动，“应用颜色”和“取消”固定在面板底部。

高亮菜单提供 DOCX 的 16 种标准颜色和“无高亮”，显示当前颜色或混合状态，支持键盘选择。白色高亮与取消高亮分别保存；取消高亮可显式覆盖段落样式中的颜色。高亮在段中、段尾 Enter 和软换行时继续遵循直接格式与段落继承规则。按实际 Writer 导入行为，命名及默认字符样式里的高亮会被忽略。

“背景色”可设置任意不透明 RGB 文字背景或取消背景，选择颜色后点击“应用背景色”形成一次可撤销的编辑。背景色与高亮独立保存；同时存在时，高亮覆盖背景显示，取消高亮后露出原背景。取消背景色会保留高亮。选区包含不同背景色时显示混合状态，切换选区或修改正文会关闭过期的颜色草稿。

字符底纹支持 `w:shd val="clear"` 与明确的六位 RGB `fill`；`fill="auto"` 表示显式取消，白色与取消分别保留。段落样式的字符背景、命名字符样式与直接格式按层继承；默认字符样式的背景仅在显式 `rStyle` 引用时生效。图案、主题色、缺少填充、`nil` 及整段底纹仍拒绝。LibreOffice 从 ODT 导出的独立段落标记底纹与正文背景分别保留。`docDefaults` 中的底纹也暂时拒绝：原生 LibreOffice 首次打开和重存后的显示存在差异，本轮不将其纳入已验证的兼容范围。

上下标与删除线分别保留继承值和直接覆盖，包括显式 `baseline` 和 `none`。依照 Writer 的换段逻辑，普通正文的直接上下标在段尾 Enter 后清除，恢复继承的值；独立段落标记的上下标格式继续保留。命名字符样式的上下标优先于当前或后续段落样式，并通过 DOCX 字符样式继续保存。段中 Enter 和软换行保留直接上下标。直接删除线不随段尾 Enter 清除。字符缩放及同一格式节点同时启用单／双删除线的歧义输入仍明确拒绝。

自定义基线偏移支持 −100% 至 100% 的整数，0 恢复普通基线。它保持原有字形大小，和自动缩小字形的标准上下标分别处理。当前西文字体限于 Times New Roman、DejaVu Sans、Liberation Serif。纯 ASCII 文字允许保留不同的东亚字体设置；含非 ASCII 文字时，东亚字体须未另行指定或与西文字体相同，其他组合会明确拒绝此次操作。浏览器以固定探针测量字体高度（包含行间留白），字体加载后重新计算；实际字体替换、字形回退和连续视图的行布局仍可能与 Writer 不同。

DOCX 的 `w:position` 使用整数半磅，Writer 内部则按最终字号换算为整数百分比，二者存在取整。例如 12 磅文字上移半磅得到 4%，改成 18 磅后当前仍为 4%，保存重开后可能变为 3%。导入正文非零偏移须能解析出明确字号；非零样式／默认值偏移、超出范围及空文字片段中偏移与脚本／字符样式的复合输入仍拒绝。原始 `position=0` 不会取消继承的上下标；工具栏选择 0 则明确恢复普通基线。

正文偏移和空段输入状态分别处理：实际格式命令设置的偏移可以在本次编辑中继续输入、换段及删除至空段后保留；尚未输入正文的空段保存重开后会恢复，此行为与受测 Writer 一致。导入段落标记上的 `position` 经语法校验后忽略，不能把它当作正文格式。含数字偏移的选区复制时由编辑器生成格式化 HTML，纯文本仍保留原文。

删除带偏移的正文后，当前光标可继续使用正文的偏移、字体和字号，段落标记仍独立保存原来的上标、字号等属性。连续输入不会被旧标记逐字改回；明确的正常基线标记仍会清除偏移。该临时输入状态与重新打开文件后直接在段尾输入分别处理，不能把一个路径的结果套到另一个路径。正文的直接偏移在段尾 Enter 后清除，实际格式命令建立的段落标记则按其自身规则保留。

对于“12 磅带偏移正文、24 磅加粗标记”的删除案例，受测 Writer 在相同源文件和按键下出现了 12／24 磅两种输入字号；等待事件处理完成后仍未消除差异。应用明确保留正文字号，与观察到的 12 磅路径一致，但不宣称覆盖这项原生行为的所有变体。两种原生结果的偏移、加粗及随后连续输入保持稳定，研究记录保留全部差异。

标题支持后续段落样式：段尾 Enter 使用后续样式，正文与段落标记的上下标分别按上述规则处理，其余直接字符格式继续保留；段中 Enter 保留原段样式。多级后续样式链、双向排版和目前未实现的复杂文字脚本明确拒绝，避免接受后错误保存。

DOCX 正文段落的 `w:pPr/w:rPr` 作为独立段落标记保存，支持已有字符格式及受支持的 `rStyle` 引用、继承与显式取消。正文与标记均不隐式应用 `w:default` 字符样式；显式 `rStyle` 引用按各属性规则解析，字符样式中的高亮仍遵循 Writer 的忽略规则。文档默认字符属性 `docDefaults/rPrDefault` 是独立的继承来源。标记格式不会覆盖普通正文。空段使用标记的逻辑字号与插入格式；包含可见正文的末行不会因标记字号较大而被统一撑高；空段、末尾软换行后的空行，以及仅有空格或制表符的末行使用标记字号。空段标记的上下标保留逻辑字号，不再套用正文的缩小比例；背景、高亮及装饰线不绘制成空白色块或线条。

在段尾继续输入时，以相邻正文片段的格式为基础，再应用段落标记的显式属性；不会用标记的整套继承值替换正文格式。局部选区格式操作保留标记。对整段正文首次应用格式时，先清除导入标记的旧直接属性，再应用此次设置；同一编辑会话内后续整段格式操作会累积保留先前的段落直接设置。保存重开后，按导入标记处理。

段尾 Enter 生成新空段时，将当时实际的插入格式补齐写入新段落标记，原段落标记保持不变。例如末尾正文为 24 磅、斜体和蓝色，而标记仅指定粗体，新空段仍能在保存重开后保持这些插入属性。原生对照中，此类信息仅留在空文字片段上会在再次导入时丢失；这里通过完整记录新标记修复这一往返差异。

旧版产品仅在空文字片段上保存的格式继续兼容读入，导出时写入真实段落标记，避免 LibreOffice 重存空段时丢失格式。已有显式标记优先于空文字片段中的冲突格式。样式定义及 `docDefaults` 内的非空 `pPr/rPr` 尚未支持，继续明确拒绝。

工具栏“段落缩进”可设置左右缩进及首行缩进，单位为磅，按 0.05 磅递增；首行填负数表示悬挂缩进。选中多段时，不同的值显示“混合”，只应用实际改动的字段，未修改的字段各自保留。“应用”形成一次可撤销的编辑，“取消”保留原文。切换选区或修改正文会关闭旧草稿，防止误应用到其他段落。

“段落间距”面板提供段前、段后间距及倍数、固定值、最小值三种行距。段前／段后支持 0–1584 磅，固定值／最小值支持 0.05–928.8 磅，按 0.05 磅递增；倍数支持 0.01–3.33，按 0.01 递增。选区中的混合值不自动覆盖，只有实际修改的字段参与一次可撤销的应用；切换行距单位时须重新填写数值。未指定的值显示“文稿默认”，不将新建文稿的默认段后 8 磅套到导入文稿。

上述行距范围是当前验证的连续兼容子集，并非 OOXML 的标准上限。受测 Writer 导入倍数行距时先换算为整数个百分之一毫米，再取整数百分比，例如原始 `line=277` 得到 116%，不能直接按 277/240 保存任意精度。更高的部分倍数在原生保存重开后会漂移，固定值与最小值的更高数值还可能溢出，本轮明确拒绝范围之外的输入。只指定行距数值时沿用已解析的样式规则；只有规则而没有数值的文件仍拒绝。

倍数与最小行距按每段中的文字片段度量，小字号不再受默认 12 磅行框限制。固定行距保持行框高度，允许较大字形及上下标重叠，不用整段或整个片段的不可拆分方框改变自然换行；复制时去掉编辑器专用的对齐布局，保留原文与真实字号。相邻段前／段后间距取最大值。浏览器使用固定字体探针并缓存度量，字体加载后失效重测；当前环境中 12 磅 DejaVu Sans 的单倍度量为约 13.95 磅，原生为 14 磅，混合字体的字形回退及分页仍不保证一致。

删除相邻空首段的段落边界时，保留后段的段落格式、来源及独立标记；普通非空合段仍保留首段格式。段尾 Enter 的后续样式与直接间距分别继承，段中拆段保持原有格式。这些规则使用独立原生按键输出验证，不将尚未覆盖的复杂跨段替换或会话输入状态组合包含在内。

DOCX 的段落样式与直接格式分别保留，包括显式为零的缩进。Enter 在段中或段尾换段时，后段清除直接设置的“与下段同页／段中不分页”，再取其样式的值；不会错误清除样式里继承的开关。缩进及其他直接段落属性继续保留。固定行距与最小行距的直接数值同时记录单位规则，避免保存时变成多倍行距。

缩进支持从左向右段落中的物理单位 `left/right/firstLine/hanging` 及无冲突的 `start/end`。字符单位缩进、镜像缩进及相互冲突的别名仍拒绝。若同一节点同时指定 `firstLine` 与 `hanging` 且不全为零，LibreOffice 与 OOXML 的优先级存在差异，当前也拒绝导入，避免在不同编辑器间改变版式。缩进绘制使用浏览器连续视图，尚未验证分页布局一致性。

详细的 DOCX 支持与拒绝规则以 `src/word/core/docx.ts` 的检查为准。检查采用严格子集：已增加普通 LibreOffice 正文所需的字体表、主题与文档属性保留，以及已验证的中性设置；实际主题字体引用、可见编号、表格、嵌入字体、自动断词等仍需要对应功能实现。全局启用断词但所有有效段落及后续样式均明确禁止断词的文件可以打开。原有文字入口可继续处理复杂文件。校验通过只表示受支持结构可编辑，不意味着与任一 Office 版本像素级一致。

“页面设置”作用于整份单节文稿，提供 A4、A5、Letter、Legal、自定义宽高、横纵方向和四边页边距，应用为一次可撤销的编辑。纸张宽高范围为 72–1584 磅，边距为 0–1584 磅，均按 0.05 磅输入；四边距必须留下有效正文区域。打开后未修改的字段保留原值，取消或文稿变化会丢弃草稿，移动光标不改变文稿级草稿。

纸张方向是与宽高分开的文档属性。导入时保留原始方向，不擅自交换尺寸；只有用户在面板切换方向时才调整宽高，并保留四边距。DOCX 未指定的尺寸按 Writer 的 Letter 宽 612 磅、高 792 磅逐项补足，未指定的四边距各为 72 磅；软件新建文稿仍采用 A4。

Writer 打开 DOCX 时会将接近标准纸边长的尺寸校正为标准值。独立实现按固定版本的标准边长顺序及整数单位换算处理，四边距不参与纸型校正。页面面板提前显示并应用校正结果，使保存重开后的尺寸稳定；原生属性接口允许首次保存暂存未校正的自定义值，两者的编辑时点并不相同。页面装饰轮廓不占正文宽度；连续视图显示纸宽、边距和正文区域，不执行原生分页算法。

在上述范围内逐一检查 30,241 个整数 twip 尺寸，125 个原始值会在原生连续重开时再次变化。例如 5965 → 5953 → 5940 twips。当前明确拒绝这类输入，提示选择标准纸型或调整尺寸；其余 30,116 个值校正后保持稳定。这是当前兼容子集，不是 OOXML 标准限制。

## 实现边界

`src/components/StandaloneWordEditor.vue` 使用自己的模型与工具栏，通过共享 `EditorHandle` 提供导出、保存状态、撤销与重做。该路径不创建 Office iframe，不调用 UNO 或 LibreOffice WASM 来读取、编辑或保存文档。用户同时打开原有文字或表格标签时，那些标签仍独立使用原来的引擎。

主应用在标签上保存 `wordEngine: 'independent'`，按标签选择编辑器与实际可用的保存格式。相同本地文件以不同编辑器打开时不错误复用同一个标签。独立导入在创建标签前调用编解码器检查，避免失败的导入替换当前可编辑模型。

导入性能迭代将预检通过的模型一次性交给编辑器，避免同一新打开文件在 App 与编辑器中各导入一次。交接与文档 ID 及原始内容绑定，消费或丢弃后不再保留；来源不匹配时重新导入，不作为跨标签或跨次打开的文档缓存。每次导入内部只解析一次各 XML／关系文件，校验与格式读取共用该次解析结果；后续导入重新校验调用方提供的字节。浏览器 ZIP 读取改用查表 CRC，继续检查解压长度、校验和与文档语义。Rust 仍负责桌面 ZIP 处理，XML、文档模型与编辑界面仍由 TypeScript／Vue 实现。

解析计数与模型交接的正确性由 `npm run test:browser:word-import-performance` 验证。独立耗时测量比较同一 Chromium 内相同文件的编解码入口，具体方法和范围见[DOCX 导入性能对照](word-import-performance.md)；这些测量不包含文件对话框、编辑器绘制或真实 Tauri IPC，不能据此给出完整应用打开速度的倍数。

参考 LibreOffice 的文档模型、导入导出分层和布局思路，不等于把 LibreOffice 内嵌界面重新包装。首版的原始实现范围、参考来源和未实现能力应分别记录；不能用有限的读写测试宣称完整 Office 兼容。

本轮实际阅读的参考源码包括固定版本的 [SwTextNode 段落模型](https://github.com/LibreOffice/core/blob/dced3bc711d18407a2cc2400eb46e8261b663d95/sw/inc/ndtxt.hxx)、[SwPaM 选区](https://github.com/LibreOffice/core/blob/dced3bc711d18407a2cc2400eb46e8261b663d95/sw/inc/pam.hxx)、[DomainMapper_Impl DOCX 属性上下文与样式继承](https://github.com/LibreOffice/core/blob/dced3bc711d18407a2cc2400eb46e8261b663d95/writerfilter/source/dmapper/DomainMapper_Impl.cxx)，以及 [DOCX 属性输出](https://github.com/LibreOffice/core/blob/libreoffice-24.2.7.2/sw/source/filter/ww8/docxattributeoutput.cxx)。这些是分专题阅读的源码片段，未将该提交认定为随包 WASM 的精确源码版本。

第二轮对照实际安装的 LibreOfficeDev `26.8.0.0.alpha0`（`2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`），保留 4 个正例和 1 个表格负例的原始 ODT、完整 DOCX、哈希和 XML 清单，见[原生语料说明](../tests/compatibility/independent-word/README.md)。标题换段行为参考该版本的 [SwTextNode::SplitContentNode / MakeNewTextNode](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L449) 与 [StyleSheetTable](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/StyleSheetTable.cxx#L538)。该轮仅作源码行为对照，当时尚未完成原生 LibreOffice 按键自动化验证；后续段落标记迭代已加入下文所述的 52 个原生编辑案例。

后续缩进迭代另外保留[原生缩进语料](../tests/compatibility/independent-word-indentation/README.md)，不修改原四件语料。参考同一版本的 [DomainMapper 缩进映射](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L566)、[首行缩进输出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L9709) 与 [段落拆分的直接属性清理](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L3140)。原生 DOCX 与 ODT 转换探针用于核对零覆盖、缩进正负和别名冲突；应用使用独立实现，并未复制这些 C++ 函数。

字符格式迭代增加[原生上下标与删除线语料](../tests/compatibility/independent-word-character-format/README.md)，参考同一版本的 [删除线属性映射](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2345)、[上下标导入](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L3131)、[字符格式导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8275) 和 [段尾换段清理上下标](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/ndtxt.cxx#L761)。原生转换确认删除线继承按 Writer 的实际结果处理，零基线偏移不清除继承的上下标；这不等于已验证 Microsoft Word 的所有样式优先级。显示采用 Writer 标准比例的近似绘制，尚未验证与原生字形度量或分页像素一致。

高亮迭代参考同一版本的 [高亮导入与字符样式忽略规则](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2208)、[标准颜色表](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L5181) 和 [高亮导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8726)。48 个受控原生转换探针确认标准颜色、段落与默认值继承及显式取消。[高亮语料](../tests/compatibility/independent-word-highlight/README.md) 的正例从明确标记的人工 DOCX 输入经过原生 LibreOffice 转存，完整保留未经修改的输出；另保留自主 ODT 生成的完整背景色文件，现作为正文与独立段落标记分别保留的正例，原始字节和哈希不变。原生 DOCX→ODT 转换会丢失部分取消高亮语义，因此本轮以 DOCX→DOCX 往返作为验证范围，不据此声称 ODT 高亮兼容。

背景色迭代参考同一版本的 [字符底纹映射](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2509)、[CellColorHandler 填充解析](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/CellColorHandler.cxx#L110)、[底纹导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8522) 和 [高亮优先绘制](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/text/inftxt.cxx#L1337)。65 个原生案例、275 项断言对照完整 DOCX/ODT/PDF 输出，确认取消、继承和叠加规则，并发现默认底纹首开与重存的差异。ODT 往返会把高亮和底纹合并成单一背景，不能用它证明两个属性都已保留。[背景色语料](../tests/compatibility/independent-word-background/README.md) 区分原始 ODT 与人工 DOCX 来源，保留完整原生输出，含独立段落标记的原始样例现作为正例，分别校验正文与标记格式。

双下划线迭代参考同一版本的 [下划线属性映射](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L5032)、[下划线导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8438) 和 [字体线型属性](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/swfont.cxx#L591)。46 个原生案例、259 项断言对照完整 DOCX/ODT 与两轮 PDF，确认默认字符样式不隐式应用下划线、显式引用生效、下划线与删除线分别绘制。原生版本将 `color="auto"` 解析成白线，因此不能把该属性当作普通下划线忽略。[下划线语料](../tests/compatibility/independent-word-underline/README.md) 原有两件正例和波浪线负例保持不变；独立 RGB 线条颜色的历史负例在颜色实现后转为正例，原生文件字节未变，仍明确区分原始 ODT 与人工 DOCX 来源。该轮 Enter 行为来自源码对照，当时未做原生键盘验证；本轮标记相关的原生编辑证据单独记录如下。

段落标记迭代保留[完整原生语料与独立 XML 检查器](../tests/compatibility/independent-word-marker/README.md)，参考同一版本的 [独立标记属性导入](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper_Impl.cxx#L2678)、[标记导出优先级](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/wrtw8nds.cxx#L3262)、[空白末行的标记字号](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/text/porlay.cxx#L575) 与 [默认字符样式处理](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/StyleSheetTable.cxx#L431)。原生 DOCX 重存和 PDF 探针对照证实：空文字片段上的直接格式会丢失，真实标记格式得以保留；可见正文与空白末行的几何规则不同。静态原生证据覆盖 46 个案例、313 项断言；另以原生 UNO 与 `XToolkitRobot` 键盘驱动核对 52 个编辑案例、236 项断言，确认标记的输入、拆段、合段及完整选区行为。这些是固定原生版本的对照证据，与产品浏览器回归分别记录。实际产品导出的空段需经过原生重存、重新打开和继续输入验证，不能只用产品自身读写互证。

字符间距迭代参考同一版本的 [DOCX 字符间距导入](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2464)、[间距导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8394)、[上下标字体比例](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/inc/swfont.hxx#L806) 和 [负间距显示下限](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/swfont.cxx#L981)。原生逐项验证 −400 至 400 twips 共 801 个值精确往返；真实按键证据确认同值命名字符样式在换段后继续生效。[间距语料及独立检查器](../tests/compatibility/independent-word-spacing/README.md) 区分自主 ODT、人工 DOCX 输入和未经修改的完整原生输出；不支持的中文段落布局、自动断词配置及自动颜色保留为拒绝样例。

大小写格式参考同一版本的 [跨段落与字符样式处理](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper_Impl.cxx#L3424) 和 [Unicode 大小写映射表](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/i18nutil/source/utility/casefolding_data.h#L509)。例如原生将 `ß` 映射为 `ẞ`，浏览器 CSS 则可能显示为 `SS`，所以本轮明确限制效果的文字范围。[大小写语料及独立检查器](../tests/compatibility/independent-word-case/README.md) 记录完整原生文件、格式与文字检查，以及不支持的组合。

字偶距修正参考同一版本的 [非零值导入为布尔开关](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2478) 和 [布尔开关导出为 2／0](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8492)。12 个字号／阈值组合的原生 PDF 与 DOCX 对照确认开关行为不受字号影响，6 个真实按键案例确认命名样式、零覆盖和空段标记的延续。[字偶距完整语料](../tests/compatibility/independent-word-kerning/README.md) 分别记录原始数值、有效开关及原生重存的数值归一化。

独立下划线颜色参考同一版本的 [RGB 颜色导入](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L368)、[颜色导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8472) 和 [菜单的线型、颜色联合命令](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/svx/source/sidebar/text/TextUnderlineControl.cxx#L149)。[完整颜色语料及独立检查器](../tests/compatibility/independent-word-underline-color/README.md) 记录同一样式链与新覆盖的不同继承规则、无下划线时保留的颜色、独立段落标记和原生实际编辑结果。原生文件完整保留；原始 `color="auto"` 拒绝样例与原生转换出的明确白色分别检查。

自定义基线偏移参考同一版本的 [延后换算](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L3988)、[半磅导出取整](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L8292) 和 [原始字体高度位移](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/txtnode/swfont.cxx#L1455)。[专项语料](../tests/compatibility/independent-word-baseline-offset/README.md) 保留完整原件、原生保存结果及独立检查器，区分实际菜单命令与单纯设置 UNO 属性的不同编辑行为。字体对照中 Times New Roman 在当前 Linux 环境映射为 Liberation Serif，混合中英 emoji 的原生样例存在漏绘中文字的异常；该证据只用于限定基线度量，不能证明所有字形回退兼容。

段落间距参考同一版本的 [缺省行距规则继承](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L2734)、[中间单位与整数百分比](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper_Impl.cxx#L5303)、[行距导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/ww8atr.cxx#L5230) 和 [相邻段落间距](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/core/layout/flowfrm.cxx#L1582)。[专项语料与独立检查器](../tests/compatibility/independent-word-paragraph-spacing/README.md) 保存人工输入、未经修改的原生 DOCX/PDF 和实际按键对照；研究中的公式枚举与真实原生运行分别记录。原生 334% 和 1000% 行距的重复保存漂移也完整保留。

页面设置参考同一版本的 [纸型尺寸导入与独立方向标志](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/writerfilter/dmapper/DomainMapper.cxx#L818)、[完整有序纸型表与尺寸校正](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/i18nutil/source/utility/paper.cxx#L67) 和 [实际尺寸导出](https://github.com/LibreOffice/core/blob/2c87e51eeaa2b413ff4ae097b2705eea1995d8e5/sw/source/filter/ww8/docxattributeoutput.cxx#L9655)。[页面专项语料](../tests/compatibility/independent-word-page-settings/README.md) 保留独立作者输入与完整原生一、二次保存文件；原始尺寸、有效期望和原生修复结果分别记录。产品按纸型数值事实独立实现单位转换及匹配，不以原生修复件替换原始负例。

产品的 TypeScript 模型、事务、输入适配和 OOXML 编解码借鉴上述职责划分和格式行为；没有把 C++ 实现翻译或复制进这些模块。桌面通过异步 Tauri 命令调用独立 Rust crate `crates/word-package`，在后台执行受大小限制的 ZIP 读写与 CRC 校验，再由同一 OOXML 编解码器验证文档语义；原生失败不会静默切换另一实现。浏览器预览继续使用 `fflate`。当前并非全 Rust 编辑器，尚无 Rust XML、文档模型或排版引擎。参考副本保留 LibreOffice 原始许可头和来源。

## 验证

### 页面设置迭代

本轮冻结结果汇总于 `test-results/word-page-settings-validation/summary.json`，同目录保存复核脚本、日志及首次失败记录；产品与测试源码哈希均经过复核。

- 231 项单元测试通过（145 项模型、81 项应用外壳、5 项文档格式）；资源校验、类型检查和生产构建通过。
- 页面专项 5 组通过：41 个完整包导入闸门、15 组独立原始／原生文件及一、二次保存的 XML/PDF 对照，以及真实应用保存、原生重存与重开。实际控件覆盖六个尺寸字段、四种纸型、方向切换、选区恢复、一次撤销重做、非法输入原子拒绝、取消、过期草稿和 320×400 窄屏操作。
- 独立审查枚举全部 30,241 个受支持范围内的整数 twip 输入，确认 30,116 个值归一化后稳定、125 个连续重开漂移值明确拒绝；另核对方向与尺寸冲突、五次编解码往返及双轴零正文区域的拒绝。页面边框改用不占空间的轮廓，正文宽度精确按纸宽减左右边距计算。
- 段落间距回归 9 组、编解码回归 21 组及 Rust 包协议回归 30 组通过。Rust 处理 126 份完整语料（96 份接受、30 份语义拒绝），共 525 次真实 CLI 调用及 355 次受控 invoke 调用；本轮没有新的 Rust 性能、真实 Tauri IPC 或安装包验证。各专项记录的页面、控制台及外部／Office 运行时错误集合均为空。

原生研究与产品测试分开执行：144 个独立作者完整输入、84 个标准边长中心、24 个边界控制和 8 类连续漂移均有原生输出，共 35,055 项证据检查通过。原生 PDF 纸张框与 DOCX 尺寸最大偏差为 0.0142 磅；这不代表正文分页或跨平台字体排版一致。

两处测试设施问题保留了初次日志：应用外壳加载器遗漏新增纸型模块；页面脚本用只表示应用就绪的全局撤销按钮判断历史是否为空。分别补齐真实模块加载和编辑器历史控件选择器后完整重跑，未改变产品断言的语义；后续光标检查也修正为正文内的合法偏移。最终专项报告位于 `word-page-settings-final-2/`，首次失败报告继续保留。

### 段落间距迭代

以下是段落间距迭代冻结时的历史记录；后续页面设置修改的验证另行记录。

冻结验证汇总于 `test-results/word-paragraph-spacing-validation/summary.json`。该文件关联最终产品与测试源码哈希、原生证据、实际下载、失败记录和最终重跑结果；复核脚本一并保存在同目录。

- 220 项单元测试通过（134 项独立模型、81 项应用外壳、5 项文档格式）；生产构建包含类型检查、资源校验和 Vite 构建，全部通过。
- 段落间距专项 9 组通过：8 组独立输入／完整原生输出对照，覆盖样式与文档默认值继承、直接零覆盖、原生行距取整；另有 5 项真实 Enter／合段与历史操作、33 项异常输入、实际面板和真实剪贴板检查，以及 8 次 DOM 往返。固定行距中的 48 磅文字仍可自然换行，小字号不受默认 12 磅行框撑高。
- 16 组同字体原生 PDF／浏览器行距对照最大偏差为 0.09775 磅。相邻段落案例的基线距离均为 30 磅，即 12 磅固定行距加 `max(12 磅段后, 18 磅段前)`；这项结果不代表混合字体或分页一致。独立审查另验证 10 个固定行距案例、4 个倍数／最小值案例、选区恢复及字体度量缓存失效。
- 编解码专项 21 组、Rust 包协议专项 28 组通过。Rust 实际 CLI 处理 100 份完整语料，其中 81 份接受、19 份按语义拒绝；共 439 次真实 CLI 调用和 297 次受控 invoke 调用。桌面传输由测试接管，本轮没有真实 Tauri IPC 或新的性能测量。
- 旧功能按最终产品源码重跑：基线偏移 8 组、段落标记 11 组、缩进 8 组、字符格式 9 组全部通过。缩进旧脚本另由外部校验记录 15 项运行前后哈希。上述专项记录的页面、控制台与外部／Office 运行时请求错误集合均为空。

原生研究独立执行 276 项检查，保留 73 个受控段落及固定 LibreOffice 源码版本。完整语料导入闸门验证 16 个正例原件／输出和 2 个负例，原始文件字节与来源哈希均保留；研究结论与产品回归分别记录，不以产品自身读写推断原生行为。

初次原生编辑样例未指定明确文字颜色，输出被已有自动颜色限制正确拒绝；保留该完整文件作为负例，并重新编写显式黑色正例。两次测试脚本失败也保留：Python 检查器文件名遮蔽标准库，以及缩进脚本返回循环内局部变量。修正脚本后均完整重跑，没有放宽产品断言。最终报告位于 `word-paragraph-spacing-final-2/`、`word-paragraph-spacing-rust-final/`、`word-paragraph-spacing-indentation-final/` 等目录，具体关联见汇总文件。

### 自定义基线偏移迭代的历史记录

该轮冻结验证汇总于 `test-results/word-baseline-offset-validation/summary.json`，各专项保留适用源码哈希、完整原生文件和失败后的修复记录。后续段落间距修改不在这份历史报告的覆盖范围内。

- 生产构建通过，包含资源校验、类型检查及打包；模型、应用外壳和文件格式共 215 项单元测试通过（129／81／5）。
- `npm run test:browser:word-baseline-offset`：8 组通过。12 对完整源文件／原生保存结果分别实际导入，经过应用保存、原生重存和重开；覆盖 18 磅工具栏改字号、1 磅编解码取整、真实独立按键输入、换段、删除、标记、工具栏、UTF-16 选区、剪贴板和撤销。30 项 XML／支持范围拒绝及 2 项 API 原子性检查通过，8 轮 DOM 往返保留格式。
- 独立 PDF 检查器读取 12 个原生字形原点；截图核对完整字号、双下划线与独立删除线的位移。本环境中同字号的 10 条对照偏差为 0.0047–0.0454 磅，不同字号的 2 条不作该数值比较。这些结果不证明分页或跨平台字体一致。
- 编解码回归 21 组通过，包含 15 个正负半磅取整对照、两条空段保存复现链和 110 类拒绝输入。空数字偏移片段不再导出自身无法读取的复合格式；独立段落标记及命名上标继续保存。
- 既有字符格式 9 组、段落标记 11 组和下划线颜色 9 组在最终源码上重跑通过；包含 17 个空段导出闸门、原生重存及真实菜单／复制／装饰线检查。所有最终专项记录的源码前后哈希一致，页面、控制台及外部／Office 引擎请求错误均为零。
- `npm run test:browser:word-rust`：25 组通过。90 份原生语料中 73 份接受、17 份语义拒绝；397 次真实 Rust CLI 调用（308 次读、89 次写）和 268 次受控 invoke 调用验证容器路径。合法 ZIP 不会绕过 XML、字体、偏移范围及其他语义检查；这不是实际 Tauri IPC 或安装包验证。
- 独立续输复核检查两种原生标记、工具栏、普通段尾输入、光标移开返回和五步撤销恢复；上标路径有 11 项原生属性严格匹配。24 磅标记删除后的 12／24 磅原生分歧完整保留，应用选择保留正文字号，未将其表述为所有原生路径都一致。

原生静态研究另有 939 项证据检查及最终 15 份完整包导入复核（9 接受、6 按边界拒绝）。研究、专项组数与单元测试分别计数。首次整段删除丢失偏移、随后第二个独立按键被标记覆盖的产品失败均保留；最终测试同时覆盖这两条复现路径。早期 Rust 测试的错误匹配遗漏及超出字体子集的编辑输入也单列归档，没有删改原生语料来适应实现。本轮未重测性能，XML、模型和界面仍为 TypeScript／Vue，Rust 负责桌面 DOCX 包处理。

### 独立下划线颜色迭代的历史记录

以下为下划线颜色、CSS 默认线型、窄屏操作区及格式化复制修复后冻结的验证；完整报告、适用源码哈希和保留的失败记录汇总于 `test-results/word-underline-color-validation/summary.json`。后续功能修改不在这份历史报告的覆盖范围内。

- 最终 `npm run build` 通过，包含资源校验、类型检查与生产构建。相关单元测试 192 项通过（模型 106、应用外壳 81、文件格式 5）。
- `npm run test:browser:word-underline-color`：9 组通过。10 组完整原始／原生正例分别实际导入产品，经历编辑、保存、LibreOffice 重存与重开；包含 23 个静态段落、6 个原生输入／换段控制，以及整段只改颜色后的独立标记与重开 Enter。33 条异常 XML 和完整原始拒绝样例保留当前文稿与撤销历史。
- 5 组真实截图像素检查分别核对单／双线、跟随文字、上下标，以及独立下划线与删除线的颜色和线条数量。真实 UI 验证混合选区、潜在颜色、取消／过期草稿、一次撤销、320×400 菜单按钮可见且可点击、格式化复制／剪切和纯文本粘贴。8 次 DOM 循环及缺失专用元数据恢复保持颜色来源。
- 既有下划线回归 10 组通过：3 件完整原生正例、12 类异常 XML，以及 36 种组合各 8 次 DOM 往返。旧测试的外部点击坐标被扩展后的菜单遮住，现改为真实点击菜单外可见的状态栏并断言关闭；保留首次失败记录，未使用强制点击。
- 段落标记回归 11 组通过：14 件完整原生正例、17 个产品实际导出的空段，经原生重存后继续输入；10 个非法标记与原生波浪线负例仍明确拒绝。既有字偶距 8 组、大小写 9 组和编解码 19 组通过；编解码包含 12 个 RGB／线型组合的三轮保存及 108 类拒绝输入。
- `npm run test:browser:word-rust`：22 组通过。76 件完整兼容语料中，61 件接受、15 件语义拒绝；339 次真实 Rust CLI 调用（262 次读、77 次写）及 227 次受控 invoke 调用验证包处理。容器合法时，非法下划线颜色、主题属性与原始 XML `auto` 仍由语义检查拒绝。模型／编解码器在后续 DOM 和界面修复期间保持冻结，这些检查所记录的源码范围仍与最终版本一致。
- 最终独立复核通过 24 个 DOM 组合、10 个继承对照、2 个原生整段标记控制和 5 项 UI 检查；另外确认 CSS 默认值／`initial`／`unset` 按实线处理，波浪线及未支持的 `inherit` 继续拒绝。所有记录的最终产品文件前后哈希一致；各浏览器专项已记录的页面、控制台及外部／Office 引擎请求错误均为零。

原生研究另有 1,026 项离线证据检查，并对 42 个完整研究包实际执行产品导入（40 接受、2 个原始 `auto` 拒绝）。这些数字与产品测试分别计数。首次像素测试裁掉了行框外的第二条下划线，已扩大截图范围并保留严格线条断言；后续测试发现的合法 CSS 简写拒绝及浏览器默认复制丢失装饰层问题均已修复并重新验证。研究服务端口冲突、原测试对纯文本粘贴／多次键入撤销的错误期待及复测记录均保留，没有修改原生包来迎合产品。

此轮验证限定受支持正文子集、一个固定 LibreOfficeDev 版本及 Chromium。混合线型改色属于应用约定；未验证 Microsoft Word、原生分页、实际 Tauri IPC 或打包 WebView，也未在此轮重测性能。Rust 仍负责 DOCX 包处理，XML、文档模型与界面尚未迁移到 Rust。

### 字偶距迭代的历史记录

以下为独立下划线颜色实现前冻结的结果；后续回归另行记录。

- `npm run build` 通过，包含资源校验、类型检查和生产构建。模型、应用外壳与文件格式共 181 项测试通过（95／81／5）。
- `npm run test:browser:word-kerning`：8 组通过。7 组完整输入／原生输出语料分别经过实际编辑器导入，包含 12 个阈值案例和 6 个原生 Enter／空段控制；产品保存、LibreOffice 重存及重开分别校验原始阈值、有效开关和原生数值归一化。27 个非法编码或未支持水平缩放案例明确拒绝，失败打开保留现有文档。
- 真实字体字宽确认 `w:kern` 的所有非零受测值均开启字偶距，即使字号低于原始阈值。UI 检查覆盖混合选区、两个字段合并为一次撤销、取消、非法／过期草稿、UTF-16 选区与独立空段标记；额外独立审查确认字符间距为正、负或零时字偶距均有效。此处验证浏览器开关行为，不将字宽视为与 Writer 完全一致。
- `npm run test:browser:word-rust`：19 组通过。65 件完整兼容语料包含 49 件接受正例和 16 件语义拒绝对照；287 次真实 Rust CLI 调用（222 次读、65 次写）及 189 次受控 invoke 调用验证包处理路径。Rust 接受 ZIP 容器后，非法字偶距和其他不支持的 XML 语义仍被拒绝。受控传输不等于实际 Tauri IPC。
- 既有字符间距 10 组、大小写显示 9 组和编解码 18 组（108 类拒绝输入）重新通过。字偶距、间距、大小写及独立审查的运行前后源码哈希一致，Rust 报告记录的源码哈希也与当前实现一致。编解码报告没有单独记录源码哈希，运行期间模型与编解码器保持冻结。
- 字偶距与间距首次启动均在 `page.goto` 等待页面加载时超时，尚未执行功能检查；保留失败报告，构建结束后复跑通过，没有修改产品或放宽等待时间。最终各浏览器专项记录的页面错误及外部／Office 引擎请求均为零。

本轮结果和适用源码哈希见 `test-results/word-kerning-validation/summary.json`。原生研究另有 243 项离线证据检查；与产品检查分别计数。水平字符缩放仍未支持：当前 CSS 尝试无法同时保持正确的字形宽度、布局占位和换行。未据此声称 Microsoft Word、逐页排版或真实 Tauri IPC 兼容。

### 大小写显示迭代的历史记录

以下为字偶距修正前冻结的结果；后续回归另行记录。

- `npm run build` 通过，包含资源校验、类型检查和生产构建。
- 模型、应用外壳与文件格式共 174 项测试通过（88／81／5）。模型覆盖原文和 UTF-16 偏移保留、样式继承、显式取消、段落标记、换段和原子拒绝；不支持的显示组合不会改变正文、选区或撤销历史。
- `npm run test:browser:word-case`：9 组检查通过，使用 9 件完整原生正例及 2 件负例。正例通过实际编辑器导入、下载、LibreOffice 重存与再次打开；原始 DOCX 输入另行导入，原生按键案例使用同一输入重放。独立 Python ZIP/XML 检查器核对原文、逐字符格式与标记。另覆盖 30 条异常 XML 和 29 条 Unicode／语言／继承边界，真实复制剪切保留原文和局部 HTML 格式。
- 无 `smcp` 特性的 DejaVu Sans 经 FontTools 确认并记录文件哈希。真实浏览器中的原样、小型大写和全部大写具有不同的字形宽度；关闭小型大写合成后恢复原样宽度。复制出的 HTML 保持相同显示。截图复核补上了早期仅检查 CSS 属性时遗漏的字体回退问题；未把这些尺寸与 Writer 字形度量等同。
- `npm run test:browser:word-rust`：17 组检查通过。58 件完整兼容语料包含 42 件接受正例和 16 件语义拒绝对照；255 次真实 Rust CLI 调用（197 次读、58 次写）与 166 次受控 invoke 调用验证两条包处理路径。有效 ZIP 不会绕过 TypeScript 的 XML、大小写或其他语义检查。这不是实际 Tauri IPC 验证。
- 字符间距 10 组、段落标记 11 组在显示修复后重新通过；大小写、间距、标记报告记录的源码哈希均与最终实现一致，页面错误和外部／Office 引擎请求均为零。
- 既有编解码 17 组检查、108 类拒绝输入通过。该报告未独立记录源码哈希；模型与编解码器在后续显示修复中没有修改。

完整结果与适用源码哈希汇总于 `test-results/word-case-validation/summary.json`。原生研究另保存 472 项离线证据检查，包含静态样式矩阵、独立 ODT、实际键盘与剪贴板实验；研究与产品测试分别计数。支持范围仍为受验证的大小写显示子集，不据此声称 Microsoft Word、复杂文字排版或原生分页兼容。

### 字符间距迭代的历史记录

以下为大小写显示实现前冻结的字符间距结果；本轮重跑结果另行记录。

- `npm run build` 通过；模型、应用外壳和文件格式共 164 项测试通过（78／81／5）。
- `npm run test:browser:word-spacing`：10 组通过。覆盖全部 801 个受支持 twip 值、6 件实际由产品导入的完整原生正例、9 件保留原始字节的原生拒绝对照，以及正文／标记／样式三个位置的 30 条异常编码。4 种字符样式与后续段落组合使用与原生按键相同的输入文件，分别验证首次打开、保存重开后的 Enter、实际原生输出导入及产品文件原生重存。
- 实际工具栏验证包括正负与显式零、混合选区、非法值／取消／过期草稿、选区恢复、撤销重做、空段插入、中文与 emoji、软换行及拆合段；DOM 循环保留原值，显示层独立执行负间距下限。完整间距回归及额外空段会话均未产生 Office runtime、WASM 或外部请求。
- `npm run test:browser:word-rust`：14 组检查通过。47 件原生语料包含 33 件正例和 14 件拒绝对照；209 次真实 Rust CLI 调用及 134 次受控 invoke 调用覆盖间距与字偶距独立、继承零覆盖、标记和空段，以及严格语义拒绝。这不是实际 Tauri IPC 验证。
- 既有编解码 17 组（108 类拒绝输入）、段落标记 11 组、上下标与删除线 9 组均通过。没有因本轮字符间距实现放开自动颜色、中文段落布局或自动断词的既有限制。

该轮最终汇总为 `test-results/word-spacing-validation/summary.json`。间距、Rust、标记、字符格式及附加会话报告记录的产品源码哈希均与该轮冻结实现一致；间距报告同时记录冻结的测试和语料哈希。编解码报告未独立记录源码哈希。早期探针暴露的不支持原生输出已保留作负例，最终正例都额外经过真实产品导入，未删改原生 XML。研究目录保存 1,125 项原生证据断言，含 65 个静态案例、801 值穷举、两组 ODT 共 20 段，以及三组共 18 次原生按键案例；其中明确颜色的最新组有 12 个完整输入／输出包的产品导入记录。研究断言与产品测试分别计数，不据此声称 Microsoft Word 或原生分页兼容。

### 导入性能迭代的历史记录

以下为字符间距实现前的导入性能迭代结果，与后续功能回归分别保存：

- `npm run build` 通过，包含类型检查与生产构建。
- `node --test --experimental-test-isolation=none tests/app-shell-state.test.mjs`：81 项通过，包含新增的 9 项一次性模型交接、源匹配、释放与异步生命周期检查。编辑器生命周期测试使用受控导入器，不将这些检查当作真实 XML 或 IPC 性能证据。
- `npm run test:browser:word-codec`：17 组通过，108 类不支持或损坏输入继续明确拒绝。
- `npm run test:browser:word-rust`：12 组通过，覆盖 32 件原生语料（27 件正例、5 件负例）、163 次真实 Rust CLI 调用及 105 次受控传输调用；受控 invoke 传输不等于真实 Tauri IPC。
- `npm run test:browser:word-independent`：13 项通过，覆盖真实文件选择打开、编辑、保存重开、标签切换、关闭确认，以及失败时保留当前文档。
- `npm run test:browser:word-import-performance`：5 组通过。含 12 个部件的 ZIP 和外部部件导入均逐个 XML／关系文件只解析一次；跨次替换字节、原地修改同一数组、损坏及修复后均重新读取。20 条坏 XML、DTD 和无效编码路径继续拒绝；Python `zipfile`／`zlib` 独立生成的 8 件合法 ZIP 与 8 件伪造 CRC 文件分别通过及拒绝，覆盖 stored／deflate、头部／data descriptor 和多块输入。真实应用首次打开和相同文件再次打开均各导入一次，切回已编辑标签只导入最新快照，保留新增文字。这些是正确性与解析工作量检查，不是耗时基准。

本轮浏览器报告分别位于 `test-results/word-import-codec/`、`test-results/word-rust-package-import-performance/`、`test-results/word-prepared-standalone/` 和 `test-results/word-import-performance-final/`。Rust、完整应用 UI 和导入性能专项记录的源码哈希在运行前后保持一致；编解码报告未单独记录前后源码哈希。各报告记录的页面错误和外部／Office 引擎请求异常均为零。编解码耗时对照另见[性能测量记录](word-import-performance.md)，不与解析次数混作同一指标。

### 段落标记迭代的历史记录

以下为 2026-10-14 段落标记迭代冻结时的验证，不能视为导入性能修改后的重新运行。该轮 8 套浏览器结果、构建与 Node 日志汇总于 `test-results/word-marker-validation/summary.json`，其中保留 PDF 本地监听测试的沙箱失败及复测记录：

- `npm run build` 通过，包含资源校验、类型检查与生产构建。构建包含静态与动态导入同一模块的分包提示，不影响构建结果。
- `node --test --experimental-test-isolation=none tests/*.test.mjs` 覆盖全仓库 777 项：首次 776 项通过，1 项 PDF 本地监听测试因沙箱禁止监听端口而失败；启用本地网络权限后，仅复跑 `pdf-dev-origin` 的 2 项，均通过，没有修改代码。相关模型、应用外壳与文件格式共 147 项通过（模型 70 项、应用外壳 72 项、文件格式 5 项），覆盖独立段落标记、空段格式与显式取消、插入与拆合段、整段格式操作的导入来源与会话累积、历史恢复和原子拒绝，以及原有字符格式、缩进与应用行为。
- `npm run test:browser:word-codec`：17 组检查通过。真实 Chromium 中验证两次 DOCX 保存往返、样式继承、独立 ZIP/XML 读取、原有 LibreOffice 正文及新增原生组合格式文件，以及 108 类不支持或损坏文件的明确拒绝；其中包含 21 种删除线继承组合、7 种命名上下标样式与 5 种默认字符下划线继承情形，检查保存前后 Enter 和空段的来源保留。高亮覆盖 17 个标准值和 8 种继承情形；背景覆盖 5 个直接值、16 种继承情形、显式取消、合段及原生文件两次保存。双下划线与单删除线、高亮和背景组合经过保存重开；12 类非法或未支持的下划线输入明确拒绝。另验证无编号层中的空字符格式容器可接受，有可见内容或布局影响的编号继续拒绝。
- 本次任务前轮验证（段落标记冻结后未重跑）：`cargo test --locked --manifest-path crates/word-package/Cargo.toml` 的 12 组 Rust 测试通过，另以 Python 标准 `zipfile` 验证双向读写及流式 data descriptor。
- 本次任务前轮验证（段落标记冻结后未重跑）：完整 Tauri `cargo check --offline --locked` 通过，包含新命令与权限生成；只报告原有 `AssetServer::start` 未使用警告。
- `npm run test:browser:word-rust`：12 组通过，使用真实 Rust CLI、Chromium OOXML 模块和受控 invoke 传输，覆盖 163 次 CLI 调用（读取 120 次、写入 43 次）及 105 次传输调用。32 件完整原生语料中，27 件正例保留正文与独立标记格式，5 件表格或不支持的下划线负例在 ZIP 验证后仍明确拒绝；两件历史段落标记负例已转为正例。额外覆盖空段标记、稀疏标记与末尾正文的插入格式、显式取消及字符样式来源，以及损坏 ZIP、CRC、UTF-8/UTF-16、分块 base64 和大小限制，原生错误不回退。报告保存源码、CLI 和原生语料哈希，确认运行前后实现一致。
- `npm run test:browser:word-independent`：完整应用的 13 项检查通过，涵盖中文与 emoji、选区格式、标题与软换行、剪贴板、撤销重做、实际下载重开再保存、多标签、关闭确认和 25 万字符边界恢复。
- 本次任务前轮验证（段落标记冻结后未重跑）：`npm run test:browser:word-libreoffice` 的 9 项检查通过。4 件原始 LibreOffice DOCX 经过真实 UI 编辑下载、原生 LibreOffice 转存、再次 UI 编辑保存，并与未经编辑的原生转存控制组独立比较逐字符格式、区域字体、语言、段落属性及元数据；另验证表格原子拒绝、标题样式与 Backspace/Delete 跨段删除。两套 UI 测试均无 iframe、Office/WASM 请求、外部请求或浏览器错误。
- 本次任务前轮验证（段落标记冻结后未重跑）：`npm run test:browser:word-indentation` 的 8 组检查通过。新增完整原生 DOCX 的 7 段正文经过 UI 编辑、原生 LibreOffice 转存及重开；逐段核对左右／首行／悬挂缩进、显式零和样式继承。还覆盖 Enter、合段、历史恢复、混合选区、无效与过期草稿、固定行距及 15 类不支持或歧义缩进输入，且无 Office/WASM 请求、外部请求或浏览器错误。
- `npm run test:browser:word-character-format`：9 组检查通过。完整原生 DOCX 经真实 UI 输入、下载、原生 LibreOffice 转存和重开后，逐字符核对上下标、删除线、下划线与原始字号。另覆盖 15 个命名字符样式换段案例（5 种来源组合、保存前及两次保存后）、空段继续输入、12 次 DOM 读写循环、格式菜单与历史恢复，以及 11 类不支持或损坏的字符属性。运行前后产品源码哈希一致，无 Office/WASM 请求、外部请求或浏览器错误。
- `npm run test:browser:word-highlight`：10 组检查通过。22 段原生语料覆盖全部 17 个高亮值，经 UI 编辑、原生 DOCX 转存、重开后逐字符核对颜色与组合格式；另覆盖全部菜单选项、显式取消、继承、换段与合段、空段真实输入和两次保存。DOM 专项验证保留语义来源的包装复制与透明继承；无来源的 CSS 颜色按普通背景读取，重复 8 次读写保持逻辑字号。完整原生 ODT 背景样例经过局部正文清背景、原生重存与重开，独立校验黄色标记不随正文改变；非法高亮及正文／标记上的图案底纹继续明确拒绝。产品和语料哈希稳定，无 Office/WASM 请求、外部请求或浏览器错误。
- `npm run test:browser:word-background`：12 组检查通过。独立编写的行内背景 ODT 经原生转换后，完整 DOCX 通过两次 UI 保存、原生转存与重开；另有明确标注人工 DOCX 来源的叠加和继承原生样例，验证高亮与背景独立保留、命名及段落样式、显式取消和逻辑字号。覆盖菜单草稿、混合选区、历史恢复、换段合段、整段替换及删除至空段。ASCII、emoji、ZWJ 与组合字符在原生目标范围和无目标范围回退下均经过继续输入、空段保存重开与再次保存验证。16 类非法或未实现的底纹编码明确拒绝，正文和标记上的主题底纹拒绝时保留当前未保存文档；原始段落标记文件经局部正文清背景、原生重存与重开后，分别校验标记的背景、上下标、删除线、下划线与字号。产品及原生语料哈希稳定，浏览器和外部／Office 请求错误均为零。
- `npm run test:browser:word-underline`：10 组检查通过。两件完整原生正例分别经过两次 UI 保存、LibreOffice 重存与重开，独立 XML 逐字符核对单／双／无下划线及样式继承。覆盖混合选区、主按钮与 Ctrl+U、菜单键盘和 320×400 视口、独立删除线与上下标叠加、软／硬换行、双向合段、整段替换和删除至空段后继续输入。36 种格式组合各 8 次 DOM 往返、12 种缺失元数据恢复、10 种 CSS 语义检查通过；12 类非法 OOXML、9 类 CSS 图案、5 类错误元数据及两件原生负例明确拒绝。源码与原生语料哈希一致，页面、控制台及外部／Office 请求错误均为零。

- `npm run test:browser:word-marker`：11 组检查通过。15 件未经修改的原生 DOCX 包含 13 件正例和 2 件负例；正文与标记分别经两次下载、原生重存和重开校验。另从实际产品导出器生成 15 种空段，验证原生重存后的 ASCII、中文和 emoji 输入、字体、继承与显式取消。覆盖稀疏标记叠加末尾正文、Enter 后新空段保存、整段格式的首次导入重置与会话累积、局部格式隔离、工具栏、历史恢复和相对空行几何；7 类合成非法标记及 2 件原生负例原子拒绝。共保留 37 件原生重存文件，产品与原生语料哈希稳定，页面、控制台和外部／Office 请求错误均为零。

完整应用的浏览器回归需要先在另一终端运行 `npm exec vite -- --host 127.0.0.1 --port 5198 --strictPort`，或通过 `STANDALONE_WORD_URL` 指向已有开发服务。编解码及 Rust 协议专项测试自行启动临时服务。原生互操作测试还需要 `soffice`（可用 `SOFFICE` 指定路径）；Rust 测试需要先构建 `word-package-cli`，自定义路径用 `WORD_PACKAGE_CLI` 指定。报告和实际下载保存在 `test-results/standalone-word/`、`independent-word-codec/`、`independent-word-libreoffice/` 和 `word-rust-package/`。

缩进、字符格式、高亮、背景色、下划线与段落标记专项自行启动并关闭 Vite 与 Chromium。段落标记迭代的冻结报告保存在 `test-results/marker-regression-app-final/`、`test-results/marker-regression-character-final/`、`test-results/marker-regression-underline-final/`、`test-results/independent-word-marker-final/`、`test-results/marker-regression-highlight/`、`test-results/marker-regression-background/` 和 `test-results/word-rust-package-marker-final/`；各报告包含实际下载、原生往返文件和源码哈希，标记归档的路径说明见其中的 `ARCHIVE.txt`。其他专项的默认结果目录为 `test-results/independent-word-<专项名>/`。

这些结果不覆盖打包后的 Windows / macOS WebView、真实 Tauri IPC、原生文件对话框、真实系统输入法或 Microsoft Word。输入法检查使用合成 composition 事件；原生 LibreOffice 验证限定一个版本与这些正文样例，并未比较逐页或逐像素排版。

跨段删除通过模型保留区域字体、语言与样式来源，避免浏览器重建 span 时只保留可见 CSS。对于当前无法表达的“清除继承语言或复杂文字字号”等少见合段情况，会拒绝操作并保留原文。独立编辑器的完整布局、表格与复杂对象兼容仍需后续实现及独立验证。

整段选区替换、选区删除及删除最后一个字符同样通过模型保存格式，避免高亮下隐藏的背景和原始字号被浏览器丢弃。最后字符删除使用原生目标范围；没有目标范围时仅处理完整的最后一个字素，不拆开 emoji 或组合字符。DOM 中的高亮和背景分别记录语义来源；确实没有来源标记的单个 CSS 背景只能作为普通背景读取，不能据此推断曾有高亮或恢复已丢失的第二层。
