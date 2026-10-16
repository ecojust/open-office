//! Chinese interface text for the embedded Open Office editor.
//!
//! Translation is scoped to an editor frame/command. Standalone windows keep their
//! original language, and command ids, serialized values and document text are never
//! translated by this module. Call `tr` only at interface display boundaries.

use std::cell::Cell;

mod dialogs;
mod errors;
mod panes;
mod presets;
mod ribbon;
mod show;
mod workspace;

thread_local! {
    static CHINESE: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct LanguageScope(bool);

impl Drop for LanguageScope {
    fn drop(&mut self) {
        CHINESE.set(self.0);
    }
}

/// Restore the previous editor's language even when a frame returns early.
pub(crate) fn scope(chinese: bool) -> LanguageScope {
    LanguageScope(CHINESE.replace(chinese))
}

pub fn tr(text: &str) -> &str {
    if !CHINESE.get() {
        return text;
    }
    common(text)
        .or_else(|| ribbon::lookup(text))
        .or_else(|| dialogs::lookup(text))
        .or_else(|| panes::lookup(text))
        .or_else(|| workspace::lookup(text))
        .or_else(|| show::lookup(text))
        .or_else(|| presets::lookup(text))
        .or_else(|| errors::lookup(text))
        .unwrap_or(text)
}

/// Transition names may overlap editing commands (for example, Cut).
pub fn transition_label(text: &str) -> &str {
    if CHINESE.get() && text == "Cut" { "直接切换" } else { tr(text) }
}

/// Chart names need their own context: a line chart is not a geometric line.
pub fn chart_kind(text: &str) -> &str {
    if !CHINESE.get() {
        return text;
    }
    match text {
        "Clustered Column" => "簇状柱形图",
        "Stacked Column" => "堆积柱形图",
        "100% Stacked Column" => "百分比堆积柱形图",
        "Clustered Bar" => "簇状条形图",
        "Stacked Bar" => "堆积条形图",
        "100% Stacked Bar" => "百分比堆积条形图",
        "Line" => "折线图",
        "Line with Markers" => "带数据标记的折线图",
        "Stacked Line" => "堆积折线图",
        "Area" => "面积图",
        "Stacked Area" => "堆积面积图",
        "Pie" => "饼图",
        "Doughnut" => "圆环图",
        "Scatter" => "散点图",
        "Bubble" => "气泡图",
        "Radar" => "雷达图",
        "Filled Radar" => "填充雷达图",
        "Stock" => "股价图",
        "Surface" => "曲面图",
        "Histogram" => "直方图",
        "Pareto" => "帕累托图",
        "Box and Whisker" => "箱形图",
        "Waterfall" => "瀑布图",
        "Funnel" => "漏斗图",
        "Treemap" => "树状图",
        "Sunburst" => "旭日图",
        "Map" => "地图",
        "Combo" => "组合图",
        _ => text,
    }
}

/// Substitute named placeholders once, without interpreting inserted document text.
pub fn format(template: &str, values: &[(&str, &str)]) -> String {
    let mut rest = tr(template);
    let mut result = String::with_capacity(rest.len());
    while let Some((before, after)) = rest.split_once('{') {
        result.push_str(before);
        let Some((key, tail)) = after.split_once('}') else {
            result.push('{');
            result.push_str(after);
            return result;
        };
        if let Some((_, value)) = values.iter().find(|(name, _)| *name == key) {
            result.push_str(value);
        } else {
            result.push('{');
            result.push_str(key);
            result.push('}');
        }
        rest = tail;
    }
    result.push_str(rest);
    result
}

fn common(text: &str) -> Option<&'static str> {
    Some(match text {
        "OK" => "确定",
        "Cancel" => "取消",
        "Close" => "关闭",
        "Apply" => "应用",
        "Reset" => "重置",
        "Delete" => "删除",
        "Remove" => "移除",
        "None" => "无",
        "Default" => "默认",
        "Automatic" => "自动",
        "Custom" => "自定义",
        "Saved" => "已保存",
        "This slide has no animations" => "当前幻灯片没有动画",
        "Previewing animations" => "正在预览动画",
        "Saving a copy needs a file picker, which this window doesn't have." => "请使用顶部工具栏另存为副本。",
        "Opened the presentation as a PDF to print" => "已将演示文稿转换为 PDF 以供打印",
        "Browse for Themes needs the desktop app for now" => "当前环境暂不支持从文件导入主题",
        "Compare needs the desktop app for now" => "当前环境暂不支持从文件比较文稿",
        "Exported {path}" => "已导出 {path}",
        "Saved {path}" => "已保存 {path}",
        "Inserted {n} slides from {path}" => "已从 {path} 插入 {n} 张幻灯片",
        "Couldn't save AutoRecover information: {error}" => "无法保存自动恢复信息：{error}",
        "Open Office can't export “{format}”" => "Open Office 暂不支持导出为“{format}”",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_scope_restores_standalone_and_nested_editors() {
        assert_eq!(tr("Cancel"), "Cancel");
        {
            let _embedded = scope(true);
            assert_eq!(tr("Cancel"), "取消");
            {
                let _standalone = scope(false);
                assert_eq!(tr("Cancel"), "Cancel");
            }
            assert_eq!(tr("Cancel"), "取消");
        }
        assert_eq!(tr("Cancel"), "Cancel");
    }

    #[test]
    fn formatting_preserves_inserted_text_and_unknown_keys() {
        let _embedded = scope(true);
        assert_eq!(format("Saved {path}", &[("path", "Home/{path}/My slides.pptx")]), "已保存 Home/{path}/My slides.pptx");
        assert_eq!(format("{unknown}: {text}", &[("text", "{unknown}")]), "{unknown}: {unknown}");
        assert_eq!(format("unfinished {", &[]), "unfinished {");
        assert_eq!(tr("My presentation 标题"), "My presentation 标题");
        assert_eq!(tr("slide.new"), "slide.new");
    }
}
