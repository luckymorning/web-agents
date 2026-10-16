@echo off
REM 远程控制网关启动入口（Windows）。
REM
REM   run.bat             启动图形控制台（推荐）
REM   run.bat start       后台启动服务（无界面）
REM   run.bat stop        停止后台服务
REM   run.bat status      查看状态
REM   run.bat --server    前台运行服务（调试）
REM
REM 依赖说明
REM   源码运行需要 Electron（npm install 安装）；安装包（exe）已内置运行时，
REM   双击即用，不需要 Node.js、Python 或任何其它组件。
REM
REM 默认监听 0.0.0.0（允许局域网访问）。此服务等同于本机 shell 权限，
REM 因此非回环监听时强制要求访问令牌（缺失会自动生成并写入配置文件）。
REM 只想本机访问时用：run.bat start --host 127.0.0.1

setlocal
cd /d "%~dp0"

if "%~1"=="" goto console
if /i "%~1"=="--console" goto console
if /i "%~1"=="start" goto svc_start
if /i "%~1"=="stop" goto svc_stop
if /i "%~1"=="status" goto svc_status
if /i "%~1"=="--server" goto server
goto server_args

:console
if exist "node_modules\.bin\electron.cmd" (
  "node_modules\.bin\electron.cmd" .
  goto :eof
)
echo [错误] 未找到 Electron，无法启动图形控制台。
echo        源码运行请先执行：npm install
echo        或改用无界面模式：run.bat start
echo        或安装发行包（已内置运行时，无需任何依赖）
pause
exit /b 1

:svc_start
start "" /b cmd /c "node server.mjs %* >> ""%TEMP%\remote-hub.log"" 2>&1"
echo 已启动服务，日志: %TEMP%\remote-hub.log
goto :eof

:svc_stop
echo 正在停止占用 8790 端口的服务进程…
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8790" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>nul
)
echo 已停止
goto :eof

:svc_status
netstat -ano | findstr ":8790" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo not running
) else (
  echo running
  curl -s http://127.0.0.1:8790/api/health
  echo.
)
goto :eof

:server
shift
:server_args
node server.mjs %*
goto :eof
