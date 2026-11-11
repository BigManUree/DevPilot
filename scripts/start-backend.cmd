@echo off
rem DevPilot backend launcher (detached, session-safe)
rem Usage: scripts\start-backend.cmd [port]
rem Notes:
rem - Kills any existing listener on the port first (idempotent restart).
rem - Drops lowercase proxy vars that break child env on some hosts.

setlocal
cd /d "%~dp0\..\apps\backend"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=37100"
set "DEVIPILOT_BACKEND_PORT=%PORT%"

rem Remove duplicate lowercase proxy vars (case-insensitive hosts choke on both cases)
set "http_proxy="
set "https_proxy="

rem Find and kill existing listener (PowerShell one-liner; ignore errors)
powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction Stop; Stop-Process -Id $c[0].OwningProcess -Force -Confirm:$false } catch {}"

start "devpilot-backend" /min node dist\main.js

rem Wait for health
set /a tries=0
:waitloop
ping -n 2 127.0.0.1 >nul
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/v1/health' -UseBasicParsing -TimeoutSec 2).Content; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 goto ok
set /a tries+=1
if %tries% lss 10 goto waitloop
echo [devpilot] backend did not become healthy on port %PORT% within 10s 1>&2
exit /b 1
:ok
echo [devpilot] backend healthy on http://127.0.0.1:%PORT%/api/v1
endlocal
exit /b 0
