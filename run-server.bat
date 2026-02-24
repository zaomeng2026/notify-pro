@echo off
setlocal
cd /d "%~dp0"

if not defined PUBLIC_BASE_URL (
  set "PUBLIC_BASE_URL="
)
if defined PUBLIC_BASE_URL (
  echo(%PUBLIC_BASE_URL%| findstr /R "^http://[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*:3180$ ^http://localhost:3180$" >nul || set "PUBLIC_BASE_URL="
)

if not defined PUBLIC_BASE_URL (
  set "LAN_IP="
  for /f %%i in ('node -e "const os=require('os');const isBad=(ip)=>!ip||ip==='0.0.0.0'||ip.startsWith('127.')||ip.startsWith('169.254.')||ip.startsWith('198.18.')||ip.startsWith('198.19.');const isPri=(ip)=>ip.startsWith('10.')||ip.startsWith('192.168.')||(()=>{const m=ip.match(/^172\.(\d+)\./);return m&&Number(m[1])>=16&&Number(m[1])<=31;})();for(const list of Object.values(os.networkInterfaces())){for(const it of (list||[])){if(!it||it.family!=='IPv4'||it.internal) continue;const ip=String(it.address||'');if(isBad(ip)) continue;if(isPri(ip)){process.stdout.write(ip);process.exit(0);}}}"') do set "LAN_IP=%%i"
  echo(%LAN_IP%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul || set "LAN_IP="
  if defined LAN_IP (
    set "PUBLIC_BASE_URL=http://%LAN_IP%:3180"
  ) else (
    set "PUBLIC_BASE_URL=http://localhost:3180"
  )
)
if defined PUBLIC_BASE_URL (
  echo(%PUBLIC_BASE_URL%| findstr /R "^http://198\.18\." >nul && set "PUBLIC_BASE_URL="
  echo(%PUBLIC_BASE_URL%| findstr /R "^http://198\.19\." >nul && set "PUBLIC_BASE_URL="
)
if not defined PUBLIC_BASE_URL (
  set "PUBLIC_BASE_URL=http://localhost:3180"
)

echo PUBLIC_BASE_URL=%PUBLIC_BASE_URL%
echo Display=%PUBLIC_BASE_URL%/
echo Admin=%PUBLIC_BASE_URL%/admin
npm start
