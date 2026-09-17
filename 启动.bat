@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ========================================
echo   智投看盘 - 启动
echo   当前目录: %CD%
echo ========================================
echo.

if not exist "package.json" (
  echo [错误] 未找到 package.json，请确认在本项目根目录运行本脚本。
  pause
  exit /b 1
)

REM 若服务已在跑且健康，直接打开页面，避免 EADDRINUSE
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo [提示] 服务已在运行（端口 3000），无需重复启动。
  echo 正在打开看板...
  start "" "http://localhost:3000/market-dashboard.html"
  echo.
  echo 地址: http://localhost:3000/market-dashboard.html
  pause
  exit /b 0
)

REM 端口被占但健康检查失败：释放后重启
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; foreach ($c in $conns) { $id = $c.OwningProcess; if ($id -and $id -ne 0) { Write-Host ('释放占用端口的进程 PID=' + $id); Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }" 2>nul

if not exist "node_modules\" (
  echo [1/2] 安装依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败
    pause
    exit /b 1
  )
) else (
  echo [1/2] 依赖已就绪
)

echo [2/2] 启动服务 http://localhost:3000
echo 前端: http://localhost:3000/market-dashboard.html
echo.
start "" "http://localhost:3000/market-dashboard.html"
call npm start
pause
