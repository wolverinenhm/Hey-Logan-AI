@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules\selfsigned\index.js" (
  echo.
  echo   Dependencies are not installed yet. Run install.cmd first.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Hey AI Bridge...
echo   Keep this window open while you use the app.
echo   Press Ctrl+C to stop.
echo.

node server\index.js %*

echo.
echo   The bridge has stopped.
pause
