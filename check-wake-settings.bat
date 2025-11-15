@echo off
echo Checking if scheduled tasks can wake your computer...
echo.

echo === Current Power Settings ===
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
echo.

echo === Wake Timers Setting ===
powercfg /query SCHEME_CURRENT SUB_SLEEP | findstr /i "wake"
echo.

echo === Scheduled Task Wake Settings ===
schtasks /query /tn "Reddit Newsletter Generator" /fo LIST | findstr /i "wake"

echo.
echo === To enable wake timers (if disabled) ===
echo Run as Administrator: powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
echo Then run: powercfg /setactive SCHEME_CURRENT
echo.
pause