@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  comment - dev launcher
echo  backend : http://127.0.0.1:15650
echo ============================================
echo.

if not exist "backend\start.bat" goto :nobackend

echo [1/1] starting backend in a new window ...
start "comment-backend" cmd /k "backend\start.bat"
echo.
echo Backend window opened. Close it to stop the service.
echo.
echo Next steps:
echo   - web frontend is not built yet (pending confirmation)
echo   - android agent: see agent\README.md
goto :eof

:nobackend
echo [ERROR] backend\start.bat not found. Run this script from the comment folder.
exit /b 1
