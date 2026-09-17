@echo off
chcp 65001 >nul
echo.
echo ========================================
echo   智投看盘 - 后端服务启动脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 检查依赖...
if not exist "node_modules" (
    echo 正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败，请检查网络连接或手动运行 npm install
        pause
        exit /b 1
    )
) else (
    echo 依赖已就绪
)

echo.
echo [2/2] 启动服务...
echo.
call npm start

pause
