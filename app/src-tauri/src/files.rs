//! 清单文件的读写与身份：路径 → 标题、读入（BOM/换行）、原子写回、文件状态、explorer 路径。
//!
//! 领域逻辑（解析/渲染/编辑）在前端；这里只管字节，不认识清单的语义。

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::consts::APP_NAME;

/// 当前打开文件的身份：路径 + 顶栏标题。
///
/// 身份只在 Rust 侧产生：共享状态里的 `file` 是唯一来源，命令返回时现算成 `{file, title}`。
/// 前端只把回传的路径原样转发给文件类命令（命令的参数永远显式带路径，不读共享状态猜目标），
/// 不自己派生标题、也不另存一份身份（#12）。
#[derive(Serialize, Debug)]
pub struct FileIdentity {
    pub file: String,
    pub title: String,
}

/// 顶栏标题 = 文件名去掉尾部 `.md`（Windows 文件名大小写不敏感，`.MD` 同样去掉），
/// 与 Tk load_file(565) 的「basename → 去 .md」一致；别的扩展名算文件名的一部分。
/// 空路径 → 程序名（config 里还没有文件时的引导态）。文件本身就叫 `.md` 时保留原文，
/// 不学 Tk 抹成空标题（PARITY §3-17）。
pub fn file_title(path: &Path) -> String {
    let Some(name) = path.file_name() else { return APP_NAME.to_string() };
    let name = name.to_string_lossy();
    let bytes = name.as_bytes();
    // 要求有主体才剥，标题永不为空；Tk 对 `.md` 本身会得到空串
    if bytes.len() > 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md") {
        name[..name.len() - 3].to_string()
    } else {
        name.into_owned()
    }
}

impl FileIdentity {
    pub fn of(path: &Path) -> Self {
        Self { file: path.to_string_lossy().into_owned(), title: file_title(path) }
    }
}

#[derive(Serialize, Debug)]
pub struct ReadOut {
    pub text: String,
    pub has_bom: bool,
    /// 与 todo.pyw read_file(547) 一致："\r\n" if "\r\n" in text else "\n"
    pub nl: String,
}

#[derive(Serialize, Clone)]
pub struct FileState {
    /// ns 自 epoch；超 JS Number 精度，按字符串比较（与 Tk 的 mtime_ns 整数元组等价）
    pub mtime_ns: String,
    pub size: u64,
}

pub fn stat(path: &Path) -> Option<FileState> {
    let md = std::fs::metadata(path).ok()?;
    let t = md.modified().ok()?;
    let ns = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(FileState { mtime_ns: ns.to_string(), size: md.len() })
}

pub fn read(path: &Path) -> Result<ReadOut, String> {
    let data = std::fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("missing: {}", e)
        } else {
            format!("read: {}", e)
        }
    })?;
    let has_bom = data.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if has_bom { &data[3..] } else { &data[..] };
    let text = String::from_utf8(body.to_vec()).map_err(|e| format!("utf8: {}", e))?;
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    Ok(ReadOut { text, has_bom, nl: nl.to_string() })
}

/// 与 todo.pyw write_text 一致：tmp + os.replace 原子替换，保留 BOM。
pub fn write(path: &Path, content: &str, has_bom: bool) -> Result<(), String> {
    let mut data: Vec<u8> = Vec::with_capacity(content.len() + 3);
    if has_bom {
        data.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    data.extend_from_slice(content.as_bytes());
    // todo.pyw 用 path + ".todo_tmp"；with_extension 会替换已有扩展名，手动拼接
    let tmp = PathBuf::from(format!("{}.todo_tmp", path.display()));
    std::fs::write(&tmp, &data).map_err(|e| format!("write: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace: {}", e))
}

/// explorer 的命令行只认**反斜杠分隔的绝对路径**：拿 `E:/项目/待办.md` 这种正斜杠路径喂 `/select,`，
/// 参数被当成非法，explorer 干脆打开自己的默认文件夹（这台机器上是「桌面」），既不进父目录也不选中文件
/// —— 2026-11-14 用户报的「点打开文件位置，没找到相应的 md」就是这个。config.json 里那条路径是 Tk 时代
/// 留下的正斜杠写法，Rust 侧一直原样转手（Tk 版拿到的是 Python 的反斜杠路径，所以当年没暴露）。
/// canonicalize 顺手把相对路径补成绝对路径，但它给出的 `\\?\` / `\\?\UNC\` 前缀 explorer 同样不认，要剥掉。
pub fn explorer_path(s: &str) -> String {
    let s = s.replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{}", rest)
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        s
    }
}

