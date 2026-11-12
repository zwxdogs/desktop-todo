# bench/win32_checks.ps1 — 贴桌面/任务栏/Win+D 行为核验（spike 证据采集）。
# 先启动 spike exe，再运行本脚本。输出每项检查的 PASS/FAIL 与原始数据。
param([string]$TitlePart = '桌面待办 spike')

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  public const uint GW_HWNDPREV = 3;
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x80; public const int WS_EX_TOPMOST = 0x8; public const int WS_EX_APPWINDOW = 0x40000;
  public static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len == 0) return "";
    var sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static List<Tuple<IntPtr,string>> TopVisible() {
    var list = new List<Tuple<IntPtr,string>>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) list.Add(Tuple.Create(h, Title(h)));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$targets = [W]::TopVisible() | Where-Object { $_.Item2 -like "*$TitlePart*" }
if (-not $targets) { Write-Output 'FAIL: 找不到 spike 窗口'; exit 1 }
$me = $targets[0].Item1
$exstyle = [W]::GetWindowLong($me, [W]::GWL_EXSTYLE)

Write-Output ("[1] 窗口句柄 0x{0:X} 标题 '{1}'" -f $me.ToInt64(), $targets[0].Item2)
Write-Output ("[2] EXSTYLE=0x{0:X}  TOOLWINDOW(不进任务栏)={1}  TOPMOST={2}  APPWINDOW={3}" -f `
  $exstyle, [bool]($exstyle -band [W]::WS_EX_TOOLWINDOW), [bool]($exstyle -band [W]::WS_EX_TOPMOST), [bool]($exstyle -band [W]::WS_EX_APPWINDOW))

# Z 序：枚举表里排在我们后面的可见窗口（Z 序底部方向），理想状态只剩 Progman/WorkerW 桌面层
$after = @()
$seen = $false
foreach ($t in ([W]::TopVisible())) {
  if ($seen) { $after += $t }
  if ($t.Item1 -eq $me) { $seen = $true }
}
Write-Output ("[3] Z 序底部方向还有 {0} 个可见窗口:" -f $after.Count)
$after | Select-Object -First 6 | ForEach-Object { Write-Output ("    0x{0:X}  '{1}'" -f $_.Item1.ToInt64(), $_.Item2) }

# 桌面层紧贴检查：GetWindow(Progman, GW_HWNDPREV) == me（与 todo.pyw at_desktop_level 同判据）
$progman = [W]::FindWindow('Progman', $null)
$prev = [W]::GetWindow($progman, [W]::GW_HWNDPREV)
Write-Output ("[4] Progman 上方紧邻 = 0x{0:X}  (== 我: {1})" -f $prev.ToInt64(), ($prev -eq $me))

# Win+D 模拟：MinimizeAll -> 看是否被最小化 -> UndoMinimizeAll -> 是否回到桌面层
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Milliseconds 900
$minimized = [W]::IsIconic($me)
$stillVisible = [W]::IsWindowVisible($me)
Write-Output ("[5] Win+D(MinimizeAll): IsIconic={0} IsWindowVisible={1}" -f $minimized, $stillVisible)
$shell.UndoMinimizeAll()
Start-Sleep -Milliseconds 900
$back = [W]::TopVisible() | Where-Object { $_.Item1 -eq $me }
Write-Output ("[6] UndoMinimizeAll 后窗口可见: {0}" -f ([bool]$back))
$after2 = @(); $seen2 = $false
foreach ($t in ([W]::TopVisible())) { if ($seen2) { $after2 += $t }; if ($t.Item1 -eq $me) { $seen2 = $true } }
Write-Output ("[7] 恢复后 Z 序底部方向还有 {0} 个窗口（未压回桌面层则数量会更多）" -f $after2.Count)
$after2 | Select-Object -First 6 | ForEach-Object { Write-Output ("    0x{0:X}  '{1}'" -f $_.Item1.ToInt64(), $_.Item2) }

Write-Output '人工核验项（脚本测不了）: 任务栏按钮是否显示、点击行内编辑中文 IME 候选窗位置、双击编辑焦点。'
