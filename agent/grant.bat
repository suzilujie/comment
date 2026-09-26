@echo off
rem ============================================================
rem  comment agent - grant device permissions (run after install)
rem
rem  Grants the three permissions that an app cannot grant itself:
rem    1. accessibility service   (read/write screen nodes)
rem    2. display over other apps (SYSTEM_ALERT_WINDOW)
rem    3. MIUI background popup   (appop 10021, MIUI only)
rem
rem  Usage:
rem    grant.bat          interactive (pauses before closing)
rem    grant.bat /auto    non-interactive (called by install.bat)
rem
rem  Note: the app itself can never grant these silently - Android
rem  requires an explicit user action (or adb, as done here).
rem ============================================================
setlocal
chcp 65001 >nul
set "PKG=com.xfish.comment.agent.debug"
set "A11Y_SVC=%PKG%/com.xfish.comment.agent.accessibility.AutoService"
set "ADB=adb"

rem -- locate adb: PATH first, then the Android SDK default path --
rem    (do NOT test with "if exist": when ADB is the bare command "adb"
rem     it is not a file path, so that test would always fail)
where adb >nul 2>nul
if not errorlevel 1 goto :adb_ready
set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"

:adb_ready
rem -- verify adb really works before using it --
"%ADB%" version >nul 2>nul
if errorlevel 1 goto :no_adb

echo ============================================
echo  comment agent - grant permissions
echo  package: %PKG%
echo ============================================
echo.

echo [1/4] accessibility service ...
"%ADB%" shell settings put secure enabled_accessibility_services %A11Y_SVC%
"%ADB%" shell settings put secure accessibility_enabled 1

echo [2/4] display over other apps ...
"%ADB%" shell appops set %PKG% SYSTEM_ALERT_WINDOW allow

echo [3/4] MIUI background popup (ignored on other ROMs) ...
"%ADB%" shell cmd appops set %PKG% 10021 allow

echo [4/4] verify ...
"%ADB%" shell settings get secure enabled_accessibility_services
"%ADB%" shell appops get %PKG% SYSTEM_ALERT_WINDOW
"%ADB%" shell appops get %PKG% 10021

echo.
echo Expected: the AutoService is listed and both appops are "allow".
echo If not, enable them manually:
echo   Settings - Apps - comment Agent - Permissions
echo.

rem -- keep the window open unless called with /auto --
if /i "%~1"=="/auto" goto :eof
pause
goto :eof

:no_adb
echo [x] adb not found. Add Android SDK platform-tools to PATH.
if /i "%~1"=="/auto" goto :eof
pause
goto :eof
