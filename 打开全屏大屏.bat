@echo off
setlocal
if defined PUBLIC_BASE_URL (
  set "URL=%PUBLIC_BASE_URL%/"
) else (
  set "LAN_IP="
  for /f %%i in ('powershell -NoProfile -Command "$cfg=Get-NetIPConfiguration ^| Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq \"Up\" -and $_.IPv4Address }; $ip=$null; if($cfg){$ip=($cfg ^| Select-Object -First 1).IPv4Address.IPAddress}; if(-not $ip){$ip=(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.IPAddress -like \"192.168.*\" -or $_.IPAddress -like \"10.*\" -or $_.IPAddress -like \"172.1[6-9].*\" -or $_.IPAddress -like \"172.2[0-9].*\" -or $_.IPAddress -like \"172.3[0-1].*\"} ^| Select-Object -First 1 -ExpandProperty IPAddress)}; if($ip){Write-Output $ip}"') do set "LAN_IP=%%i"
  if defined LAN_IP (
    set "URL=http://%LAN_IP%:3180/"
  ) else (
    set "URL=http://localhost:3180/"
  )
)

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk "%URL%"
  exit /b 0
)

if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --kiosk "%URL%"
  exit /b 0
)

if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk "%URL%"
  exit /b 0
)

if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --kiosk "%URL%"
  exit /b 0
)

start "" "%URL%"
echo Browser opened with default app: %URL%
endlocal