pub fn absolute_explorer_path(path: &Path) -> String {
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    explorer_path(&abs.to_string_lossy())
}

/// `explorer /select,"路径"`：引号是 explorer 自己的语法，整段当一条 raw_arg 传。
pub fn spawn_explorer_select(target: &str) -> Result<(), std::io::Error> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", target))
        .spawn()
        .map(|_| ())
}

/// `explorer <目录>`：这里交给 Rust 加引号（路径可能带空格），不能用 raw_arg。
pub fn spawn_explorer(dir: &str) -> Result<(), std::io::Error> {
    std::process::Command::new("explorer").arg(dir).spawn().map(|_| ())
}

/// 文件对话框的默认目录：当前文件所在目录（用户上次选的地方），文件还没落盘时退回 exe 目录。
pub fn dialog_dir(current: &Path, exe_dir: &Path) -> PathBuf {
    if current.exists() {
        current.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| exe_dir.to_path_buf())
    } else {
        exe_dir.to_path_buf()
    }
}

/// 「新建待办文件」写盘：只有路径不存在时才写示例内容，父目录一并建出来
/// （`write` 只做 tmp + rename，自己不会建目录）。返回是否真的新建（false = 文件本来就在）。
pub fn create_with_template(path: &Path, content: &str) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
    }
    write(path, content, false)?;
    Ok(true)
}

/// 在资源管理器里定位一个路径：文件存在就 `/select` 选中它，文件不在但父目录在就打开父目录，
/// 两者都不在返回 Err（调用方拿去弹框 + 记日志）。反斜杠换算见 `absolute_explorer_path`。
pub fn reveal(path: &Path) -> Result<String, String> {
    if path.exists() {
        let target = absolute_explorer_path(path);
        spawn_explorer_select(&target).map_err(|e| e.to_string())?;
        Ok(target)
    } else if path.parent().map(|d| d.is_dir()).unwrap_or(false) {
        let target = absolute_explorer_path(path.parent().unwrap());
        spawn_explorer(&target).map_err(|e| e.to_string())?;
        Ok(target)
    } else {
        Err(format!("文件和目录都不存在：\n{}", path.display()))
    }
}

// #12：文件身份只由 Rust 从路径派生，前端不再自己 basename；标题规则单独钉住。
#[cfg(test)]
mod file_identity_tests {
    use super::*;

    fn id_of(p: &str) -> FileIdentity {
        FileIdentity::of(Path::new(p))
    }

    #[test]
    fn title_is_the_file_name_without_a_md_extension() {
        // Windows 文件名大小写不敏感：.MD 与 .md 一样去掉
        assert_eq!(id_of("E:\\项目\\待办.md").title, "待办");
        assert_eq!(id_of("/home/u/work.MD").title, "work");
        // 只去 .md；别的扩展名是文件名的一部分（Tk load_file 同款 basename→去 .md）
        assert_eq!(id_of("notes.txt").title, "notes.txt");
        // 文件本身就叫 .md：保留原文，不学 Tk 抹成空标题（PARITY §3-17）
        assert_eq!(id_of(".md").title, ".md");
    }

    #[test]
    fn identity_carries_the_path_the_file_commands_take() {
        // 前端把 file 原样转发给 read/write/stat/reveal，这条是命令参数的契约
        assert_eq!(id_of("E:/项目/待办.md").file, "E:/项目/待办.md");
    }

    #[test]
    fn no_file_falls_back_to_the_app_name() {
        // Path::new("") 没有 file_name：配置缺失时标题显示程序名，而不是空字符串
        assert_eq!(id_of("").title, APP_NAME);
        assert_eq!(id_of("").file, "");
    }

