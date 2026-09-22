@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  comment agent - build and install
echo ============================================
echo.

if exist "gradlew.bat" goto :build

echo [agent] gradlew.bat not found.
echo [agent] Option A: open this folder with Android Studio and let it generate the wrapper.
echo [agent] Option B: run "gradle wrapper --gradle-version 8.9" once (gradle must be in PATH).
exit /b 1

:build
echo [agent] building debug apk ...
call gradlew.bat :app:assembleDebug
if errorlevel 1 goto :fail

echo.
echo [agent] installing to connected device ...
call gradlew.bat :app:installDebug
if errorlevel 1 goto :adbfail

echo.
echo [agent] done. Launch "评论 Agent" on the device and complete onboarding.
goto :eof

:fail
echo.
echo [agent] BUILD FAILED. Check the output above.
echo [agent] If the error mentions encoding or path, copy this project to an ASCII-only path
echo [agent] (e.g. C:\work\comment\agent) and rebuild - the current path contains non-ASCII characters.
exit /b 1

:adbfail
echo.
echo [agent] INSTALL FAILED. Make sure:
echo [agent]   1. USB debugging is enabled (on Xiaomi also enable "USB debugging (Security settings)")
echo [agent]   2. "adb devices" lists your device with status "device"
exit /b 1
