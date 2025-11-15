@echo off
REM Reddit to Kindle Newsletter - With Console Output
cd /d "%~dp0"

echo ===============================================
echo Reddit to Kindle Newsletter Generator
echo Started: %date% %time%
echo ===============================================

REM Verify prerequisites
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ ERROR: Node.js not found
    goto :end
)

npm --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ ERROR: npm not found
    goto :end
)

if not exist package.json (
    echo ❌ ERROR: package.json not found
    goto :end
)

echo ✅ All prerequisites check passed
echo 🚀 Starting newsletter generation...
echo.

REM Run with verbose output shown in console
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

if "%1" NEQ "auto" (
    echo.
    echo Press any key to close...
    pause >nul
)

:end