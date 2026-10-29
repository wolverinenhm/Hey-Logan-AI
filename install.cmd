@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 20 or newer is required.
  echo   Install it from https://nodejs.org and run install.cmd again.
  echo.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Your Node.js is too old. Hey AI Bridge needs Node.js 20 or newer.
  node --version
  echo   Install the current LTS from https://nodejs.org and run install.cmd again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Hey AI Bridge - install
echo   -----------------------
echo.

echo [1/3] Installing dependencies...
call npm.cmd install --no-audit --no-fund --cache ".npm-cache"
if errorlevel 1 (
  echo.
  echo   npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo.
echo [2/3] Creating config, certificate and icons...
node scripts\setup.js
if errorlevel 1 (
  echo.
  echo   Setup step failed.
  pause
  exit /b 1
)

echo.
echo [3/3] Done.
echo.
echo   Start the bridge by double-clicking start.cmd
echo   Then open the Desktop URL shown in the console on this PC,
echo   and scan the QR code with your Android phone (same Wi-Fi).
echo.
pause
