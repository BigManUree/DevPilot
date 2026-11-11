@echo off
rem DevPilot backend daemon entry (used by Task Scheduler, TN=DevPilotBackend)
rem Rolls logs to %APPDATA%\devpilot\data\logs\backend-daemon.log

setlocal
cd /d "%~dp0\..\apps\backend"

set "http_proxy="
set "https_proxy="

set "LOGDIR=%APPDATA%\devpilot\data\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo [%date% %time%] devpilot backend starting >> "%LOGDIR%\backend-daemon.log"
node dist\main.js >> "%LOGDIR%\backend-daemon.log" 2>&1
echo [%date% %time%] devpilot backend exited code=%errorlevel% >> "%LOGDIR%\backend-daemon.log"
endlocal
