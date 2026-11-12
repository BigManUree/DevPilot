@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0..\apps\desktop"

echo [1/3] 清理旧的打包目录...
for %%d in (release release2 release3 release4 release5 release6 release7 release8 release9 release10 release11 release12) do (
  if exist "%%d" (
    rd /s /q "%%d" >nul 2>&1
    if exist "%%d" (
      echo     !! 无法删除 %%d —— 仍有进程占用（请完全退出 WorkBuddy 后重试）
      echo.
      pause
      exit /b 1
    )
  )
)

echo [2/3] 将 release_next 落位为 release...
if not exist "release_next" (
  echo     !! 找不到 release_next，请先重新打包
  pause
  exit /b 1
)
if exist "release" (
  echo     !! release 目录仍存在，说明旧文件仍被占用
  pause
  exit /b 1
)
move "release_next" "release" >nul
if not exist "release\win-unpacked\DevPilot.exe" (
  echo     !! 落位失败
  pause
  exit /b 1
)

echo [3/3] 完成
echo.
echo     可执行文件： "%CD%\release\win-unpacked\DevPilot.exe"
echo.
pause
