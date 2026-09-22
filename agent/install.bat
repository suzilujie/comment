@echo off
setlocal
cd /d "%~dp0"

set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB%" set "ADB=adb"

set "APK=%~dp0app\build\outputs\apk\debug\app-debug.apk"

echo ============================================
echo  comment agent - install to device
echo ============================================
echo.

if not exist "%APK%" goto :no_apk

echo [1/3] checking device ...
"%ADB%" get-state >nul 2>nul
if errorlevel 1 goto :no_device
"%ADB%" devices

echo.
echo [2/3] installing apk ...
"%ADB%" install -r "%APK%"
if errorlevel 1 goto :fail

echo.
echo [3/3] done. Open "评论 Agent" on the device.
goto :eof

:no_apk
echo [x] APK not found. Run start.bat first to build it.
exit /b 1

:no_device
echo.
echo [x] no device connected. Check:
echo     1. USB debugging enabled
echo        (Xiaomi also: "USB debugging (Security settings)" + "USB install")
echo     2. USB mode = file transfer (MTP), not charge-only
echo     3. allow the "USB debugging" prompt on the phone
exit /b 1

:fail
echo.
echo [x] install failed. See error above.
echo     Xiaomi usually requires "USB install" in developer options.
exit /b 1
