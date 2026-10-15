//! A deliberately bounded WordprocessingML reader/writer. ZIP processing is
//! delegated to word-package; XML parsing is namespace aware and never permits DTDs.
use crate::model::{Alignment, Document, Page, Paragraph, Run, TextStyle};
use roxmltree::{Document as Xml, Node, ParsingOptions};
use std::collections::{BTreeMap, HashMap, HashSet};
use word_package::{read_package, write_package, RawPart};

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const XML: &str = "http://www.w3.org/XML/1998/namespace";
type Result<T> = std::result::Result<T, String>;
fn need(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn unsupported(name: &str) -> String {
    format!("Rust 文字核心第一阶段暂不支持 DOCX 的 {name}，文件未被修改。")
}
fn parse(bytes: &[u8]) -> Result<Xml<'_>> {
    let text = std::str::from_utf8(bytes).map_err(|_| "DOCX XML 必须是有效 UTF-8。")?;
    if text.trim_start_matches('\u{feff}').starts_with("<?xml") {
        let end = text.find("?>").ok_or("DOCX XML 声明不完整。")?;
        let declaration = &text[..end];
        if declaration.contains("encoding") {
            need(
                declaration.contains("\"UTF-8\"")
                    || declaration.contains("'UTF-8'")
                    || declaration.contains("\"utf-8\"")
                    || declaration.contains("'utf-8'"),
                "DOCX XML 声明必须使用 UTF-8。",
            )?;
        }
    }
    Xml::parse_with_options(
        text,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 150_000,
            ..ParsingOptions::default()
        },
    )
    .map_err(|e| format!("DOCX XML 无效或包含 DTD：{e}"))
}
fn named(n: Node<'_, '_>, ns: &str, local: &str) -> bool {
    n.is_element() && n.tag_name().namespace() == Some(ns) && n.tag_name().name() == local
}
fn attrs(n: Node<'_, '_>, ns: &str, allowed: &[&str]) -> Result<()> {
    for a in n.attributes() {
        if a.namespace() == Some(MC) && a.name() == "Ignorable" {
            // This declaration cannot make unknown content acceptable: every
            // actual element and attribute is checked below independently.
            continue;
        }
        need(
            a.namespace().unwrap_or("") == ns && allowed.contains(&a.name()),
            &unsupported(&format!("{} 属性 {}", n.tag_name().name(), a.name())),
        )?;
    }
    Ok(())
}
fn children<'a, 'i>(n: Node<'a, 'i>) -> Result<Vec<Node<'a, 'i>>> {
    for c in n.children() {
        if c.is_text() {
            need(
                c.text().unwrap_or("").trim().is_empty(),
                "DOCX 格式节点包含意外文字。",
            )?;
        }
        need(!c.is_pi(), "DOCX 不支持 XML 处理指令。")?;
    }
    Ok(n.children().filter(Node::is_element).collect())
}
fn singletons<'a, 'i>(n: Node<'a, 'i>) -> Result<BTreeMap<&'i str, Node<'a, 'i>>> {
    let mut out = BTreeMap::new();
    for c in children(n)? {
        need(
            c.tag_name().namespace() == Some(W),
            &unsupported("非 WordprocessingML 格式节点"),
        )?;
        need(
            out.insert(c.tag_name().name(), c).is_none(),
            "DOCX 格式节点重复。",
        )?;
    }
    Ok(out)
}
fn leaf(n: Node<'_, '_>, allowed: &[&str]) -> Result<()> {
    attrs(n, W, allowed)?;
    need(children(n)?.is_empty(), "DOCX 叶节点含嵌套内容。")
}
fn value<'a>(n: Node<'a, '_>) -> Result<&'a str> {
    n.attribute((W, "val"))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "DOCX 格式缺少 val。".into())
}
fn boolean(n: Node<'_, '_>) -> Result<bool> {
    leaf(n, &["val"])?;
    match n.attribute((W, "val")) {
        None | Some("1" | "true" | "on") => Ok(true),
        Some("0" | "false" | "off") => Ok(false),
        _ => Err("DOCX 布尔格式无效。".into()),
    }
}
fn integer(text: &str, low: u32, high: u32) -> Result<u32> {
    need(
        !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
        "DOCX 数值必须是非负十进制整数。",
    )?;
    let value = text.parse::<u32>().map_err(|_| "DOCX 数值越界。")?;
    need(
        (low..=high).contains(&value),
        "DOCX 数值超出第一阶段支持范围。",
    )?;
    Ok(value)
}
fn color(text: &str) -> Result<String> {
    if text == "auto" {
        return Ok(text.into());
    }
    need(
        text.len() == 6 && text.bytes().all(|b| b.is_ascii_hexdigit()),
        "DOCX 文字颜色必须为 auto 或六位 RGB。",
    )?;
    Ok(format!("#{}", text.to_ascii_uppercase()))
}

