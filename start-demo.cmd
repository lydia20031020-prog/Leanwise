@echo off
cd /d "%~dp0"
if not exist node_modules (
  call npm.cmd install
  if errorlevel 1 exit /b 1
)
echo Open http://127.0.0.1:5173 in your browser.
call npm.cmd run dev
