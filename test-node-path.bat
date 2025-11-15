@echo off
echo Testing Node.js and npm in Windows PATH...
echo.

echo === Node.js Version ===
node --version
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js not found in PATH
    goto :error
) else (
    echo ✅ Node.js found
)

echo.
echo === npm Version ===
npm --version
if %ERRORLEVEL% NEQ 0 (
    echo ❌ npm not found in PATH
    goto :error
) else (
    echo ✅ npm found
)

echo.
echo === Current Directory ===
cd

echo.
echo === Testing npm in project directory ===
cd /d "%~dp0"
if exist package.json (
    echo ✅ package.json found
    echo Testing npm list...
    npm list --depth=0
) else (
    echo ❌ package.json not found
)

echo.
echo ✅ All PATH tests completed successfully!
goto :end

:error
echo.
echo ❌ There's an issue with your PATH configuration
echo Please check that Node.js is properly installed on Windows

:end
pause