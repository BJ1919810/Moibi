@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   墨笔 . 打包 Android APK
echo   ================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js。请先安装 Node 20 或更高版本。
  pause
  exit /b 1
)

if not exist "node_modules\@capacitor\cli" (
  echo   [错误] 缺少 Capacitor 依赖。请先在 mobi 目录执行：
  echo          npm install
  pause
  exit /b 1
)

echo   正在构建独立离线版 APK...
echo   步骤：构建前端 -^> 同步资源 -^> 编译 APK -^> 解包核对
echo.

node scripts\build-apk.mjs release
if errorlevel 1 (
  echo.
  echo   [失败] 打包未完成，请查看上面的报错。
  pause
  exit /b 1
)

echo   打包完成，产物在 outputs 目录。
echo.
pause