#[derive(Clone, Default)]
struct Patch {
    bold: Option<bool>,
    italic: Option<bool>,
    size: Option<f64>,
    color: Option<String>,
    family: Option<String>,
}
impl Patch {
    fn apply(&self, s: &mut TextStyle, toggle: bool) {
        if let Some(v) = self.bold {
            s.bold = if toggle { s.bold ^ v } else { v };
        }
        if let Some(v) = self.italic {
            s.italic = if toggle { s.italic ^ v } else { v };
        }
        if let Some(v) = self.size {
            s.font_size = v;
        }
        if let Some(v) = &self.color {
            s.color = v.clone();
        }
        if let Some(v) = &self.family {
            s.font_family = v.clone();
        }
    }
}
fn run_props(n: Option<Node<'_, '_>>) -> Result<(Patch, Option<String>)> {
    let mut out = Patch::default();
    let mut reference = None;
    let Some(n) = n else {
        return Ok((out, reference));
    };
    attrs(n, W, &[])?;
    for (name, c) in singletons(n)? {
        match name {
            "b" => out.bold = Some(boolean(c)?),
            "i" => out.italic = Some(boolean(c)?),
            "sz" => {
                leaf(c, &["val"])?;
                out.size = Some(integer(value(c)?, 16, 144)? as f64 / 2.0);
            }
            "color" => {
                leaf(c, &["val"])?;
                out.color = Some(color(value(c)?)?);
            }
            "rStyle" => {
                leaf(c, &["val"])?;
                reference = Some(value(c)?.into());
            }
            "rFonts" => {
                leaf(c, &["ascii", "hAnsi", "eastAsia", "cs"])?;
                let values: Vec<_> = ["ascii", "hAnsi", "eastAsia", "cs"]
                    .into_iter()
                    .filter_map(|a| c.attribute((W, a)))
                    .collect();
                need(
                    !values.is_empty()
                        && values.iter().all(|v| {
                            !v.is_empty()
                                && v.len() <= 100
                                && *v == values[0]
                                && !v.chars().any(char::is_control)
                        }),
                    &unsupported("不同文字系统使用不同字体"),
                )?;
                // A single family represents all scripts. Require all selectors
                // so an omitted script cannot silently inherit another font.
                need(
                    ["ascii", "hAnsi", "eastAsia", "cs"]
                        .into_iter()
                        .all(|key| c.attribute((W, key)) == Some(values[0])),
                    &unsupported("不完整的字体脚本映射"),
                )?;
                out.family = Some(values[0].to_string());
            }
            // Explicit false values are the only equivalent representation of
            // these unsupported features; true must never disappear on save.
            "rtl" | "cs" | "vanish" | "webHidden" => {
                need(!boolean(c)?, &unsupported(name))?;
            }
            "szCs" => {
                leaf(c, &["val"])?;
                let v = integer(value(c)?, 16, 144)? as f64 / 2.0;
                let sz = n
                    .children()
                    .find(|x| named(*x, W, "sz"))
                    .ok_or_else(|| unsupported("独立复杂文字字号"))?;
                need(
                    v == integer(value(sz)?, 16, 144)? as f64 / 2.0,
                    &unsupported("不同文字系统使用不同字号"),
                )?;
            }
            _ => return Err(unsupported(&format!("文字格式 {name}"))),
        }
    }
    Ok((out, reference))
}
fn paragraph_props(n: Option<Node<'_, '_>>) -> Result<(Option<Alignment>, Option<String>)> {
    let mut align = None;
    let mut reference = None;
    let Some(n) = n else {
        return Ok((align, reference));
    };
    attrs(n, W, &[])?;
    for (name, c) in singletons(n)? {
        match name {
            "pStyle" => {
                leaf(c, &["val"])?;
                reference = Some(value(c)?.into());
            }
            "jc" => {
                leaf(c, &["val"])?;
                align = Some(match value(c)? {
                    "left" => Alignment::Left,
                    "center" => Alignment::Center,
                    "right" => Alignment::Right,
                    _ => return Err(unsupported("段落对齐方式")),
                });
            }
            "rPr" => {
                attrs(c, W, &[])?;
                need(children(c)?.is_empty(), &unsupported("独立段落标记格式"))?;
            }
            "spacing" => {
                leaf(c, &["before", "after", "line", "lineRule"])?;
                for a in ["before", "after"] {
                    if let Some(v) = c.attribute((W, a)) {
                        need(integer(v, 0, 0)? == 0, &unsupported("段前段后间距"))?;
                    }
                }
                if let Some(v) = c.attribute((W, "line")) {
                    need(integer(v, 240, 240)? == 240, &unsupported("自定义段落行距"))?;
                }
                if let Some(v) = c.attribute((W, "lineRule")) {
                    need(v == "auto", &unsupported("固定或最小段落行距"))?;
                }
            }
            "suppressAutoHyphens" => need(boolean(c)?, &unsupported("自动断词"))?,
            "bidi" | "keepNext" | "keepLines" | "pageBreakBefore" | "contextualSpacing"
            | "widowControl" => need(!boolean(c)?, &unsupported(name))?,
            _ => return Err(unsupported(&format!("段落格式 {name}"))),
        }
    }
    Ok((align, reference))
}
struct Styles<'a, 'i> {
    definitions: HashMap<String, Node<'a, 'i>>,
    default_id: Option<String>,
    default_run: TextStyle,
    default_align: Alignment,
    default_no_widows: bool,
}
impl<'a, 'i> Styles<'a, 'i> {
    fn new(xml: Option<&'a Xml<'i>>) -> Result<Self> {
        let mut out = Self {
            definitions: HashMap::new(),
            default_id: None,
            default_run: TextStyle {
                bold: false,
                italic: false,
                font_size: f64::NAN,
                color: "auto".into(),
                font_family: String::new(),
            },
            default_align: Alignment::Left,
            default_no_widows: false,
        };
        let Some(xml) = xml else { return Ok(out) };
        let root = xml.root_element();
        need(named(root, W, "styles"), "DOCX 样式根节点错误。")?;
        attrs(root, W, &[])?;
        let mut seen_default = false;
        for n in children(root)? {
            need(
                n.tag_name().namespace() == Some(W),
                &unsupported("扩展样式节点"),
            )?;
            match n.tag_name().name() {
                "docDefaults" => {
                    need(!seen_default, "DOCX 默认格式重复。")?;
                    seen_default = true;
                    attrs(n, W, &[])?;
                    for (name, c) in singletons(n)? {
                        attrs(c, W, &[])?;
                        let items = singletons(c)?;
                        match name {
                            "rPrDefault" => {
                                need(
                                    items.len() <= 1 && items.keys().all(|k| *k == "rPr"),
                                    "DOCX 默认文字格式无效。",
                                )?;
                                let (p, reference) = run_props(items.get("rPr").copied())?;
                                need(reference.is_none(), "DOCX 默认格式不允许样式引用。")?;
                                p.apply(&mut out.default_run, false);
                            }
                            "pPrDefault" => {
                                need(
                                    items.len() <= 1 && items.keys().all(|k| *k == "pPr"),
                                    "DOCX 默认段落格式无效。",
                                )?;
                                let property_node = items.get("pPr").copied();
                                out.default_no_widows = property_node.is_some_and(|p| {
                                    p.children().any(|n| named(n, W, "widowControl"))
                                });
                                let (a, reference) = paragraph_props(property_node)?;
                                need(reference.is_none(), "DOCX 默认格式不允许样式引用。")?;
                                if let Some(a) = a {
                                    out.default_align = a;
                                }
                            }
                            _ => return Err(unsupported(name)),
                        }
                    }
                }
                "style" => {
                    attrs(n, W, &["type", "styleId", "default", "customStyle"])?;
                    let id = n
                        .attribute((W, "styleId"))
                        .filter(|s| !s.is_empty())
                        .ok_or("DOCX 样式缺少标识。")?
                        .to_string();
                    need(
                        out.definitions.insert(id.clone(), n).is_none(),
                        "DOCX 样式标识重复。",
                    )?;
                    if let Some(v) = n.attribute((W, "default")) {
                        need(
                            ["0", "1", "false", "true", "off", "on"].contains(&v),
                            "DOCX 默认样式标记错误。",
                        )?;
                        if ["1", "true", "on"].contains(&v)
                            && n.attribute((W, "type")) == Some("paragraph")
                        {
                            need(
                                out.default_id.replace(id).is_none(),
                                "DOCX 默认段落样式重复。",
                            )?;
                        }
                    }
                }
                "latentStyles" => {
                    attrs(
                        n,
                        W,
                        &[
                            "defLockedState",
                            "defUIPriority",
                            "defSemiHidden",
                            "defUnhideWhenUsed",
                            "defQFormat",
                            "count",
                        ],
                    )?;
                    for c in children(n)? {
                        need(named(c, W, "lsdException"), "DOCX 潜在样式元数据错误。")?;
                        leaf(
                            c,
                            &[
                                "name",
                                "locked",
                                "uiPriority",
                                "semiHidden",
                                "unhideWhenUsed",
                                "qFormat",
                            ],
                        )?;
                    }
                }
                _ => return Err(unsupported(n.tag_name().name())),
            }
        }
        Ok(out)
    }
    fn no_widows(&self, id: Option<&str>, seen: &mut Vec<String>) -> Result<bool> {
        let Some(id) = id else {
            return Ok(self.default_no_widows);
        };
        need(
            seen.len() < 32 && !seen.iter().any(|s| s == id),
            "DOCX 样式继承循环或过深。",
        )?;
        seen.push(id.to_string());
        let n = *self.definitions.get(id).ok_or("DOCX 样式不存在。")?;
        if let Some(p) = n.children().find(|n| named(*n, W, "pPr")) {
            if p.children().any(|n| named(n, W, "widowControl")) {
                return Ok(true);
            }
        }
        let base = n
            .children()
            .find(|n| named(*n, W, "basedOn"))
            .and_then(|n| n.attribute((W, "val")));
        self.no_widows(base, seen)
    }
    fn apply(
        &self,
        id: &str,
        kind: &str,
        run: &mut TextStyle,
        align: &mut Alignment,
        stack: &mut Vec<String>,
    ) -> Result<()> {
        need(
            stack.len() < 32 && !stack.iter().any(|s| s == id),
            "DOCX 样式继承循环或过深。",
        )?;
        stack.push(id.into());
        let n = *self
            .definitions
            .get(id)
            .ok_or("DOCX 引用了不存在的样式。")?;
        need(
            n.attribute((W, "type")) == Some(kind),
            "DOCX 样式引用类型不符。",
        )?;
        let items = singletons(n)?;
        if let Some(base) = items.get("basedOn") {
            leaf(*base, &["val"])?;
            self.apply(value(*base)?, kind, run, align, stack)?;
        }
        for (name, c) in &items {
            match *name {
                "rPr" | "pPr" | "basedOn" => {}
                "next" => {
                    leaf(*c, &["val"])?;
                    need(value(*c)? == id, &unsupported("不同后续段落样式"))?;
                }
                "name" | "aliases" | "uiPriority" | "rsid" => leaf(*c, &["val"])?,
                "qFormat" | "semiHidden" | "unhideWhenUsed" => {
                    boolean(*c)?;
                }
                _ => return Err(unsupported(&format!("有效样式中的 {name}"))),
            }
        }
        let (p, reference) = run_props(items.get("rPr").copied())?;
        need(reference.is_none(), "DOCX 样式不允许嵌套字符引用。")?;
        p.apply(run, true);
        need(
            kind == "paragraph" || !items.contains_key("pPr"),
            "字符样式不可包含段落格式。",
        )?;
        let (a, reference) = paragraph_props(items.get("pPr").copied())?;
        need(reference.is_none(), "DOCX 样式不允许嵌套段落引用。")?;
        if let Some(a) = a {
            *align = a;
        }
        stack.pop();
        Ok(())
    }
}

