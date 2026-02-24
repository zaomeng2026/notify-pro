@echo off
setlocal
cd /d "%~dp0"

if "%PUBLIC_BASE_URL%"=="" (
  echo [error] PUBLIC_BASE_URL is empty.
  echo Please set it first, example:
  echo   set PUBLIC_BASE_URL=https://pay.example.com
  echo   set MYSQL_URL=mysql://user:pass@127.0.0.1:3306/notify_pro?charset=utf8mb4
  pause
  exit /b 1
)

if "%MYSQL_URL%"=="" (
  echo [error] MYSQL_URL is empty for cloud mode.
  pause
  exit /b 1
)

set "DEPLOY_MODE=cloud"
echo DEPLOY_MODE=%DEPLOY_MODE%
echo PUBLIC_BASE_URL=%PUBLIC_BASE_URL%

call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

npm run start:cloud
endlocal
