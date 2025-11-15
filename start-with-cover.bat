@echo off
REM Windows batch file to update book cover with date and run newsletter
setlocal enabledelayedexpansion

REM Change to script directory
cd /d "%~dp0"

echo ℹ️  Updating book cover with today's date...

REM Get current date in format "Month DD, YYYY"
for /f "tokens=1,2,3 delims=/" %%a in ('date /t') do (
    set month=%%a
    set day=%%b
    set year=%%c
)

REM Convert month number to name
if "%month%"=="01" set monthname=January
if "%month%"=="02" set monthname=February
if "%month%"=="03" set monthname=March
if "%month%"=="04" set monthname=April
if "%month%"=="05" set monthname=May
if "%month%"=="06" set monthname=June
if "%month%"=="07" set monthname=July
if "%month%"=="08" set monthname=August
if "%month%"=="09" set monthname=September
if "%month%"=="10" set monthname=October
if "%month%"=="11" set monthname=November
if "%month%"=="12" set monthname=December

REM Remove leading zero from day
set /a daynum=%day%

set datetext=%monthname% %daynum%, %year%

REM Check if ImageMagick is installed
magick -version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Error: ImageMagick not found. Please install ImageMagick for Windows.
    echo Download from: https://imagemagick.org/script/download.php#windows
    goto :error
)

REM Update book cover with date
magick "%~dp0reddit_book_cover.jpg" ^
    -gravity South -stroke "#000C" -strokewidth 2 -pointsize 40 ^
    -annotate +0+720 "%datetext%" -stroke none -fill white ^
    -annotate +0+720 "%datetext%" "%~dp0reddit_book_cover_with_date.jpg"

if %ERRORLEVEL% NEQ 0 (
    echo ❌ Error: Failed to update book cover.
    goto :error
)

echo ✅ Book cover updated successfully.
echo --------------------------------------------------

REM Run the newsletter generator
npm start

if %ERRORLEVEL% EQU 0 (
    echo ✅ Newsletter generation completed successfully!
    goto :end
) else (
    echo ❌ Newsletter generation failed with error code: %ERRORLEVEL%
    goto :error
)

:error
echo ❌ Script failed - see errors above
exit /b 1

:end
echo ✅ Process completed successfully
exit /b 0