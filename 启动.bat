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
call npm start
pause
