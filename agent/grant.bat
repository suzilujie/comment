@echo off
chcp 65001 >nul
setlocal
set PKG=com.xfish.comment.agent.debug
set ADB=adb

rem ── 定位 adb（PATH 里没有就用 Android SDK 默认路径）──
where %ADB% >nul 2>nul
if errorlevel 1 set ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe
if not exist "%ADB%" (
  echo [x] adb 未找到，请把 Android SDK platform-tools 加入 PATH。
  pause
  exit /b 1
)

echo ============================================
echo  评论 Agent - 一键授权（重装 APK 后执行）
echo ============================================
echo.

echo [1/3] 显示在其他应用上层（后台启动 Activity 的前提）
"%ADB%" shell appops set %PKG% SYSTEM_ALERT_WINDOW allow

echo [2/3] MIUI 后台弹出界面（仅 MIUI 需要；其他 ROM 报错可忽略）
"%ADB%" shell cmd appops set %PKG% 10021 allow

echo [3/3] 校验结果：
"%ADB%" shell appops get %PKG% SYSTEM_ALERT_WINDOW
"%ADB%" shell appops get %PKG% 10021

echo.
echo 以上两项都应为 allow。若仍不是，请手动到：
echo   设置 -^> 应用管理 -^> 评论 Agent -^> 权限管理
echo   开启「显示在其他应用上层」与「后台弹出界面」。
echo.
pause