#[derive(Clone)]
struct Relation {
    id: String,
    kind: String,
    target: String,
}
fn relations(bytes: &[u8], root: bool) -> Result<Vec<Relation>> {
    let x = parse(bytes)?;
    let n = x.root_element();
    need(named(n, REL, "Relationships"), "DOCX 关系根节点错误。")?;
    attrs(n, "", &[])?;
    let mut ids = HashSet::new();
    let mut types = HashSet::new();
    let mut result = vec![];
    for c in children(n)? {
        need(named(c, REL, "Relationship"), "DOCX 关系节点错误。")?;
        attrs(c, "", &["Id", "Type", "Target", "TargetMode"])?;
        need(children(c)?.is_empty(), "DOCX 关系包含嵌套内容。")?;
        need(
            c.attribute("TargetMode").is_none() || c.attribute("TargetMode") == Some("Internal"),
            &unsupported("外部关系"),
        )?;
        let id = c
            .attribute("Id")
            .filter(|s| !s.is_empty())
            .ok_or("DOCX 关系缺少 Id。")?;
        need(ids.insert(id), "DOCX 关系 Id 重复。")?;
        let kind = c.attribute("Type").ok_or("DOCX 关系缺少 Type。")?;
        let allowed = if root {
            vec![format!("{R}/officeDocument"),"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties".into(),format!("{R}/extended-properties")]
        } else {
            vec![
                format!("{R}/styles"),
                format!("{R}/settings"),
                format!("{R}/fontTable"),
                format!("{R}/theme"),
                format!("{R}/numbering"),
            ]
        };
        need(
            allowed.iter().any(|s| s == kind),
            &unsupported(&format!("关系类型 {kind}")),
        )?;
        need(types.insert(kind), "DOCX 单例关系类型重复。")?;
        let target = c.attribute("Target").ok_or("DOCX 关系缺少目标。")?;
        need(
            !target.is_empty()
                && !target.starts_with('/')
                && !target.contains(['\\', ':', '#', '?', '%'])
                && target
                    .split('/')
                    .all(|p| !p.is_empty() && p != "." && p != ".."),
            "DOCX 关系路径不安全。",
        )?;
        result.push(Relation {
            id: id.into(),
            kind: kind.into(),
            target: if root {
                target.into()
            } else {
                format!("word/{target}")
            },
        });
    }
    Ok(result)
}
fn mime(kind: &str) -> &'static str {
    match kind {
        "document" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
        }
        "styles" => "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
        "settings" => "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
        "fontTable" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"
        }
        "numbering" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"
        }
        "theme" => "application/vnd.openxmlformats-officedocument.theme+xml",
        "core-properties" => "application/vnd.openxmlformats-package.core-properties+xml",
        "extended-properties" => {
            "application/vnd.openxmlformats-officedocument.extended-properties+xml"
        }
        _ => "",
    }
}
fn settings(xml: &Xml<'_>) -> Result<bool> {
    let root = xml.root_element();
    need(named(root, W, "settings"), "DOCX settings 根节点错误。")?;
    attrs(root, W, &[])?;
    let mut explicit_tabs = false;
    for (name, c) in singletons(root)? {
        match name {
            "zoom" => leaf(c, &["val", "percent"])?,
            "autoHyphenation" => need(!boolean(c)?, &unsupported("自动断词"))?,
            "hyphenationZone" => {
                leaf(c, &["val"])?;
                integer(value(c)?, 0, 0)?;
            }
            "defaultTabStop" => {
                leaf(c, &["val"])?;
                need(
                    integer(value(c)?, 1, 31680)? == 720,
                    &unsupported("自定义制表位"),
                )?;
                explicit_tabs = true;
            }
            "compat" => {
                attrs(c, W, &[])?;
                for sub in children(c)? {
                    need(
                        named(sub, W, "compatSetting"),
                        &unsupported("兼容性布局开关"),
                    )?;
                    leaf(sub, &["name", "uri", "val"])?;
                    need(
                        sub.attribute((W, "name")) == Some("compatibilityMode")
                            && sub.attribute((W, "uri"))
                                == Some("http://schemas.microsoft.com/office/word")
                            && sub.attribute((W, "val")) == Some("15"),
                        &unsupported("兼容性布局开关"),
                    )?;
                }
            }
            _ => return Err(unsupported(&format!("文档设置 {name}"))),
        }
    }
    Ok(explicit_tabs)
}
fn page(n: Option<Node<'_, '_>>) -> Result<Page> {
    let mut out = Page {
        width: 595.3,
        height: 841.9,
        margin_top: 72.0,
        margin_bottom: 72.0,
        margin_left: 72.0,
        margin_right: 72.0,
    };
    let n = n.ok_or_else(|| unsupported("未明确纸张和页边距的文档"))?;
    attrs(n, W, &[])?;
    let items = singletons(n)?;
    need(
        items.contains_key("pgSz") && items.contains_key("pgMar"),
        &unsupported("未明确纸张和页边距的文档"),
    )?;
    for (name, c) in items {
        match name {
            "pgSz" => {
                leaf(c, &["w", "h", "orient"])?;
                out.width = integer(c.attribute((W, "w")).ok_or("缺少页面宽度。")?, 1440, 31680)?
                    as f64
                    / 20.0;
                out.height = integer(c.attribute((W, "h")).ok_or("缺少页面高度。")?, 1440, 31680)?
                    as f64
                    / 20.0;
                if let Some(v) = c.attribute((W, "orient")) {
                    need(
                        ["portrait", "landscape"].contains(&v),
                        "DOCX 页面方向无效。",
                    )?;
                }
            }
            "pgMar" => {
                leaf(
                    c,
                    &[
                        "top", "bottom", "left", "right", "gutter", "header", "footer",
                    ],
                )?;
                for (key, dest) in [
                    ("top", &mut out.margin_top),
                    ("bottom", &mut out.margin_bottom),
                    ("left", &mut out.margin_left),
                    ("right", &mut out.margin_right),
                ] {
                    *dest = integer(c.attribute((W, key)).ok_or("DOCX 缺少页边距。")?, 0, 31680)?
                        as f64
                        / 20.0;
                }
                for key in ["gutter", "header", "footer"] {
                    if let Some(v) = c.attribute((W, key)) {
                        need(integer(v, 0, 0)? == 0, &unsupported("页眉页脚或装订线边距"))?;
                    }
                }
            }
            "type" => {
                leaf(c, &["val"])?;
                need(value(c)? == "nextPage", &unsupported("节类型"))?;
            }
            "formProt" => need(!boolean(c)?, &unsupported("表单保护"))?,
            "textDirection" => {
                leaf(c, &["val"])?;
                need(value(c)? == "lrTb", &unsupported("非横向文本"))?;
            }
            "pgNumType" => {
                leaf(c, &["fmt"])?;
                need(
                    c.attribute((W, "fmt")) == Some("decimal"),
                    &unsupported("页码设置"),
                )?;
            }
            "docGrid" => {
                leaf(c, &["type", "linePitch", "charSpace"])?;
                need(
                    c.attribute((W, "type")) == Some("default"),
                    &unsupported("文档网格"),
                )?;
            }
            _ => return Err(unsupported(&format!("页面设置 {name}"))),
        }
    }
    need(
        out.width > out.margin_left + out.margin_right + 24.0
            && out.height > out.margin_top + out.margin_bottom + 24.0,
        "DOCX 页边距超出页面。",
    )?;
    Ok(out)
}

