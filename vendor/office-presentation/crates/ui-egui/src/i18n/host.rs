//! Embedded host messages and unavailable file-service hints.

pub(super) fn lookup(text: &str) -> Option<&'static str> {
    Some(match text {
        "Picture fills cannot be added from files yet; existing picture fills can still be edited." => {
            "当前版本暂不支持从文件添加图片填充；现有图片填充仍可编辑。"
        }
        "Background pictures cannot be added from files yet; existing background pictures can still be edited." => {
            "当前版本暂不支持从文件添加背景图片；现有背景图片仍可编辑。"
        }
        "Pictures cannot be added to albums from files yet; existing albums can still be edited." => {
            "当前版本暂不支持从文件向相册添加图片；现有相册仍可编辑。"
        }
        "Reusing slides from other files is not available yet." => "当前版本暂不支持从其他文件复用幻灯片。",
        "Importing themes from files is not available yet. Use a built-in theme." => "当前版本暂不支持从文件导入主题，请使用内置主题。",
        "Adding transition sounds from files is not available yet. Use a built-in sound." => "当前版本暂不支持从文件添加切换音效，请使用内置音效。",
        "Comparing presentations from files is not available yet." => "当前版本暂不支持选择文件进行演示文稿比较。",
        "Adding SmartArt pictures from files is not available yet. Use Insert Picture to add a separate picture." => {
            "当前版本暂不支持从文件添加 SmartArt 图片，可使用“插入图片”添加独立图片。"
        }
        "Replacing SmartArt pictures from files is not available yet. Use Insert Picture to add a separate picture." => {
            "当前版本暂不支持从文件替换 SmartArt 图片；可使用“插入图片”添加独立图片。"
        }
        "Importing external themes is not available yet. Use built-in themes, colors, and fonts." => {
            "当前版本暂不支持导入外部主题；可使用内置主题、配色和字体。"
        }
        "Comparing with an external presentation is not available yet. Open it in a separate tab to review it." => {
            "当前版本暂不支持与外部演示文稿比较；可在独立标签页打开文稿查看。"
        }
        "Adding transition sounds from files is not available yet." => "当前版本暂不支持从文件添加切换音效。",
        "Reusing slides from external files is not available yet." => "当前版本暂不支持从外部文件重用幻灯片。",
        "The presentation template panel is managed by the Open Office workspace." => "演示模板面板由 Open Office 工作区管理。",
        "Template panel state must be true or false." => "模板面板状态必须为 true 或 false。",
        "Finish the current text input or drag before switching templates." => "请先完成当前输入或拖动，再切换模板。",
        "Finish the current IME composition before saving." => "请完成当前输入法输入后再保存。",
        "The speaker notes document has changed. Finish editing first." => "演讲者备注的文档已改变，请先完成编辑。",
        "The file selection request has ended." => "文件选择请求已结束。",
        "Use Open Office to open presentations." => "请使用 Open Office 打开演示文稿。",
        "This picture could not be read. Choose a valid image file." => "无法读取此图片，请选择有效的图片文件。",
        "Choose a valid audio file." => "请选择有效的音频文件。",
        "Choose a valid video file." => "请选择有效的视频文件。",
        "The insertion target has changed. Select the file again." => "插入目标已改变，请重新选择文件。",
        _ => return None,
    })
}
