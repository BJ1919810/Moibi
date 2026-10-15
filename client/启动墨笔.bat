@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   墨笔 . AI 小说创作坊
echo   ================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js。请先安装 Node 20 或更高版本。
  echo   下载地址： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo   首次运行，正在构建界面，请稍候...
  call npm run build
  if errorlevel 1 (
    echo   [错误] 界面构建失败。请检查是否执行过 npm install。
    pause
    exit /b 1
  )
)

echo   正在启动服务，浏览器会自动打开。
echo   手机访问请用下面列出的「手机」地址，需与本机同一 WiFi。
echo   关闭这个窗口即停止服务。
echo.

start "" http://127.0.0.1:8787
node server\index.js

echo.
echo   服务已停止。
pause
