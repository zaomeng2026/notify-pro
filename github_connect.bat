@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "GIT_EXE=C:\Program Files\Git\cmd\git.exe"
if not exist "%GIT_EXE%" (
  echo Git not found at: %GIT_EXE%
  echo Please install Git first.
  pause
  exit /b 1
)

if "%~1"=="" (
  set /p REPO_URL=Input GitHub repo URL (example: https://github.com/yourname/notify-pro.git): 
) else (
  set "REPO_URL=%~1"
)

if "%REPO_URL%"=="" (
  echo Repo URL is empty.
  pause
  exit /b 1
)

for /f "usebackq delims=" %%a in (`"%GIT_EXE%" rev-parse --is-inside-work-tree 2^>nul`) do set IN_REPO=%%a
if /i not "!IN_REPO!"=="true" (
  "%GIT_EXE%" init
  "%GIT_EXE%" branch -M main
)

"%GIT_EXE%" config user.name >nul 2>nul
if errorlevel 1 "%GIT_EXE%" config user.name "notify-pro-owner"
"%GIT_EXE%" config user.email >nul 2>nul
if errorlevel 1 "%GIT_EXE%" config user.email "notify-pro-owner@local"

"%GIT_EXE%" add .
"%GIT_EXE%" diff --cached --quiet
if errorlevel 1 (
  "%GIT_EXE%" commit -m "chore: update project"
)

"%GIT_EXE%" remote get-url origin >nul 2>nul
if errorlevel 1 (
  "%GIT_EXE%" remote add origin "%REPO_URL%"
) else (
  "%GIT_EXE%" remote set-url origin "%REPO_URL%"
)

"%GIT_EXE%" push -u origin main
if errorlevel 1 (
  echo Push failed. Check credentials or repo URL.
  pause
  exit /b 1
)

echo Done. Repository connected and pushed.
pause
exit /b 0
