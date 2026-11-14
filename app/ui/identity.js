/* 文件身份的读端（#12）：Rust 的 app_info / choose_file / new_md_file 回传 {file, title}，
   这里把字段逐个验证后再交给状态。字段对不上就立刻抛错——#12 的静默失败正是
   「读了个不存在的字段，undefined 落进状态、再靠回退默认值假装一切正常」。
   纯函数，node --test 直接覆盖；Rust 侧的 serialize 形状由 cargo 的
   file_identity_tests 钉住，两边同时改名才会一起红。 */

export function readIdentity(raw) {
  if (!raw || typeof raw.file !== 'string' || typeof raw.title !== 'string') {
    throw new Error(`文件身份字段缺失：${JSON.stringify(raw)}`);
  }
  return { file: raw.file, title: raw.title };
}
