//! config.json 的唯一定义：字段、默认值、读写、路径解析。
//!
//! 手拼 JSON 的双轨制已删（#13）：它当年只为与已删除的 Tk `json.dump(indent=1)` 字节对齐，
//! 唯一的读者随 ADR 0006 一起消失，写出去的字节从没被读回过。现在写用 serde、读也用 serde，
//! 往返由 `config_tests` 钉住。

use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};

/// 旧 config 里可能写成 `"file": null`（早期版本 / 手改）：按空串读，不整份判坏。
fn string_or_empty<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// 同上：`"docked": null` 按 false（普通窗口）读。
fn bool_or_false<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(d)?.unwrap_or(false))
}

/// config.json 的唯一定义。
///
/// 缺字段落默认值：`file` 空串（启动时解析成 exe 旁的 `待办.md`）、几何 `null`、
/// `docked` false（普通窗口，ADR 0004 的默认）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 当前文件的路径，原样记录（可能是 Tk 时代留下的正斜杠写法）。
    #[serde(deserialize_with = "string_or_empty")]
    pub file: String,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub w: Option<i64>,
    pub h: Option<i64>,
    /// 固定在桌面（true）/ 普通窗口（false）。
    #[serde(deserialize_with = "bool_or_false")]
    pub docked: bool,
}

impl Config {
    /// config 的位置：exe 同目录（绿色便携语义，与 udf/ 同址）。
    pub fn path(app_dir: &Path) -> PathBuf {
        app_dir.join("config.json")
    }

    /// 解析一份 config 文本：外部工具（PS5.1 `Set-Content -Encoding UTF8` 等）可能写出
    /// BOM，serde_json 不认，剥掉；坏 JSON 退回默认值（启动不能因为手改坏的配置起不来）。
    pub fn from_text(text: &str) -> Config {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        serde_json::from_str(text).unwrap_or_default()
    }

    /// 读 config；文件不存在、读不动、内容是坏的都算「全新安装」。
    pub fn load(app_dir: &Path) -> Config {
        let Ok(text) = std::fs::read_to_string(Self::path(app_dir)) else {
            return Config::default();
        };
        Self::from_text(&text)
    }

    /// 唯一的写入口：serde 序列化后整份覆盖；先写同目录临时文件再 rename，
    /// 写到一半崩掉也不会留下半份 config（位置与固定状态因此不会在重启时悄悄丢）。
    pub fn save(&self, app_dir: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let path = Self::path(app_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    }

    /// config 里记的文件 → 实际路径：绝对路径原样，相对路径按 exe 目录解析，
    /// 空串 = 还没有文件，落到引导用的 `待办.md`。
    pub fn resolve_file(&self, app_dir: &Path) -> PathBuf {
        let p = PathBuf::from(&self.file);
        if p.as_os_str().is_empty() {
            app_dir.join("待办.md")
        } else if p.is_absolute() {
            p
        } else {
            app_dir.join(p)
        }
    }
}

// #13：config.json 由一个类型拥有读写。先钉「写出去的字节能原样读回」——手拼 JSON 时代
// 写出去的字节没有任何测试读回，双轨制就一直没被抓住。
#[cfg(test)]
mod config_tests {
    use super::*;

    fn sample() -> Config {
        Config {
            file: "E:/项目/待办.md".into(),
            x: Some(3062),
            y: Some(750),
            w: Some(760),
            h: Some(1280),
            docked: true,
        }
    }

    #[test]
    fn round_trip_keeps_every_field() {
        let text = serde_json::to_string_pretty(&sample()).unwrap();
        assert_eq!(Config::from_text(&text), sample(), "全部字段写出再读回必须是同一个值");
    }

    #[test]
    fn old_file_without_optional_fields_reads_with_defaults() {
        // 手改过的 / 老版本写的 config 可能只有一部分字段：缺的落默认值，不能整份丢掉
        let cfg = Config::from_text("{\"file\": \"E:/旧/待办.md\"}");
        assert_eq!(cfg.file, "E:/旧/待办.md");
        assert_eq!((cfg.x, cfg.y, cfg.w, cfg.h), (None, None, None, None));
        assert!(!cfg.docked, "缺 docked = 普通窗口（ADR 0004 的默认）");
    }

    /// 测试用的临时目录：放在 target/ 下（cargo 一定可写，%TEMP% 在受限账户下可能被拒）。
    fn scratch_dir(tag: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("config-test-{}-{}", tag, std::process::id()))
    }

    #[test]
    fn save_then_load_keeps_position_and_desktop_mode() {
        // 验收「文件位置与停在桌面 / 普通窗口两态重启后保持」：写盘 → 重新读，就是一次重启的模型
        let dir = scratch_dir("roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        sample().save(&dir).unwrap();
        assert_eq!(Config::load(&dir), sample(), "重启后位置与固定/普通状态必须还是原样");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn null_file_and_dock_read_as_defaults() {
        // 早期的 Option 字段能读 null：换成 String/bool 后，单个 null 不该把整份配置判坏
        let cfg = Config::from_text("{\"file\": null, \"x\": 1, \"docked\": null}");
        assert_eq!(cfg.file, "");
        assert_eq!(cfg.x, Some(1), "别的字段照常读出来");
        assert!(!cfg.docked);
    }

    #[test]
    fn missing_file_means_defaults() {
        // 全新安装：exe 旁没有 config.json 时用默认值，不能因为读不到就 panic
        let dir = scratch_dir("missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(Config::load(&dir), Config::default());
    }

    #[test]
    fn unknown_fields_are_ignored() {
        // 未来字段或用户手加的注记不该让整份配置判坏
        let cfg = Config::from_text(
            "{\"file\": \"a.md\", \"x\": 1, \"y\": 2, \"w\": 3, \"h\": 4, \"docked\": false, \"future\": {\"k\": true}}",
        );
        assert_eq!(cfg.file, "a.md");
        assert_eq!((cfg.x, cfg.y, cfg.w, cfg.h), (Some(1), Some(2), Some(3), Some(4)));
    }

    #[test]
    fn resolve_file_handles_absolute_relative_and_empty() {
        // 路径解析只在这里定义一次：启动与测试都走它
        let app_dir = Path::new("E:/部署");
        let mut cfg = Config::default();
        assert_eq!(cfg.resolve_file(app_dir), app_dir.join("待办.md"), "空路径 = 全新安装的引导文件");
        cfg.file = "子目录/清单.md".into();
        assert_eq!(cfg.resolve_file(app_dir), app_dir.join("子目录/清单.md"), "相对路径按 exe 目录解析");
        cfg.file = "E:/项目/待办.md".into();
        assert_eq!(cfg.resolve_file(app_dir), PathBuf::from("E:/项目/待办.md"), "绝对路径原样");
    }

    #[test]
    fn bom_or_broken_json_falls_back_to_defaults() {
        // PS5.1 写出的 BOM 不剥掉的话 serde 会整份判坏 → 启动悄悄丢掉位置与停靠状态
        assert_eq!(Config::from_text("\u{feff}{\"file\":\"a.md\",\"x\":1}").file, "a.md");
        assert_eq!(Config::from_text("{ 手改坏了"), Config::default());
    }
}
