@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  comment backend - one-click start
echo ============================================
echo.

rem ── 1. 检查 bun 是否可用 ─────────────────────────────
where bun >nul 2>nul
if errorlevel 1 goto :no_bun
echo [1/4] bun ok

rem ── 2. 确保数据库容器 xhs_pg 在运行 ──────────────────
echo [2/4] checking database container (xhs_pg) ...
docker ps -q -f "name=xhs_pg" -f "status=running" 2>nul | findstr "." >nul
if not errorlevel 1 goto :db_ok

echo       xhs_pg not running - trying docker start ...
docker start xhs_pg >nul 2>nul
if not errorlevel 1 goto :db_started

rem Docker 引擎不可达（Docker Desktop 未运行）→ 启动它
echo       docker engine not reachable - launching Docker Desktop ...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" goto :launch_dd
if exist "%LocalAppData%\Docker\Docker Desktop.exe" goto :launch_dd_local
echo [x] Docker Desktop.exe not found. Backend will start, but DB may be unreachable.
goto :db_ok

:launch_dd_local
set "DD_EXE=%LocalAppData%\Docker\Docker Desktop.exe"
goto :do_launch_dd

:launch_dd
set "DD_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"

:do_launch_dd
start "" "%DD_EXE%"
echo       waiting for docker engine (up to 180s) ...
set /a _wait=0
:wait_docker
docker info >nul 2>nul
if not errorlevel 1 goto :docker_ready
set /a _wait+=3
if %_wait% geq 180 goto :docker_timeout
timeout /t 3 /nobreak >nul
goto :wait_docker

:docker_ready
echo       docker engine ready - starting xhs_pg ...
docker start xhs_pg >nul 2>nul
if errorlevel 1 goto :db_fail
goto :db_started

:docker_timeout
echo [x] docker engine not ready within 180s - backend will start without DB.
goto :db_ok

:db_started
echo       xhs_pg started, waiting 3s for ready ...
timeout /t 3 /nobreak >nul
goto :db_ok

:db_fail
echo [warn] cannot start xhs_pg - backend will start, but DB may be unreachable.
echo.

:db_ok
rem ── 3. 依赖 ─────────────────────────────────────────
echo [3/4] checking dependencies ...
if not exist "node_modules" goto :install
echo       node_modules ok
goto :env

:install
echo       installing with bun ...
call bun install
if errorlevel 1 goto :fail
echo       install done

:env
rem ── 4. .env ─────────────────────────────────────────
echo [4/4] checking .env ...
if exist ".env" goto :run
echo       .env not found - copying from .env.example
copy /y ".env.example" ".env" >nul

:run
rem ── 5. 启动 ─────────────────────────────────────────
echo       starting server (port from .env, default 15650) ...
echo       health check: http://127.0.0.1:15650/health
echo.
call bun run src/main.ts
goto :eof

:no_bun
echo.
echo [x] bun not found in PATH.
echo     Install: https://bun.sh  (Windows: npm i -g bun  or  powershell install)
exit /b 1

:fail
echo.
echo [x] FAILED: dependency install error.
exit /b 1
