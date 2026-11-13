---
status: accepted
date: 2026-11-13
---

# 退出与白屏自救不依赖 JS

2026-11-13 晚，用户报告桌面待办「完全白屏，并且在托盘里退出不了」。现场取证：进程还活着（PID 56888，20:56:28 启动，`Responding=True`），主窗与 `WRY_WEBVIEW` 子窗都在，但**没有任何 msedgewebview2.exe 子进程**——WebView2 的浏览器进程已经没了，窗口留白；此后点托盘「退出」毫无反应，重新双击 exe 也没反应（被单实例互斥体挡住）。两条症状同一个根：**退出链和整个界面都挂在同一个 JS 上，JS 死了就双双失效**。

## Context

- 退出链原来只有一条：`TRAY_QUIT` / `CloseRequested` → `app.emit("app-exit-request")` → 只有 `boot()` 里注册的那个 JS 监听会 `invoke('exit_app')`。`boot()` 是 `await invoke('app_info')` 之后才注册监听的，所以后端命令一失败、启动半路抛错，退出就已经死了——不必等到 webview 崩。
- WebView2 浏览器进程消失后，宿主窗和页面壳都还在，表现为纯白；Tauri 2.12.5 没有 `ProcessFailed` 之类的回调可以监听，页面内 JS 也已随之消失，`setInterval` 心跳发不出来。
- 事故时生产环境**一行日志都没有**：`log_path` 只在测试模式（`--test`）下写 `widget.log`，正式运行走 `eprintln!` 到不存在的控制台。事后只能靠 `udf\EBWebView\Default\settings_diagnostic.log` 反推，末行停在 21:08:21 的 `PrefStore write completed`，Crashpad 也没有对应 dump——死因至今不明。
- 重启无效的次生原因：进程没退，单实例守卫（当时还是命名互斥体 `Zwx_DesktopTodoWidget_Mutex`）仍在，新的双击直接 `exit(0)` 退出，用户看到的是「双击彻底没反应」。
- 强制结束进程是安全的：`write_md_file` 一直是原子写（`{path}.todo_tmp` + rename），强退不会写坏清单。

## Decision

1. **退出不再依赖 JS**。`request_exit(app)` 先问一句「JS 还活着吗」——`js_is_alive = js_ready && 最近心跳 < 2.5s`。活着就把 `app-exit-request` 交给它（照旧能提交编辑、写盘、`exit_app`），并在 2.5s 后兜底；不活就立刻 `force_exit`。托盘退出、Alt+F4、任务栏关闭三条路都走这一个入口。
2. **兜底必须真的能退**。`force_exit` = `write_config` → `app.exit(0)` → 再起一个线程等 2.5s，还没退就 `std::process::exit(0)`。主线程若卡在 Win32 调用里，`app.exit(0)` 只会排队，所以后手不可省。
3. **白屏自愈分两级：先 reload，再重启进程**。`app.js` 在模块顶层就 `setInterval(1s)` 发 `heartbeat`（不等 `boot()` 走完，boot 卡住也还算活），`boot()` 收尾再发一次 `ready:true`。Rust 侧 `spawn_watchdog` 每秒看一眼：`js_ready` 之后只看心跳间隔（超 20s），之前看 `shown_at`（超 12s），超时就 `win.reload()`，最多 3 次。
4. **reload 救不回来就重启一个新实例，但只允许一次**。实测（见下）：WebView2 的浏览器进程被杀之后，`reload()` 返回 `Ok` 却永远不会再加载页面——这正是 2026-11-13 那台机器的状态。于是 reload 用满 3 次仍白屏时，写一个 `widget.restart` 标记、直接 spawn 自己（带 `--wait-mutex`，`CREATE_NO_WINDOW | DETACHED_PROCESS`），然后退出。新实例启动时若看到该标记，说明「重启后还是白屏」，就只自救 reload、不再连环重启；页面成功加载（`on_page_load` Finished 或心跳 `ready:true`）时删掉标记，下次白屏仍可自救。
5. **单实例守卫从命名互斥体换成独占文件锁**。互斥体名字对象会被孤儿 `msedgewebview2.exe` 子进程继承着（WebView2 拉起浏览器进程时开了句柄继承）：老进程退出后锁名还在，自动重启的新实例等满 8 秒仍看到「已存在」就静默自杀，重启等于白做。现在锁的是 exe 旁的 `widget.lock`（`CreateFileW`，share=0，句柄故意留到进程结束）——文件句柄不可继承，进程一退内核就放锁。
6. **`app-exit-request` 监听移到 `boot()` 第一行**，在 `app_info` 之前。启动链路任何一步失败，退出仍然可用。
7. **日志常开**。正式运行写 exe 旁 `widget.log`（测试模式仍在 md 旁边），启动时超过 200KB 清空，只留本次运行。
8. **建窗失败要说人话**。主窗 `build()` 失败（udf 被占、运行时损坏）不再 `?` 出 panic 静默死，而是写日志 + 弹框 + `exit(1)`；面板建失败只记日志，主窗照常。

