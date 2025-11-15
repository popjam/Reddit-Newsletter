# Reddit to Kindle Newsletter - Automated Task Setup
# Run this PowerShell script as Administrator to automatically create the scheduled task

$TaskName = "Reddit Newsletter Generator"
$TaskDescription = "Daily generation of Reddit newsletter at 7 AM"
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptPath = Join-Path $ScriptDirectory "run-reddit-newsletter.bat"
$WorkingDirectory = $ScriptDirectory

# Create the scheduled task action
$Action = New-ScheduledTaskAction -Execute $ScriptPath -WorkingDirectory $WorkingDirectory

# Create the scheduled task trigger (daily at 7 AM)
$Trigger = New-ScheduledTaskTrigger -Daily -At "7:00AM"

# Create the scheduled task settings
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -StartWhenAvailable

# Create the scheduled task principal (run with highest privileges)
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

# Register the scheduled task
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description $TaskDescription

Write-Host "✅ Scheduled task '$TaskName' created successfully!" -ForegroundColor Green
Write-Host "📅 The task will run daily at 7:00 AM" -ForegroundColor Cyan
Write-Host "📁 Working directory: $WorkingDirectory" -ForegroundColor Cyan
Write-Host "🚀 You can test it now by running: schtasks /run /tn `"$TaskName`"" -ForegroundColor Yellow