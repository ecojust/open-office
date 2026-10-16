//! Common editor feedback. Engine errors and command metadata keep their original values.

pub(super) fn lookup(text: &str) -> Option<&'static str> {
    Some(match text {
        "no active presentation" => "当前没有打开的演示文稿",
        "no presentation open" => "请先打开演示文稿",
        "no slides" => "当前演示文稿没有幻灯片",
        "nothing selected" => "请先选择一个对象",
        "select two or more objects" => "请选择至少两个对象",
        "no text insertion point" => "请先进入文本编辑状态",
        "select text or a shape" => "请先选择文本或形状",
        "nothing to undo" => "没有可撤销的操作",
        "nothing to redo" => "没有可重做的操作",
        "no slide" => "当前没有幻灯片",
        "no such slide" => "找不到该幻灯片",
        "select two or more objects on the slide" => "请在幻灯片上选择至少两个对象",
        "nothing to group" => "没有可组合的对象",
        "nothing to regroup" => "没有可重新组合的对象",
        "select a shape with text" => "请选择包含文本的形状",
        "this object doesn't hold text" => "此对象不支持文本",
        "not editing text" => "请先进入文本编辑状态",
        "select a shape" => "请先选择一个形状",
        "select one shape" => "请选择一个形状",
        "copy shapes first to paste them as a picture" => "请先复制形状，再将其粘贴为图片",
        "nothing to draw" => "没有可转换为图片的内容",
        "the shapes could not be drawn" => "无法将这些形状转换为图片",
        "the slide list is not shown while editing a master" => "编辑母版时不显示幻灯片列表",
        "pick formatting with the Format Painter first" => "请先使用格式刷复制格式",
        "not a table" => "请选择一个表格",
        "can't delete the last row" => "无法删除最后一行",
        "can't delete the last column" => "无法删除最后一列",
        "can't merge those cells" => "无法合并所选单元格",
        "no border to erase there" => "此处没有可擦除的边框",
        "no animation to change (select an animated object or give `index`)" => "请先选择带有动画的对象",
        "pick animations with the Animation Painter first" => "请先使用动画刷复制动画",
        "no target shapes selected" => "请先选择要应用动画的形状",
        "no such animation" => "找不到该动画",
        "a shape in a group can't have its points edited; ungroup it first" => "请先取消组合，再编辑形状顶点",
        "only a shape with an outline has points to edit" => "只有带轮廓的形状才能编辑顶点",
        "select two or more shapes (not lines, groups, tables or charts)" => "请选择至少两个形状，不能包含线条、组合、表格或图表",
        "not a media shape" => "请选择音频或视频对象",
        "no audio or video on this slide" => "此幻灯片没有音频或视频",
        "select an audio or video, or pass `id`" => "请选择一个音频或视频对象",
        "only videos have poster frames" => "只有视频可以设置封面帧",
        "not an animated GIF" => "所选对象不是 GIF 动画",
        "no animated GIF on this slide" => "此幻灯片没有 GIF 动画",
        "select an animated GIF, or pass `id`" => "请选择一个 GIF 动画",
        "The Eyedropper takes colours from a slide" => "吸管可从幻灯片中拾取颜色",
        "Eyedropper: click the slide (Esc cancels)" => "吸管：单击幻灯片拾取颜色，按 Esc 取消",
        "No sound: {error}" => "无法播放声音：{error}",
        "command `{command}` is not available right now: {reason}" => "当前无法执行“{command}”：{reason}",
        "invalid parameters for `{command}`: {reason}" => "无法执行“{command}”：{reason}",
        "{name} was inserted, but it can't be played ({reason})" => "已插入 {name}，但无法播放（{reason}）",
        "{codec} isn't supported yet" => "暂不支持 {codec}",
        "no presentation is open" => "当前没有打开的演示文稿",
        "open a presentation first" => "请先打开演示文稿",
        "open the presentation to compare first" => "请先打开要比较的演示文稿",
        "nothing to print: no presentation is open" => "请先打开要打印的演示文稿",
        "animation preview plays the current slide" => "动画预览仅支持当前幻灯片",
        "no slide to preview" => "当前没有可预览的幻灯片",
        "there was no slide to put it on" => "当前没有可插入内容的幻灯片",
        "{name} was not applied: the presentation it was chosen for is closed" => "未应用 {name}：目标演示文稿已关闭",
        "{name} was not applied: {error}" => "未应用 {name}：{error}",
        "the slide it was chosen for was deleted" => "目标幻灯片已删除",
        "the slide master it was chosen for was deleted" => "目标幻灯片母版已删除",
        "the layout it was chosen for was deleted" => "目标版式已删除",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use crate::{Services, SlideApp};
    use office_presentation_engine::{EngineError, Session};
    use serde_json::json;

    #[test]
    fn editor_errors_are_localized_without_changing_engine_errors() {
        let services = Services { embedded_editor: true, ..Default::default() };
        let mut app = SlideApp::new(Session::with_new(), services);
        let result = app.run("edit.undo", json!({}));
        assert_eq!(result, Err("当前无法执行“撤销”：没有可撤销的操作".into()));
        assert_eq!(app.status.as_ref().map(|(text, _)| text.as_str()), Some("当前无法执行“撤销”：没有可撤销的操作"));
        assert!(matches!(
            app.session.execute("edit.undo", &json!({})),
            Err(EngineError::Disabled(command, reason)) if command == "edit.undo" && reason == "nothing to undo"
        ));
    }

    #[test]
    fn error_details_and_standalone_feedback_are_preserved() {
        let services = Services { embedded_editor: true, ..Default::default() };
        let app = SlideApp::new(Session::with_new(), services);
        let reason = "Home/{reason}/OfficePresentation.pptx is missing";
        let error = EngineError::BadParams { cmd: "text.set".into(), msg: reason.into() };
        assert!(app.engine_error_text(&error).ends_with(reason));
        let text = "command `edit.undo` is not available right now: nothing to undo";
        assert_eq!(app.engine_error_text(&EngineError::Other(text.into())), text);

        let standalone = SlideApp::new(Session::with_new(), Services::default());
        assert_eq!(standalone.engine_error_text(&error), error.to_string());
    }
}
