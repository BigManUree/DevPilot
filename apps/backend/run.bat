@echo off
setlocal

rem 使用项目自带虚拟环境的 python 启动 uvicorn
set "PY=.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

rem host/port 提供默认值，避免展开成空字符串导致 uvicorn 参数无效
if not defined HOST set "HOST=0.0.0.0"
if not defined PORT set "PORT=8000"

"%PY%" -m uvicorn app.main:app --host %HOST% --port %PORT%

endlocal
