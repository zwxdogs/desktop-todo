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

/// 「这次写失败是不是权限/只读这一类」——决定要不要弹「把文件夹移到可写位置」那个框。
///
/// 早先这里没有分类：任何一次写失败都被当成「程序目录不可写」，于是磁盘满、目标文件被
/// 别的程序占着的时候，用户看到的是一个让人搬文件夹的错误建议（#18 复查发现）。
/// 只认 os error 5（拒绝访问）与 19/13（只读介质 / 权限不足），其余一律不当成权限问题。
pub fn is_permission_failure(msg: &str) -> bool {
    // std::io::Error 的 Display 是「拒绝访问。 (os error 5)」这种形式，英文系统上是
    // "Access is denied. (os error 5)"——按 os error 号认，不按本地化文本认。
    const PERMISSION_CODES: [&str; 3] = ["(os error 5)", "(os error 19)", "(os error 13)"];
    PERMISSION_CODES.iter().any(|c| msg.contains(c))
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

/// 删除已完成的兜底（#20）：备份文件的路径。
///
/// 命名规则写死在票里：取**最后一个 `.` 之前**为主名，扩展名保留，主名后加 `-bak`。
/// `待办.md` → `待办-bak.md`；无扩展名直接追加（`待办` → `待办-bak`）。
/// 源文件自己叫 `待办-bak.md` 时备份为 `待办-bak-bak.md`——追加而不是替换，
/// 所以**永远不会等于源文件自己**。
///
/// 只有前导点的名字（`.md`）不算扩展名：`Path::file_stem` 对 `.md` 返回 `.md`、
/// `extension` 返回 None，与「最后一个 `.` 之前」这条手工规则在这一点上一致，
/// 因此这里直接用 Path 的两个方法，不自己切字符串。
pub fn backup_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned());
    let name = match (stem, ext) {
        (Some(stem), Some(ext)) => format!("{}-bak.{}", stem, ext),
        (Some(stem), None) => format!("{}-bak", stem),
        // 没有文件名（路径以 `..` 之类结尾）：原样拼，调用方本来就该先检查
        (None, _) => format!("{}-bak", path.display()),
    };
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(name),
        _ => PathBuf::from(name),
    }
}

/// 写备份：与源文件同目录、只留一份（每次覆盖）。
///
/// 走的是与主文件同一个原子写路径（`write` 的 tmp + rename），所以 BOM、换行符、
/// 「写到一半崩掉不会留下半份」这三条保证与主文件完全一致。
pub fn write_backup(src: &Path, content: &str, has_bom: bool) -> Result<(), String> {
    write(&backup_path(src), content, has_bom)
}

/// 读备份（Ctrl+Z 在内存撤销栈被整份重载清掉之后的兜底）。
///
/// 三种结果分得开，因为界面对它们的处置完全不同：
///   `Ok(None)`      —— 没有备份（从没删过 / 用户自己删了它）：凭据作废，没什么可试的。
///   `Err(why)`      —— 有，但读不动（被占用 / 没权限 / 不是 UTF-8）：凭据留着，下次再试。
///   `Ok(Some(out))` —— 读到了。
///
/// 「这份备份是不是我写的那一份」不靠文件时间戳判：凭据在内存里（`list.js` 的
/// `backupPending` / `backupFile`），进程一起来就是空的，所以重启后不会复活旧备份。
#[derive(Serialize, Debug)]
pub struct BackupOut {
    pub text: String,
    pub has_bom: bool,
    pub nl: String,
}

