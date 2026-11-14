//! 屏幕几何：矩形、夹回屏内、面板落点。纯算术，不碰 Win32（屏幕矩形由调用方传进来）。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

/// 把窗口左上角夹回屏内（client 语义：传入的是窗口内容区的原点与尺寸）。
pub fn clamp(pos: (i32, i32), size: (i32, i32), screen: Rect) -> (i32, i32) {
    (
        screen.x.max(pos.0.min(screen.right() - size.0)),
        screen.y.max(pos.1.min(screen.bottom() - size.1)),
    )
}

/// 面板落点：优先主窗右侧，右侧放不下放左侧，再贴虚拟屏右缘；y 对齐主窗并夹回屏内。
pub fn panel_pos(main: Rect, panel: (i32, i32), gap: i32, screen: Rect) -> (i32, i32) {
    let mut px = main.right() + gap;
    if px + panel.0 > screen.right() {
        px = main.x - panel.0 - gap;
    }
    if px < screen.x {
        px = (screen.right() - panel.0 - gap).max(screen.x);
    }
    let py = screen.y.max(main.y.min(screen.bottom() - panel.1 - gap));
    (px, py)
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    fn screen() -> Rect {
        Rect::new(0, 0, 1920, 1080)
    }

    #[test]
    fn clamp_pulls_a_strayed_window_back_on_screen() {
        // 拖过头 / 显示器热插拔 / 改分辨率：三种都会把窗口留在屏外
        assert_eq!(clamp((500, 300), (400, 600), screen()), (500, 300), "屏内原样");
        assert_eq!(clamp((-999, 300), (400, 600), screen()), (0, 300), "左出界");
        assert_eq!(clamp((5000, 300), (400, 600), screen()), (1520, 300), "右出界按右缘夹");
        assert_eq!(clamp((500, -50), (400, 600), screen()), (500, 0), "上出界");
        assert_eq!(clamp((500, 9999), (400, 600), screen()), (500, 480), "下出界按下缘夹");
    }

    #[test]
    fn clamp_respects_a_negative_origin_virtual_screen() {
        // 副屏在主屏左边时虚拟桌面 x 为负，夹取必须按虚拟桌面而不是 0
        let vs = Rect::new(-1920, 0, 3840, 1080);
        assert_eq!(clamp((-1800, 100), (400, 600), vs), (-1800, 100));
    }

    #[test]
    fn panel_sits_right_of_the_main_window_when_there_is_room() {
        let main = Rect::new(100, 100, 400, 600);
        assert_eq!(panel_pos(main, (420, 520), 12, screen()), (512, 100));
    }

    #[test]
    fn panel_flips_to_the_left_when_the_right_edge_is_full() {
        let main = Rect::new(1400, 100, 400, 600);
        assert_eq!(panel_pos(main, (420, 520), 12, screen()), (968, 100));
    }

    #[test]
    fn panel_clamps_to_the_screen_edge_and_aligns_y() {
        // 两边都放不下时贴右缘，且不留 gap 之外的越界
        let main = Rect::new(400, 100, 1100, 600);
        let (px, py) = panel_pos(main, (420, 520), 12, screen());
        assert_eq!(px, 1920 - 420 - 12);
        assert_eq!(py, 100);
        // 主窗贴底时 y 被夹回来，面板不越出下缘
        let low = Rect::new(100, 1000, 400, 600);
        let (_, py) = panel_pos(low, (420, 520), 12, screen());
        assert_eq!(py, 1080 - 520 - 12);
    }

    #[test]
    fn clamp_is_idempotent_so_the_rescue_stops_moving_the_window() {
        // 2026-11-14 实测到的活 bug：救援用 set_position（outer 语义）落点、却用 inner 原点夹取，
        // 被夹回右缘的窗口每轮又差 26×15 像素，日志里每秒一条 rescued。夹取本身必须收敛——
        // 只要落点用 client 语义（win32::set_client_position），第二次判定就必然返回同一个点。
        let screen = Rect::new(-1920, 0, 3840, 1080);
        let size = (393, 648);
        for start in [(6000, 100), (-9999, 100), (500, 9999), (500, -9999), (1525, 374)] {
            let once = clamp(start, size, screen);
            assert_eq!(clamp(once, size, screen), once, "{:?} 救一次之后必须稳定", start);
            // 救完必须真的在屏内（否则「收敛」只是收敛到屏外）
            assert!(once.0 >= screen.x && once.0 + size.0 <= screen.right(), "{:?} 救完横向仍在屏外", start);
            assert!(once.1 >= screen.y && once.1 + size.1 <= screen.bottom(), "{:?} 救完纵向仍在屏外", start);
        }
    }
}
