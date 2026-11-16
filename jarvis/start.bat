@echo off
rem Windows: double-click this file to start Jarvis.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Jarvis needs Node.js ^(free^). Install the LTS version from https://nodejs.org
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause
