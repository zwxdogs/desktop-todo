---
status: accepted
date: 2026-11-13
---

# 📌 按钮改语义：点亮 = 固定在桌面，不点亮 = 普通窗口

> _相关：[ADR-0003](0003-migrate-to-tauri2.md) 迁移到 Tauri 2（本 ADR 改写了它的「主窗口进任务栏」一项）；[ADR-0005](0005-lift-tk-parity.md) 解除「与 Tk 0.2.7 完全一致」的对等约束——本 ADR 的 📌 语义改写发生在解除之前，按当时的约束作为有意偏离记入 `app/PARITY.md` §3-2。_

0.2.7 起，标题栏 📌 控制的是「贴桌面 / 悬浮置顶」两态：点亮 = 悬浮置顶（`topmost`），不点亮 = 固定在桌面（`always_on_bottom` + `HWND_BOTTOM`）。这个语义有一半没人用——用户从不悬浮置顶，却每天要点一次"取消"才能回到能正常输入的状态；而"固定在桌面"时任务栏里没有任何入口，想加一条待办得先 Alt+Tab 或去双击 exe。

2026-11-13 用户定稿改成两态：**点亮 = 固定在桌面；不点亮 = 普通窗口**，并且**置顶功能整体下线**（两种模式都不再出现 `topmost`）。

- **固定在桌面**：桌面图标之上、所有应用窗口之下；任务栏没有图标；Alt+Tab 里也没有它。
- **普通窗口**：正常 z 序；任务栏有图标；Alt+Tab 里有它。用户点任务栏图标即可把窗口调到前面加待办。
- **默认普通窗口**：没有 `config.json` 的新装用户第一次启动就是普通窗口（老 config 里 `docked=true` 的继续固定在桌面，不迁移）。
- **固定在桌面时靠托盘唤回**：托盘图标两种模式下都在，tooltip「桌面待办」，左键 = 切回普通窗口并置前，右键 = 「显示待办 / 固定在桌面（勾选态=当前模式）/ 退出」。不做「隐藏到托盘」。
- **✕ 仍是退出程序**（托盘一起消失）；详情面板继续 `topmost`（面板是临时浮层，与主窗口语义无关）。

## Considered Options

- **保留"悬浮置顶"作为第三态**：多一个状态没人用，还要在 UI 上解释三者关系。否决。
- **固定在桌面时隐藏窗口，靠任务栏图标唤回**：任务栏本来就没有图标，等于没有唤回入口。否决。
- **第二次双击 exe 唤起已有实例**（替代托盘）：要放弃互斥体静默 `exit(0)` 的现有行为，且用户明确要的是"任务栏里能点开"，不是"再双击一次"。否决。
- **托盘 + 两态 + 默认普通窗口**：托盘补上固定在桌面时唯一缺失的入口；默认普通窗口让"加待办"成为第一路径。选中。（切换模式时曾靠「隐藏 → 落样式 → 显示」让 shell 重算任务栏与 Alt+Tab 归属，代价是整窗闪一下；2026-11-13 已改为就地落样式，见 Consequences 末条。）

## Consequences

- `app/src-tauri/src/main.rs`：`set_docked` 收敛为 `set_docked_state`（落状态 → 落窗口样式 → 同步托盘勾选 → 存盘 → 广播 `dock-changed`）；`dock_style(docked)` 是纯函数（`always_on_bottom` / `always_on_top` / `toolwindow` / `skip_taskbar` 四个开关），配 `cargo test` 守住「两种模式都不 topmost」。`WS_EX_APPWINDOW` 由 `set_ex_flags` 与 `WS_EX_TOOLWINDOW` 互斥维护：tao 建窗时给了 APPWINDOW，两者并存时它会盖过 TOOLWINDOW 把任务栏按钮撑回来。
- 固定在桌面 = `WS_EX_TOOLWINDOW`（挡 Alt+Tab 与任务栏按钮重生）+ `ITaskbarList::DeleteTab`（拿掉已有按钮）+ `pin_bottom`；普通窗口 = 清掉这四样，其中清 `ALWAYS_ON_BOTTOM` 必须在其它 `SetWindowPos` 之前（tao 的 `WM_WINDOWPOSCHANGING` 会把它改写成 `HWND_BOTTOM`）。
- 样式必须**在窗口显示之后**再落一遍：首次 `ShowWindow` 会按建窗时的 exstyle 重算一遍，显示前设的 `TOOLWINDOW` 会被抹掉（实测：显示前设的被覆盖，显示后设的稳定）。所以启动序列是「落样式 → `show()` → 再落一次样式」，面板 `panel_open` 同理。
- 托盘菜单项的 `set_checked` 走 `run_on_main_thread` 并阻塞等待，在主线程（命令/托盘回调）里调用会死锁，因此所有托盘动作都丢到独立线程执行。
- `poll_tick` 的"贴桌面维持 / Win+D 还原"只在固定在桌面时生效；普通窗口跟着 Win+D 一起收走（这是普通窗口该有的样子）。
- `Cargo.toml` 打开 `tauri/tray-icon`；托盘位图取 exe 内嵌图标资源（`app.default_window_icon()`），不开 `image-png`。
- 按钮、托盘勾选态、`dock-changed` 广播三者共用一个真相源：Rust 的 `Shared.docked`。前端不再自己翻转算终态。
- **切换两态不再 hide/show（2026-11-13 修正，[#8](https://github.com/zwxdogs/desktop-todo/issues/8)）**：原来的「隐藏 → 落样式 → 显示 → 再落一次」就是用户看到的整窗闪烁。现在 `set_docked_state` 就地落样式，`apply_docked` 的顺序固定为「tao 旗子（`set_always_on_bottom` / `set_always_on_top`）→ `set_ex_flags`（TOOLWINDOW/APPWINDOW）→ `set_skip_taskbar`（`ITaskbarList`）→ 固定在桌面时 `pin_bottom`」。两条顺序理由：tao 的 `set_window_flags` 在 diff 非空时按它内部的 `WindowFlags` 整份重写 `GWL_STYLE`/`GWL_EXSTYLE`（`window_state.rs` 的 `apply_diff` → `to_window_styles`，`ON_TASKBAR` 时补回 `WS_EX_APPWINDOW`），所以手工位必须排在 tao 旗子之后，否则 TOOLWINDOW 被抹掉；`SWP_FRAMECHANGED` 会把窗口提到最前，压底必须排在最后。任务栏与 Alt+Tab 归属由 `ITaskbarList::DeleteTab/AddTab` + `SWP_FRAMECHANGED` 让 shell 重算，不需要隐藏窗口。实测（TEST_MODE + UIA 点 📌 + `SetWinEventHook` 监听 `EVENT_OBJECT_SHOW`/`EVENT_OBJECT_HIDE`）：`ex=0x190 ↔ 0x40110` 双向正确，两次切换的 hide/show 事件都是 0 次、窗口全程 `IsWindowVisible`；任务栏条目（UIA：普通窗口有 `DesktopTodo - 1 个运行窗口`，固定在桌面没有）与 z 序（固定在桌面时紧贴 `Progman` 之上）都与 hide/show 版本一致。
