@echo off
REM Cross-platform Reddit Newsletter Launcher for Windows
REM This script detects the environment and runs the appropriate version

setlocal enabledelayedexpansion

REM Change to script directory
cd /d "%~dp0"

REM Display output directly on screen
echo ===============================================
echo Reddit Newsletter Generator - Windows
echo Started: %date% %time%
echo Platform: Windows %PROCESSOR_ARCHITECTURE%
echo ===============================================

REM Check for Node.js
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ ERROR: Node.js not found in PATH
    echo Please install Node.js from https://nodejs.org/
    goto :error
)

REM Check for npm
npm --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ ERROR: npm not found in PATH
    echo Please ensure npm is properly installed with Node.js
    goto :error
)

REM Verify we're in the right directory
if not exist package.json (
    echo ❌ ERROR: package.json not found
    echo Current directory: %CD%
    echo Please run this script from the project root directory
    goto :error
)

echo ✅ All prerequisites checked
echo 🚀 Starting newsletter generation...
echo.

REM Run the newsletter generator
npm start

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✅ Newsletter generation completed successfully!
    echo Check your email for the generated newsletter
) else (
    echo.
    echo ❌ Newsletter generation failed with error code: %ERRORLEVEL%
    echo Check the output above for details
    goto :error
)

echo.
echo Completed: %date% %time%
echo ===============================================

REM Always keep window open to see results
echo.
echo Press any key to close...
pause >nul

goto :end

:error
echo.
echo ❌ Script execution failed - see errors above
echo.
echo Completed: %date% %time%
echo ===============================================

REM Always keep window open to see errors
echo Press any key to close...
pause >nul
exit /b 1

:end
exit /b 0