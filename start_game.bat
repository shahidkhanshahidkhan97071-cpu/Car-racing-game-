@echo off
setlocal
cd /d "%~dp0"
title ASPHALT FOREST - game server
echo.
echo   ==========================================
echo     ASPHALT FOREST  -  starting the game...
echo   ==========================================
echo.
echo   The game opens in your browser (Chrome / Edge recommended).
echo   Keep this window open while you play. Close it to stop the game.
echo.

rem --- 1) Python (the real one, not the Microsoft Store stub) ---
python -c "import sys" >nul 2>nul
if %errorlevel%==0 (
  python tools\server.py
  goto :done
)
py -3 -c "import sys" >nul 2>nul
if %errorlevel%==0 (
  py -3 tools\server.py
  goto :done
)

rem --- 2) Node.js ---
node -v >nul 2>nul
if %errorlevel%==0 (
  node tools\server.js
  goto :done
)

rem --- 3) PowerShell (built into Windows) ---
echo   (Python / Node.js not found - using the built-in PowerShell server)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"

:done
echo.
echo   Server stopped.
pause