    #[test]
    fn identity_fields_are_flat_on_the_wire() {
        // 前端按 info.file / info.title / res.file / res.created 逐字段读：嵌套一层就读不到，
        // 正是 #12 要消灭的「字段对不上却靠回退默认值不报错」。
        let info = serde_json::to_value(crate::commands::AppInfo {
            identity: id_of("待办.md"),
            docked: true,
        })
        .unwrap();
        assert_eq!(info["file"], "待办.md");
        assert_eq!(info["title"], "待办");
        assert_eq!(info["docked"], true);
        assert!(info.get("testing").is_none(), "前端从不读 testing，回传字段不能多于读取");

        let neu = serde_json::to_value(crate::commands::NewFileOut {
            identity: id_of("新的.md"),
            created: false,
        })
        .unwrap();
        assert_eq!(neu["file"], "新的.md");
        assert_eq!(neu["title"], "新的");
        assert_eq!(neu["created"], false);
    }

    #[test]
    fn read_and_write_round_trip_bytes_including_bom_and_nl() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-io-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("待办.md");

        write(&p, "- [ ] 甲\r\n- [ ] 乙\r\n", true).unwrap();
        let out = read(&p).unwrap();
        assert!(out.has_bom, "BOM 必须保留");
        assert_eq!(out.text, "- [ ] 甲\r\n- [ ] 乙\r\n");
        assert_eq!(out.nl, "\r\n", "换行风格从文件里读，不猜");

        write(&p, "- [ ] 甲\n", false).unwrap();
        let out = read(&p).unwrap();
        assert!(!out.has_bom);
        assert_eq!(out.nl, "\n");
        assert!(stat(&p).is_some(), "写完必须能 stat 到");

        assert_eq!(read(&dir.join("不存在.md")).unwrap_err().split(':').next(), Some("missing"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_with_template_never_overwrites_an_existing_file() {
        // 指到已有文件 = 用户想打开它，绝不能拿示例文案盖掉
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-create-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("子目录").join("新的.md");

        assert!(create_with_template(&p, "# 示例\n- [ ] 第一条\n").unwrap(), "不存在就新建");
        assert_eq!(read(&p).unwrap().text, "# 示例\n- [ ] 第一条\n", "父目录一并建出来");

        std::fs::write(&p, "已有内容\n").unwrap();
        assert!(!create_with_template(&p, "# 示例\n").unwrap(), "已存在返回 false");
        assert_eq!(read(&p).unwrap().text, "已有内容\n", "已有内容一个字都不能动");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dialog_dir_follows_the_current_file_then_falls_back_to_exe_dir() {
        // 默认目录 = 当前文件所在目录；文件还没落盘时退回 exe 目录
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-dir-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe_dir = Path::new("E:/部署");
        let existing = dir.join("待办.md");
        std::fs::write(&existing, "x").unwrap();

        assert_eq!(dialog_dir(&existing, exe_dir), dir, "有文件就跟着它");
        assert_eq!(dialog_dir(&dir.join("没有.md"), exe_dir), exe_dir, "没有文件就退回 exe 目录");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// 2026-11-14 用户报的「点打开文件位置，没找到相应的 md」：explorer 只认反斜杠分隔的绝对路径。
#[cfg(test)]
mod explorer_path_tests {
    use super::*;

    #[test]
    fn forward_slashes_become_backslashes() {
        // config.json 里的原样路径（Tk 时代留下的正斜杠写法）
        assert_eq!(explorer_path("E:/项目/待办.md"), "E:\\项目\\待办.md");
    }

    #[test]
    fn verbatim_prefixes_are_stripped() {
        // canonicalize 的返回形式 explorer 同样不认
        assert_eq!(explorer_path("\\\\?\\E:\\项目\\待办.md"), "E:\\项目\\待办.md");
        assert_eq!(explorer_path("\\\\?\\UNC\\server\\share\\a.md"), "\\\\server\\share\\a.md");
    }

    #[test]
    fn native_path_is_untouched() {
        assert_eq!(explorer_path("E:\\项目\\待办.md"), "E:\\项目\\待办.md");
    }
}
