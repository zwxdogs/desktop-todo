//! 原生消息框（rfd）。全程序唯一的弹框入口：命令层与维护逻辑都只说「什么级别、什么话」。

pub enum Level {
    Info,
    Warning,
    Error,
}

pub fn show(level: Level, text: &str) {
    let dialog = rfd::MessageDialog::new().set_title(crate::consts::APP_NAME).set_description(text);
    let dialog = match level {
        Level::Warning => dialog.set_level(rfd::MessageLevel::Warning),
        Level::Error => dialog.set_level(rfd::MessageLevel::Error),
        Level::Info => dialog.set_level(rfd::MessageLevel::Info),
    };
    dialog.show();
}
