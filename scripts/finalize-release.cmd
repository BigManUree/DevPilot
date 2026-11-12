@echo off
setlocal
cd /d "%~dp0..\apps\desktop"

echo [1/3] Removing old build folders...
for %%d in (release release2 release3 release4 release5 release6 release7 release8 release9 release10 release11 release12) do (
  if exist "%%d" rd /s /q "%%d"
)

if exist "release" (
  echo [FAIL] release is still locked. Quit WorkBuddy completely, then run again.
  pause
  exit /b 1
)

echo [2/3] Renaming release_next to release...
if not exist "release_next" (
  echo [FAIL] release_next not found. Build first.
  pause
  exit /b 1
)
move "release_next" "release"

echo [3/3] Done.
if exist "release\win-unpacked\DevPilot.exe" (
  echo EXE: %CD%\release\win-unpacked\DevPilot.exe
) else (
  echo [FAIL] EXE missing.
)
pause
