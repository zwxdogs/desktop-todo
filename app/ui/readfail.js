// readfail.js — 「文件在，但这一次读不进来」的整个判定（#21）。
//
// 三种失败在 Rust 侧已经分好了（files.rs 的 read()）：文件不存在 → `missing: `，
// 其余 IO 错误（被占用 / 没权限）→ `read: `，内容不是 UTF-8 → `utf8: `。
// 本模块负责由此往下的全部决定，三件事收在一处，因为它们是同一个判断的三面：
//
//   ① 分类 —— 认前缀，给出「该怎么办」。
//   ② 措辞 —— 两种能处置的说法钉成纯字符串常量（照 starter.js 的做法），窗口与测试读同一份。
//   ③ 可写 —— 读失败期间清单不能写；判定只在这里写一遍，窗口那侧只问 listReady()。
//
// 为什么 ③ 要跟 ①② 放一起：读不进来时若把清单当成可写的，用户随手勾一下、或直接点 ✕
// 退出，内存里那份清单就会被写回文件——文件没读进来，却先被清空了。这比说错一句话危险得多，
// 所以「能不能写」和「说什么」必须在同一个地方决定，不能一个在模块里、一个散在窗口里。
//
// 为什么不给「强制以 UTF-8 重读」那个逃生口：维护者已定（#21 正文）。不是 UTF-8 就是不是，
// 猜一个编码强行读进来，等于把用户的字按错误的方式解出来再写回去。

/* 错误文本：Tauri 把 Rust 的 Err 原样拒给前端（通常就是字符串），
   但测试与别的调用方可能塞一个 Error 进来——两种都认。 */
function messageOf(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  if (typeof err === 'string') return err;
  return err === undefined || err === null ? '' : String(err);
}

/** 这次读失败属于哪一种：'missing' | 'unreadable' | 'not-utf8'。 */
export function classifyReadError(err) {
  const msg = messageOf(err);
  // 只按前缀认，不按正文里出现过的字认：「另一个程序正在使用此文件」这类
  // 中文系统文案里也带 file / read，照正文猜会把两类处置办法对调。
  if (msg.startsWith('missing:')) return 'missing';
  if (msg.startsWith('utf8:')) return 'not-utf8';
  // 认不出来的一律算读不动：宁可说「打不开」，也不能退回什么都不显示——那正是这张票的空白窗口
  return 'unreadable';
}

/** 路径的文件名部分；拿不到就返回空串（句子会退化成不带文件名）。 */
export function fileNameOf(path) {
  if (typeof path !== 'string') return '';
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/* 文件名那一段：有名字才带「：名字　」，没有就把句子接下去，
   绝不写出一个只有冒号的空位。 */
function namePart(file, lead) {
  const name = fileNameOf(file);
  return name ? `${lead}${name}　` : lead;
}

/** 存在但读不动（被别的程序占用 / 没有读取权限）。 */
export function unreadableHint(file) {
  return namePart(file, '打不开这个文件：')
    + '可能正被别的程序占用，或没有读取权限。关掉占用它的程序后，点这里重试。';
}

/** 内容不是 UTF-8：给的是「另存为 UTF-8」这条路，不是「强制按 UTF-8 重读」那个逃生口。 */
export function notUtf8Hint(file) {
  return namePart(file, '这个文件不是 UTF-8 编码，读不出来：')
    + '用记事本打开它，另存为时把编码选成 UTF-8，再回来点这里重试。';
}

/**
 * 一次装载的结果。成功 → null（没有失败可记），失败 → { kind, file }。
 *
 * kind: 'missing' | 'unreadable' | 'not-utf8' | 'ok'
 * 把「成功」也收进这个入口，是因为只有一个地方知道这次装载的结果，
 * 让它永远交出同一种形状，别处就不用再判断「成功时这个字段该不该清」。
 */
export function loadFailure({ file, kind }) {
  if (!kind || kind === 'ok') return null;
  return { kind, file: typeof file === 'string' ? file : '' };
}

/**
 * 清单现在能不能写盘。**窗口里所有「能不能改」的地方都过这一个判定**（`app.js` 的
 * `listReady()`），不再各写一遍 —— 以前那种散着写的版本，正是漏掉一处就会清空用户文件的形状。
 *
 * 失败记录压过 loaded：装载失败的那一刻，loaded 可能还停在上一次的 true。
 * 正常路径不会留下这个组合（`showLoadFailure` 会同时把 loaded 清零），
 * 这个判断是给「以后有人多写一处 `S.loaded = true`」留的保险——宁可白判一次不可写。
 */
export function canWriteList({ loaded, failure }) {
  return !!loaded && !failure;
}

/**
 * 顶上那条提示该说什么；null = 这条失败不归提示条管。
 *
 * 「文件不存在」不在这里：它有自己的占位（starter.js 的 missingHint，
 * 报顶栏图标序号），照旧画在清单区里，不必在顶栏再重复一遍。
 */
export function loadNoticeText(failure) {
  if (!failure) return null;
  if (failure.kind === 'unreadable') return unreadableHint(failure.file);
  if (failure.kind === 'not-utf8') return notUtf8Hint(failure.file);
  return null;
}
