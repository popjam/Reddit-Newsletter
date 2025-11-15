@echo off
REM Reddit to Kindle Newsletter - Daily Automation Script
REM This script runs the newsletter generator every morning

REM Change to the script directory
cd /d "%~dp0"

REM Redirect all output to log file from this point on
(
echo ===============================================
echo Reddit to Kindle Newsletter Generator
echo Started: %date% %time%
echo ===============================================

REM Verify Node.js is available
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ ERROR: Node.js not found in PATH
    echo Please ensure Node.js is properly installed
    goto :error
)

REM Verify npm is available
npm --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ ERROR: npm not found in PATH
    echo Please ensure npm is properly installed
    goto :error
)

REM Verify we're in the right directory
if not exist package.json (
    echo ❌ ERROR: package.json not found
    echo Are we in the correct directory?
    echo Current directory: %CD%
    goto :error
)

REM Check for existing Node.js processes running our script
tasklist /fi "imagename eq node.exe" /fo csv | findstr "index.js" >nul
if %ERRORLEVEL% EQU 0 (
    echo ⚠️  WARNING: Node.js process already running - terminating existing processes
    echo 🔄 Killing existing Node.js processes...
    taskkill /f /im node.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo ✅ Previous processes terminated
)

echo ✅ All prerequisites check passed
echo 🚀 Starting newsletter generation...
echo.

REM Run the newsletter generator with verbose logging
npm run verbose

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Newsletter generation completed successfully!
) else (
    echo.
    echo ❌ Newsletter generation failed with error code: %ERRORLEVEL%
)

echo.
echo Completed: %date% %time%
echo ===============================================

REM If running manually, keep window open to see results
if "%1" NEQ "auto" (
    echo.
    echo Press any key to close...
    pause >nul
)

goto :end
) > newsletter-log.txt 2>&1

:error
echo.
echo ❌ Script failed - see errors above
if "%1" NEQ "auto" (
    echo Press any key to close...
    pause >nul
)

:end
) > newsletter-log.txt 2>&1