pub fn read_backup(src: &Path) -> Result<Option<BackupOut>, String> {
    let target = backup_path(src);
    // 先看有没有：不存在是常态（从没删过已完成），不该报成一次读失败
    if stat(&target).is_none() {
        return Ok(None);
    }
    let out = read(&target)?;
    Ok(Some(BackupOut { text: out.text, has_bom: out.has_bom, nl: out.nl }))
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

// #18 复查发现的活 bug：任何一次写失败都被当成「程序目录不可写」，于是磁盘满、
// 目标文件被别的程序占着的时候，用户收到的是「请把整个文件夹移到可写目录」这个
// 与事实无关的建议。分类只认 os error 号，不认本地化文本。
#[cfg(test)]
mod write_failure_tests {
    use super::*;

    #[test]
    fn permission_errors_are_recognised() {
        // 只读目录 / 只读介质 / 权限不足：这三类才该建议搬文件夹
        assert!(is_permission_failure("write: 拒绝访问。 (os error 5)"));
        assert!(is_permission_failure("replace: Access is denied. (os error 5)"));
        assert!(is_permission_failure("write: 介质受写保护。 (os error 19)"));
        assert!(is_permission_failure("write: 权限不足。 (os error 13)"));
    }

    #[test]
    fn other_failures_are_not_mistaken_for_readonly_folders() {
        // 磁盘满：让人去搬文件夹毫无用处，还会掩盖真正的原因
        assert!(!is_permission_failure("write: 磁盘空间不足。 (os error 112)"));
        // 目标文件被别的程序占着
        assert!(!is_permission_failure("replace: 另一个程序正在使用此文件，进程无法访问。 (os error 32)"));
        // 路径本身不合法
        assert!(!is_permission_failure("write: 系统找不到指定的路径。 (os error 3)"));
        assert!(!is_permission_failure(""));
    }
}

// 删除已完成的兜底（#20）：同目录一份 `-bak`，只留一份、每次覆盖；绝不盖住源文件自己。
#[cfg(test)]
mod backup_tests {
    use super::*;

    fn bak(p: &str) -> PathBuf {
        backup_path(Path::new(p))
    }

    #[test]
    fn backup_keeps_the_extension_and_adds_dash_bak_to_the_stem() {
        assert_eq!(bak("E:\\项目\\待办.md"), PathBuf::from("E:\\项目\\待办-bak.md"));
        assert_eq!(bak("E:\\项目\\清单.MD"), PathBuf::from("E:\\项目\\清单-bak.MD"));
        // 主名按最后一个 `.` 切：a.b.md 的主名是 a.b
        assert_eq!(bak("E:\\项目\\a.b.md"), PathBuf::from("E:\\项目\\a.b-bak.md"));
        // 同目录：目录部分原样带过去
        assert_eq!(bak("E:\\项目\\子目录\\周报.md"), PathBuf::from("E:\\项目\\子目录\\周报-bak.md"));
    }

    #[test]
    fn no_extension_gets_bak_appended() {
        assert_eq!(bak("E:\\项目\\待办"), PathBuf::from("E:\\项目\\待办-bak"));
        // `.md` 这种只有前导点的名字按 Path 没有扩展名（file_stem 是 `.md`）
        assert_eq!(bak("E:\\项目\\.md"), PathBuf::from("E:\\项目\\.md-bak"));
    }

    #[test]
    fn a_file_that_already_ends_with_bak_gets_another_one() {
        // 源文件自己就叫 待办-bak.md：备份落 待办-bak-bak.md，绝不覆盖源文件
        assert_eq!(bak("E:\\项目\\待办-bak.md"), PathBuf::from("E:\\项目\\待办-bak-bak.md"));
        assert_eq!(bak("E:\\项目\\待办-bak-bak.md"), PathBuf::from("E:\\项目\\待办-bak-bak-bak.md"));
    }

    #[test]
    fn the_backup_never_lands_on_the_source_itself() {
        for p in ["E:\\项目\\待办.md", "E:\\项目\\待办", "待办.md", "E:\\项目\\待办-bak.md"] {
            assert_ne!(bak(p), Path::new(p), "备份路径不能等于源文件：{}", p);
            assert_eq!(bak(p).parent(), Path::new(p).parent(), "必须与源文件同目录");
        }
    }

    #[test]
    fn writing_twice_overwrites_and_leaves_one_file_with_bom_and_nl() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("待办.md");
        std::fs::write(&src, "- [x] 旧\n").unwrap();

        // 第一次：删除前的完整清单，BOM + CRLF 都要照抄
        write_backup(&src, "- [x] 甲\r\n- [ ] 乙\r\n", true).unwrap();
        let target = dir.join("待办-bak.md");
        let raw = std::fs::read(&target).unwrap();
        assert_eq!(&raw[..3], &[0xEF, 0xBB, 0xBF], "BOM 要保留");
        assert_eq!(String::from_utf8(raw[3..].to_vec()).unwrap(), "- [x] 甲\r\n- [ ] 乙\r\n");

        // 第二次：覆盖，目录里始终只有一份
        write_backup(&src, "- [x] 丙\n", false).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("-bak"))
            .collect();
        assert_eq!(names, vec!["待办-bak.md".to_string()], "只留一份，且不留 tmp");
        assert_eq!(read(&target).unwrap().text, "- [x] 丙\n");
        assert!(!read(&target).unwrap().has_bom, "第二次不带 BOM 就不写 BOM");

        // 源文件一个字都没动
        assert_eq!(read(&src).unwrap().text, "- [x] 旧\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_a_missing_backup_says_nothing_there() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-backup-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_backup(&dir.join("待办.md")).unwrap().is_none(), "没有备份就是 None，不是空内容");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backup_that_cannot_be_read_is_an_error_not_an_absence() {
        // 「有，但读不动」与「没有」要分得开：前者凭据该留着下次再试，后者该直接作废
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-backup-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("待办.md");
        std::fs::write(&src, "- [ ] 现在的\n").unwrap();
        // 备份存在，但不是 UTF-8：read 会回 "utf8: ..."
        std::fs::write(backup_path(&src), [0xFF, 0xFE, 0x00]).unwrap();

        let err = read_backup(&src).unwrap_err();
        assert!(err.starts_with("utf8"), "读不动的备份要报原因：{}", err);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_a_backup_hands_back_what_the_frontend_needs_to_restore() {
        // 前端恢复时只要三样：内容、BOM、换行符——它不靠时间戳判「这是不是我写的那份」
        // （凭据在内存里，见 list.js 的 backupPending），所以备份状态不必回传
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("file-backup-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("待办.md");
        std::fs::write(&src, "- [ ] 现在的\n").unwrap();

        write_backup(&src, "- [x] 删前的\r\n", true).unwrap();
        let got = read_backup(&src).unwrap().expect("刚写过的备份要能读回来");
        assert_eq!(got.text, "- [x] 删前的\r\n");
        assert_eq!(got.nl, "\r\n", "换行符跟着备份文件走");
        assert!(got.has_bom, "BOM 也要交出来");
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