pub fn import_document(input: &[u8]) -> Result<Document> {
    let raw = read_package(input)?;
    let parts: HashMap<_, _> = raw
        .iter()
        .map(|p| (p.name.as_str(), p.data.as_slice()))
        .collect();
    let get = |name: &str| {
        parts
            .get(name)
            .copied()
            .ok_or_else(|| format!("DOCX 缺少部件 {name}。"))
    };
    // Parse every XML part, including unused metadata, before interpreting any
    // document content. XML expansion and ZIP path/size boundaries stay separate.
    for (name, data) in &parts {
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let _ = parse(data)?;
        }
    }
    let rootrels = relations(get("_rels/.rels")?, true)?;
    let main: Vec<_> = rootrels
        .iter()
        .filter(|r| r.kind == format!("{R}/officeDocument"))
        .collect();
    need(
        main.len() == 1 && main[0].target == "word/document.xml",
        "第一阶段要求唯一 word/document.xml 主文档关系。",
    )?;
    let docrels = match parts.get("word/_rels/document.xml.rels") {
        Some(b) => relations(b, false)?,
        None => vec![],
    };
    let mut expected = HashMap::new();
    expected.insert("word/document.xml".to_string(), mime("document"));
    for relation in rootrels.iter().chain(&docrels) {
        let _ = &relation.id;
        get(&relation.target)?;
        let kind = if relation.kind.ends_with("officeDocument") {
            "document"
        } else {
            relation.kind.rsplit('/').next().unwrap_or("")
        };
        need(!mime(kind).is_empty(), &unsupported("未知部件类型"))?;
        need(
            expected
                .insert(relation.target.clone(), mime(kind))
                .is_none()
                || kind == "document",
            "DOCX 多个关系指向同一部件。",
        )?;
    }
    let types = parse(get("[Content_Types].xml")?)?;
    let root = types.root_element();
    need(named(root, CT, "Types"), "DOCX 内容类型根节点错误。")?;
    attrs(root, "", &[])?;
    let mut overrides = HashMap::new();
    let mut defaults = HashMap::new();
    for c in children(root)? {
        need(
            c.tag_name().namespace() == Some(CT) && children(c)?.is_empty(),
            "DOCX 内容类型节点无效。",
        )?;
        match c.tag_name().name() {
            "Override" => {
                attrs(c, "", &["PartName", "ContentType"])?;
                let p = c.attribute("PartName").ok_or("DOCX 内容类型缺少路径。")?;
                need(
                    p.starts_with('/')
                        && overrides
                            .insert(
                                &p[1..],
                                c.attribute("ContentType").ok_or("DOCX 缺少 MIME。")?,
                            )
                            .is_none(),
                    "DOCX 内容类型路径重复或无效。",
                )?;
            }
            "Default" => {
                attrs(c, "", &["Extension", "ContentType"])?;
                let ext = c
                    .attribute("Extension")
                    .ok_or("DOCX 内容类型缺少扩展名。")?;
                need(
                    !ext.is_empty()
                        && defaults
                            .insert(ext, c.attribute("ContentType").ok_or("DOCX 缺少 MIME。")?)
                            .is_none(),
                    "DOCX 默认内容类型重复。",
                )?;
            }
            _ => return Err("DOCX 内容类型包含未知节点。".into()),
        }
    }
    for path in ["_rels/.rels", "word/_rels/document.xml.rels"] {
        if parts.contains_key(path) {
            let declared = overrides
                .get(path)
                .copied()
                .or_else(|| defaults.get("rels").copied());
            need(
                declared == Some("application/vnd.openxmlformats-package.relationships+xml"),
                "DOCX 关系部件 MIME 错误。",
            )?;
        }
    }
    for (path, want) in &expected {
        let declared = overrides
            .get(path.as_str())
            .copied()
            .or_else(|| defaults.get(path.rsplit('.').next().unwrap_or("")).copied());
        need(declared == Some(*want), "DOCX 部件 MIME 与关系类型不一致。")?;
    }
    for name in parts.keys() {
        if name.ends_with('/') {
            continue;
        }
        need(
            *name == "[Content_Types].xml"
                || *name == "_rels/.rels"
                || *name == "word/_rels/document.xml.rels"
                || expected.contains_key(*name),
            &unsupported(&format!("额外部件 {name}")),
        )?;
    }
    for (path, _) in &overrides {
        need(
            parts.contains_key(*path),
            "DOCX 内容类型声明了不存在的部件。",
        )?;
    }
    let stylepath = docrels
        .iter()
        .find(|r| r.kind == format!("{R}/styles"))
        .map(|r| r.target.as_str());
    let stylexml = stylepath.map(|p| parse(get(p)?)).transpose()?;
    let styles = Styles::new(stylexml.as_ref())?;
    let explicit_tabs = if let Some(p) = docrels.iter().find(|r| r.kind == format!("{R}/settings"))
    {
        settings(&parse(get(&p.target)?)?)?
    } else {
        false
    };
    for p in &docrels {
        let x = parse(get(&p.target)?)?;
        let kind = p.kind.rsplit('/').next().unwrap_or("");
        let (ns, root) = match kind {
            "fontTable" => (W, "fonts"),
            "numbering" => (W, "numbering"),
            "theme" => (
                "http://schemas.openxmlformats.org/drawingml/2006/main",
                "theme",
            ),
            _ => continue,
        };
        need(
            named(x.root_element(), ns, root),
            "DOCX 元数据部件根节点错误。",
        )?;
        for node in x.descendants().filter(Node::is_element) {
            need(
                node.attributes().all(|a| a.namespace() != Some(R)),
                &unsupported("元数据中的外部或嵌入依赖"),
            )?;
        }
    }
    let xml = parse(get("word/document.xml")?)?;
    let root = xml.root_element();
    need(named(root, W, "document"), "DOCX 文档根节点错误。")?;
    attrs(root, W, &[])?;
    let top = children(root)?;
    need(
        top.len() == 1 && named(top[0], W, "body"),
        &unsupported("文档背景或额外正文结构"),
    )?;
    let body = top[0];
    attrs(body, W, &[])?;
    let nodes = children(body)?;
    let mut paragraphs = vec![];
    let mut section = None;
    for (index, p) in nodes.iter().copied().enumerate() {
        if named(p, W, "sectPr") {
            need(
                section.is_none() && index + 1 == nodes.len(),
                "DOCX 仅支持正文结尾的单个节。",
            )?;
            section = Some(p);
            continue;
        }
        need(
            named(p, W, "p"),
            &unsupported("图片、表格、内容控件或非段落正文"),
        )?;
        attrs(p, W, &["rsidR", "rsidRPr", "rsidP", "rsidRDefault"])?;
        let elements = children(p)?;
        let mut pr = None;
        let mut runs = vec![];
        for (i, c) in elements.iter().copied().enumerate() {
            if named(c, W, "pPr") {
                need(pr.is_none() && i == 0, "DOCX 段落格式重复或位置错误。")?;
                pr = Some(c);
            } else {
                need(
                    named(c, W, "r"),
                    &unsupported("超链接、书签、修订或非普通文本"),
                )?;
            }
        }
        let (direct_align, reference) = paragraph_props(pr)?;
        let mut align = styles.default_align.clone();
        let mut base = styles.default_run.clone();
        if let Some(id) = reference.as_deref().or(styles.default_id.as_deref()) {
            styles.apply(id, "paragraph", &mut base, &mut align, &mut vec![])?;
        }
        let no_widows = pr.is_some_and(|p| p.children().any(|n| named(n, W, "widowControl")))
            || styles.no_widows(
                reference.as_deref().or(styles.default_id.as_deref()),
                &mut vec![],
            )?;
        need(
            no_widows,
            &unsupported("缺省启用的孤行控制；需明确关闭后使用基础模式"),
        )?;
        if let Some(a) = direct_align {
            align = a;
        }
        for r in elements.into_iter().filter(|n| named(*n, W, "r")) {
            attrs(r, W, &["rsidR", "rsidRPr"])?;
            let content = children(r)?;
            let mut rp = None;
            let mut text = String::new();
            for (i, c) in content.into_iter().enumerate() {
                need(
                    c.tag_name().namespace() == Some(W),
                    &unsupported("扩展文字内容"),
                )?;
                match c.tag_name().name() {
                    "rPr" => {
                        need(rp.is_none() && i == 0, "DOCX 文字格式重复或位置错误。")?;
                        rp = Some(c);
                    }
                    "t" => {
                        attrs(c, XML, &["space"])?;
                        if let Some(v) = c.attribute((XML, "space")) {
                            need(
                                ["preserve", "default"].contains(&v),
                                "DOCX xml:space 无效。",
                            )?;
                        }
                        need(
                            c.children().all(|x| x.is_text() || x.is_comment()),
                            "DOCX 文本节点含嵌套标记。",
                        )?;
                        let s: String = c
                            .children()
                            .filter(Node::is_text)
                            .filter_map(|x| x.text())
                            .collect();
                        need(
                            !s.contains(['\n', '\r']),
                            &unsupported("文本节点中的软换行"),
                        )?;
                        text.push_str(&s);
                    }
                    "tab" => {
                        leaf(c, &[])?;
                        text.push('\t');
                    }
                    _ => return Err(unsupported(&format!("文字节点 {}", c.tag_name().name()))),
                }
            }
            let (patch, reference) = run_props(rp)?;
            let mut style = base.clone();
            if let Some(id) = reference {
                styles.apply(
                    &id,
                    "character",
                    &mut style,
                    &mut align.clone(),
                    &mut vec![],
                )?;
            }
            patch.apply(&mut style, false);
            runs.push(Run { text, style });
        }
        if runs.is_empty() {
            runs.push(Run {
                text: String::new(),
                style: base,
            });
        }
        if runs.iter().any(|r| r.text.is_empty()) && runs.len() > 1 {
            need(
                runs.iter()
                    .all(|r| r.text.is_empty() && r.style == runs[0].style),
                &unsupported("混合空 run 的独立插入格式"),
            )?;
        }
        paragraphs.push(Paragraph { runs, align });
    }
    need(
        !paragraphs.is_empty() && paragraphs.len() <= 500,
        "DOCX 正文为空或超过 500 段。",
    )?;
    let doc = Document {
        page: page(section)?,
        paragraphs,
    };
    need(
        explicit_tabs
            || !doc
                .paragraphs
                .iter()
                .flat_map(|p| &p.runs)
                .any(|r| r.text.contains('\t')),
        &unsupported("未明确为 720 twip 的默认制表位"),
    )?;
    let count: usize = doc
        .paragraphs
        .iter()
        .map(|p| {
            p.runs
                .iter()
                .map(|r| r.text.encode_utf16().count())
                .sum::<usize>()
        })
        .sum::<usize>()
        + doc.paragraphs.len()
        - 1;
    need(count <= 10_000, "DOCX 正文超过 10000 个 UTF-16 字符。")?;
    crate::model::normalize_document(doc)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn run_xml(run: &Run) -> Result<String> {
    let s = &run.style;
    need(
        s.font_size.is_finite()
            && (8.0..=72.0).contains(&s.font_size)
            && (s.font_size * 2.0).fract() == 0.0,
        "DOCX 字号需要为 8 至 72 pt 的半点数值。",
    )?;
    need(
        !s.font_family.is_empty()
            && s.font_family.len() <= 100
            && !s.font_family.chars().any(char::is_control),
        "DOCX 字体名称无效。",
    )?;
    let token = if s.color == "auto" {
        "auto".to_string()
    } else {
        let rgb = s.color.strip_prefix('#').ok_or("DOCX 文字颜色无效。")?;
        color(rgb)?;
        rgb.to_ascii_uppercase()
    };
    let fam = escape(&s.font_family);
    let mut out=format!("<w:r><w:rPr><w:rFonts w:ascii=\"{fam}\" w:hAnsi=\"{fam}\" w:eastAsia=\"{fam}\" w:cs=\"{fam}\"/><w:b w:val=\"{}\"/><w:i w:val=\"{}\"/><w:sz w:val=\"{}\"/><w:color w:val=\"{token}\"/></w:rPr>",if s.bold{1}else{0},if s.italic{1}else{0},(s.font_size*2.0) as u32);
    need(
        !run.text
            .chars()
            .any(|c| c == '\r' || c == '\n' || (c.is_control() && c != '\t')),
        "DOCX run 含非法控制字符或段落换行。",
    )?;
    for (i, text) in run.text.split('\t').enumerate() {
        if i > 0 {
            out.push_str("<w:tab/>");
        }
        out.push_str(&format!(
            "<w:t xml:space=\"preserve\">{}</w:t>",
            escape(text)
        ));
    }
    out.push_str("</w:r>");
    Ok(out)
}
pub fn export_document(document: &Document) -> Result<Vec<u8>> {
    let checked = crate::model::normalize_document(document.clone())?;
    let document = &checked;
    need(
        !document.paragraphs.is_empty() && document.paragraphs.len() <= 500,
        "DOCX 段落数量无效。",
    )?;
    let p = &document.page;
    for v in [
        p.width,
        p.height,
        p.margin_left,
        p.margin_right,
        p.margin_top,
        p.margin_bottom,
    ] {
        need(
            v.is_finite() && (0.0..=1584.0).contains(&v),
            "DOCX 页面数值无效。",
        )?;
        need(
            (v * 20.0 - (v * 20.0).round()).abs() < 1e-8,
            "DOCX 页面数值必须可精确表示为 1/20 pt，不能静默取整。",
        )?;
    }
    need(
        p.width >= 72.0
            && p.height >= 72.0
            && p.width > p.margin_left + p.margin_right + 24.0
            && p.height > p.margin_top + p.margin_bottom + 24.0,
        "DOCX 页面或页边距无效。",
    )?;
    let mut body = String::new();
    let mut count = 0;
    for p in &document.paragraphs {
        let align = match p.align {
            Alignment::Left => "left",
            Alignment::Center => "center",
            Alignment::Right => "right",
        };
        body.push_str(&format!("<w:p><w:pPr><w:jc w:val=\"{align}\"/><w:widowControl w:val=\"0\"/><w:spacing w:before=\"0\" w:after=\"0\"/><w:suppressAutoHyphens/></w:pPr>"));
        for r in &p.runs {
            count += r.text.encode_utf16().count();
            body.push_str(&run_xml(r)?);
        }
        body.push_str("</w:p>");
    }
    need(
        count + document.paragraphs.len() - 1 <= 10_000,
        "DOCX 正文超过 10000 个 UTF-16 字符。",
    )?;
    let tw = |v: f64| (v * 20.0).round() as u32;
    body.push_str(&format!("<w:sectPr><w:pgSz w:w=\"{}\" w:h=\"{}\"/><w:pgMar w:top=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:right=\"{}\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/></w:sectPr>",tw(p.width),tw(p.height),tw(p.margin_top),tw(p.margin_bottom),tw(p.margin_left),tw(p.margin_right)));
    let document=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"{W}\"><w:body>{body}</w:body></w:document>");
    let types=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"{CT}\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"{}\"/><Override PartName=\"/word/settings.xml\" ContentType=\"{}\"/></Types>",mime("document"),mime("settings"));
    let relationships=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"{REL}\"><Relationship Id=\"rId1\" Type=\"{R}/officeDocument\" Target=\"word/document.xml\"/></Relationships>");
    let document_relationships=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"{REL}\"><Relationship Id=\"rIdSettings\" Type=\"{R}/settings\" Target=\"settings.xml\"/></Relationships>");
    let settings=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:settings xmlns:w=\"{W}\"><w:defaultTabStop w:val=\"720\"/></w:settings>");
    write_package(&[
        RawPart {
            name: "[Content_Types].xml".into(),
            data: types.into_bytes(),
        },
        RawPart {
            name: "_rels/.rels".into(),
            data: relationships.into_bytes(),
        },
        RawPart {
            name: "word/document.xml".into(),
            data: document.into_bytes(),
        },
        RawPart {
            name: "word/_rels/document.xml.rels".into(),
            data: document_relationships.into_bytes(),
        },
        RawPart {
            name: "word/settings.xml".into(),
            data: settings.into_bytes(),
        },
    ])
}
