@echo off
REM 远程控制网关的 Windows 启动入口。
REM
REM   run.bat             启动控制台（带窗口 + 托盘）
REM   run.bat start       后台启动服务（无控制台）
REM   run.bat stop        停止后台服务
REM   run.bat status      查看状态
REM   run.bat --server    前台运行服务（调试）
REM
REM 依赖：Node.js（必须）、Python 3（控制台需要，Windows 上自带 tkinter；
REM       PIL 可选 —— 缺失时托盘图标回退为系统图标）。

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
where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Python。控制台需要 Python 3 与 tkinter。
  echo        也可用 "run.bat --server" 只启动服务。
  pause
  exit /b 1
)
python "console\console.py" %*
goto :eof

:svc_start
REM 用 wscript 让 node 完全脱离当前控制台，避免关掉窗口就终止服务
start "" /b cmd /c "node server.js %* >> ""%TEMP%\remote-hub.log"" 2>&1"
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
node server.js %*
goto :eof
