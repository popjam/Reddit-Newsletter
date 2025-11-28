@echo off
cd /d "%~dp0"

REM --- Setup Logging Environment ---
REM We set this variable so index.js knows where to write the verbose logs
set "LOG_FILE=%~dp0newsletter-log.txt"

REM --- Log Start to File Manually (for batch tracking) ---
echo. >> "%LOG_FILE%"
echo =============================================== >> "%LOG_FILE%"
echo Batch Run Started: %date% %time% >> "%LOG_FILE%"

REM --- Check for Node.js ---
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js not found in PATH
    echo Error: Node.js not found >> "%LOG_FILE%"
    pause
    exit /b 1
)

REM --- Run the Newsletter ---
REM No arguments needed. The script will find LOG_FILE automatically.
call npm start

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Success!
    echo Batch Run Completed: %date% %time% >> "%LOG_FILE%"
) else (
    echo.
    echo Failed!
    echo Batch Run Failed: %date% %time% >> "%LOG_FILE%"
)

REM Keep window open briefly
timeout /t 10
exit /b 0