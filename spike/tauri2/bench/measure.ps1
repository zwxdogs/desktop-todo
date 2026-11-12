# bench/measure.ps1 — spike 启动耗时 + 空闲内存测量（进程树全量）。
# 用法: powershell -File measure.ps1 [-Exe path] [-Runs 5]
# 方法: 与 docs/research/tauri-electron-flutter.md 的基准对齐——
#   启动 = 进程创建到主窗口句柄出现（10ms 轮询）；内存 = idle 3s 后进程树
#   （exe + 全部 msedgewebview2 子进程）的 PrivateMemorySize64 / WorkingSet64 之和。
param(
  [string]$Exe = 'E:\项目\desktop-todo\spike\tauri2\src-tauri\target\release\desktop-todo-spike.exe',
  [int]$Runs = 5
)

$task = 'DSH_Spike_Bench'
# 直接以 exe 作为任务 action（cmd 包 start 会被任务计划回收整棵树——实测教训）。
# 文件读取走 exe 旁 sample.md 的 fallback，不需要环境变量。
$action = New-ScheduledTaskAction -Execute $Exe
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

function Stop-Tree {
  Get-Process desktop-todo-spike -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 600
}

function Measure-One {
  Start-ScheduledTask -TaskName $task
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $seen = $null
  while ($sw.ElapsedMilliseconds -lt 15000) {
    $p = Get-Process desktop-todo-spike -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { $seen = $p; break }
    Start-Sleep -Milliseconds 10
  }
  $elapsed = $sw.ElapsedMilliseconds
  if (-not $seen) { Write-Output 'FAIL: window never appeared'; return $null }
  Start-Sleep -Seconds 3   # idle 窗口期
  $root = Get-Process desktop-todo-spike -ErrorAction SilentlyContinue
  # webview2 子进程的命令行里带 spike exe 的用户数据目录，据此圈定进程树
  $kids = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*desktop-todo-spike*' }
  $all = @($root)
  foreach ($k in $kids) { $p2 = Get-Process -Id $k.ProcessId -ErrorAction SilentlyContinue; if ($p2) { $all += $p2 } }
  $priv = ($all | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
  $ws = ($all | Measure-Object WorkingSet64 -Sum).Sum / 1MB
  Write-Output ("run: start={0}ms private={1:N1}MB ws={2:N1}MB procs={3}" -f $elapsed, $priv, $ws, $all.Count)
  return [pscustomobject]@{ ms = $elapsed; priv = $priv; ws = $ws; procs = $all.Count }
}

Write-Output '=== cold-ish (首次启动) ==='
$cold = Measure-One
Stop-Tree

$results = @()
Write-Output ("=== hot x{0} ===" -f $Runs)
for ($i = 0; $i -lt $Runs; $i++) {
  $r = Measure-One
  if ($r) { $results += $r }
  Stop-Tree
}
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue

if ($results.Count) {
  $med = $results.ms | Sort-Object | Select-Object -Index ([int][math]::Floor(($results.Count - 1) / 2))
  $mp = ($results.priv | Measure-Object -Average).Average
  $mw = ($results.ws | Measure-Object -Average).Average
  Write-Output ('=== hot: start_median={0}ms private_avg={1:N1}MB ws_avg={2:N1}MB ===' -f $med, $mp, $mw)
  if ($cold) { Write-Output ('cold-ish: start={0}ms private={1:N1}MB ws={2:N1}MB' -f $cold.ms, $cold.priv, $cold.ws) }
}
