# Adds a scheduled task that starts the JLauncher bridge (jlauncher-bridge.js) when you sign in, in a
# hidden window, and starts it now. Needs %LOCALAPPDATA%\JLauncher\newsletter-bridge.json with the
# Firebase "url" and pairing "key".
# Remove it with: Unregister-ScheduledTask -TaskName "JLauncher Newsletter Bridge" -Confirm:$false
$ErrorActionPreference = "Stop"
$node = (Get-Command node).Source
$script = Join-Path $PSScriptRoot "jlauncher-bridge.js"
$settings = Join-Path $env:LOCALAPPDATA "JLauncher\newsletter-bridge.json"
if (-not (Test-Path $settings)) { throw "Missing $settings" }

$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$node`" `"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "JLauncher Newsletter Bridge" -Action $action -Trigger $trigger -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName "JLauncher Newsletter Bridge"
"Installed. Log: $env:LOCALAPPDATA\JLauncher\newsletter-bridge.log"