## Considered Options

- **只修「退出」把 JS 兜住**：白屏仍然只能靠杀进程，用户看到白屏还是得来找我。否。
- **看门狗直接重启整个进程**：能治白屏，但会吞掉未落盘的编辑，且互斥体需要先释放。改成「reload 三次都失败才重启，且每次运行只重启一次、成功加载后重置」，只在白屏已确认发生时付这个代价。部分采纳。
- **用 `PageLoadEvent::Finished` 当唯一存活信号**：页面崩掉后不会再有新事件，但「加载过」这件事一直是 true，无法判断「现在还有没有心跳」。只当第二个信号源用，不当主判据。否（单用）。
- **在生产里关掉日志省事**：正相反，这次事故最缺的就是日志。否。
- **继续把退出挂在 JS 上，只把监听提前**：能治「boot 抛错」，治不了「webview 进程没了」——而这次正是后者。否。
- **把命名互斥体标成不可继承（`SECURITY_ATTRIBUTES.bInheritHandle = 0`）**：试过，没用——WebView2 起浏览器进程时是自己开句柄继承的，锁名仍然被孤儿进程续着。改用文件锁。否。
- **自动重启绕 `cmd.exe /C ping -n 2 … & start`**：Rust 给 cmd 加引号的规则和 cmd 自己的解析撞车，实测那条命令根本没被解析成 `start`，静默失败。改成直接 spawn + `--wait-mutex`。否。

## Consequences

- 白屏从「只能杀进程」变成「先自己 reload 三次，不行就把自己重启一遍」；页面崩到 3 次仍未恢复时最多自动重启一次进程，重启后仍白屏则只留日志，用户仍可正常退出、手动重开。
- 自动重启会丢掉未落盘的编辑（`commitPending` 之前那段），这是白屏已确认时的既成损失——那时 JS 已死，编辑本来就无法提交。
- 实测记录（2026-11-13 22:45，本机）：对运行中的实例 `Stop-Process` 掉其唯一子进程 `msedgewebview2.exe`，日志依次出现 `ui silent 20s (page loaded = true) -> reload #1`、`ui silent 12s -> reload #2`、`-> reload #3`，随后 `3 reloads did not help` → `restart: spawning …` → 新实例 1 秒后打印 `desktop mode` / `page load finished` / `ui ready (boot finished)`，`widget.restart` 标记已被删除 → 白屏确实能自愈，且旧实例退出后新实例 1 秒内接管。
- 退出最多多等 2.5 秒才硬退；JS 正常时的行为完全不变（照旧先提交编辑再退）。
- `widget.log` 与 `widget.lock` 会常年存在（exe 旁），日志有 200KB 上限；此前「生产零日志」的假设作废。
- 主窗建不起来时现在会弹框说明原因，而不是静默消失——用户至少知道发生了什么。
- 单实例行为与旧版一致（第二次双击立刻退出）；区别是锁不再被孤儿 webview 进程续命，所以「进程没了但双击没反应」不会再发生。
- 与 0.2.7 的差异都属增强（多等 2.5s、多出日志文件、新建窗失败会弹框），不改任何清单读写语义，`app/PARITY.md` 不需要新增偏离条目。
