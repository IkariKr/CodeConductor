@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

if /i "%~1"=="--help" goto :help

echo [RebuildChat] Workspace: %CD%

where node >nul 2>nul
if errorlevel 1 goto :missing_node

where npm >nul 2>nul
if errorlevel 1 goto :missing_npm

for /f %%i in ('node -p "process.versions.node"') do set NODE_VERSION=%%i
for /f "tokens=1 delims=." %%i in ("!NODE_VERSION!") do set NODE_MAJOR=%%i

echo [RebuildChat] Node version: !NODE_VERSION!
if not "!NODE_MAJOR!"=="24" (
  echo [RebuildChat] Warning: recommend Node v24.x. Current major version is !NODE_MAJOR!.
  echo [RebuildChat] If install or startup fails, switch to Node 24.14.0 and try again.
)

if not exist "node_modules" (
  echo [RebuildChat] node_modules not found. Running npm install...
  call npm install
  if errorlevel 1 goto :failed
)

set FORGE_SKIP_NATIVE_REBUILD=true
set CodeConductor_DEV_PORT=3100
set CodeConductor_LOGGER_PORT=9100

if /i "%~1"=="--check" (
  echo [RebuildChat] Environment check passed.
  echo [RebuildChat] FORGE_SKIP_NATIVE_REBUILD=%FORGE_SKIP_NATIVE_REBUILD%
  echo [RebuildChat] CodeConductor_DEV_PORT=%CodeConductor_DEV_PORT%
  echo [RebuildChat] CodeConductor_LOGGER_PORT=%CodeConductor_LOGGER_PORT%
  exit /b 0
)

echo [RebuildChat] Starting app...
call npm start
if errorlevel 1 goto :failed

exit /b 0

:missing_node
echo [RebuildChat] Error: node is not available in PATH.
echo [RebuildChat] Please install or switch to Node 24.x, then run this script again.
goto :pause_and_fail

:missing_npm
echo [RebuildChat] Error: npm is not available in PATH.
echo [RebuildChat] Please make sure Node.js is installed correctly, then run this script again.
goto :pause_and_fail

:failed
echo [RebuildChat] Startup failed.
goto :pause_and_fail

:help
echo Usage:
echo   start-rebuildchat.cmd
echo   start-rebuildchat.cmd --check
echo.
echo --check  Only verify environment variables and dependencies without launching the app.
exit /b 0

:pause_and_fail
echo.
pause
exit /b 1
