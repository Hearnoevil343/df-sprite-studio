@echo off
rem Builds DF Sprite Studio, starts its server on port 8000 and opens the browser.
rem Close this window to stop the studio.
title DF Sprite Studio
cd /d "%~dp0"
call npm run build || (echo Build failed. & pause & exit /b 1)
rem Open the browser two seconds later, once the server is listening.
start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:8000"
node tools/studio-server.ts
pause
