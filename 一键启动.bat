@echo off
setlocal
cd /d "%~dp0"
set "DEPLOY_MODE=lan"

echo [1/4] Check Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 18+ from https://nodejs.org/
  pause
  exit /b 1
)

echo [2/4] Check npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo npm not found. Reinstall Node.js and enable PATH.
  pause
  exit /b 1
)

echo [3/4] Install dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo [3.5/4] Ensure old server process is stopped...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":3180 .*LISTENING"') do (
  echo Stop old process PID=%%p
  taskkill /PID %%p /F >nul 2>nul
)
timeout /t 1 >nul

set "LAN_IP="
for /f %%i in ('node -e "const os=require('os');const isBad=(ip)=>!ip||ip==='0.0.0.0'||ip.startsWith('127.')||ip.startsWith('169.254.')||ip.startsWith('198.18.')||ip.startsWith('198.19.');const isPri=(ip)=>ip.startsWith('10.')||ip.startsWith('192.168.')||(()=>{const m=ip.match(/^172\.(\d+)\./);return m&&Number(m[1])>=16&&Number(m[1])<=31;})();for(const list of Object.values(os.networkInterfaces())){for(const it of (list||[])){if(!it||it.family!=='IPv4'||it.internal) continue;const ip=String(it.address||'');if(isBad(ip)) continue;if(isPri(ip)){process.stdout.write(ip);process.exit(0);}}}"') do set "LAN_IP=%%i"
echo(%LAN_IP%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul || set "LAN_IP="

if defined LAN_IP (
  set "PUBLIC_BASE_URL=http://%LAN_IP%:3180"
) else (
  set "PUBLIC_BASE_URL=http://localhost:3180"
)

echo Deploy mode: %DEPLOY_MODE%
echo Base URL: %PUBLIC_BASE_URL%

echo [4/4] Start server...
start "" "%PUBLIC_BASE_URL%/"
echo Home opened: %PUBLIC_BASE_URL%/
echo Server running in current window. Keep this window open.
echo If page is blank, wait 2-3 seconds and refresh.
set "PUBLIC_BASE_URL=%PUBLIC_BASE_URL%"
set "DEPLOY_MODE=%DEPLOY_MODE%"
npm start
endlocal
