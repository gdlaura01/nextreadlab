@echo off
cd /d "%~dp0"
start "Next Read Lab - servidor" cmd /c npm run dev
timeout /t 3 /nobreak >nul
start "" http://localhost:5173
