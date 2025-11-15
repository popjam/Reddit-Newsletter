#!/usr/bin/env node

import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Color functions
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function colorize(text, color) { return colors[color] + text + colors.reset; }
function log(message, color = 'reset') { console.log(colorize(message, color)); }
function question(prompt, color = 'cyan') { return new Promise((resolve) => rl.question(colorize(prompt, color), resolve)); }
function header(text) { console.log('\n' + colorize('='.repeat(50), 'blue') + '\n' + colorize(text.toUpperCase().padStart((50 + text.length) / 2), 'bright') + '\n' + colorize('='.repeat(50), 'blue') + '\n'); }
function success(text) { console.log(colorize('✅ ' + text, 'green')); }
function error(text) { console.log(colorize('❌ ' + text, 'red')); }
function warning(text) { console.log(colorize('⚠️ ' + text, 'yellow')); }
function info(text) { console.log(colorize('ℹ️ ' + text, 'blue')); }

function getPlatformInfo() {
    const isWindows = process.platform === 'win32';
    const isLinux = process.platform === 'linux';
    const isMacOS = process.platform === 'darwin';
    
    return {
        platform: process.platform,
        isWindows,
        isLinux,
        isMacOS,
        arch: process.arch,
        nodeVersion: process.version
    };
}

function formatTime12Hour(time24) {
    const [hours, minutes] = time24.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${displayHour}:${minutes} ${ampm}`;
}

async function removeExistingSchedule(platform) {
    try {
        if (platform.isWindows) {
            await execAsync('schtasks /delete /tn "Reddit Newsletter Generator" /f');
            info('Removed existing Windows scheduled task');
        } else {
            // Remove from crontab
            try {
                const { stdout } = await execAsync('crontab -l');
                const filteredCrontab = stdout
                    .split('\n')
                    .filter(line => !line.includes('run-newsletter.sh'))
                    .filter(line => line.trim() !== '')
                    .join('\n');
                
                const newCrontab = filteredCrontab + (filteredCrontab ? '\n' : '');
                await execAsync(`echo "${newCrontab}" | crontab -`);
                info('Removed existing cron job');
            } catch (e) {
                // No existing crontab is fine
            }
        }
    } catch (e) {
        // No existing schedule is fine
    }
}

async function setupWindowsScheduler(time, isWeekly = false, weekday = null) {
    info('Setting up Windows Task Scheduler...');
    
    const taskName = 'Reddit Newsletter Generator';
    const scriptPath = path.join(__dirname, 'run-newsletter.bat');
    const description = `${isWeekly ? 'Weekly' : 'Daily'} generation of Reddit newsletter`;
    
    // Write PowerShell script to temporary file
    const psScriptPath = path.join(__dirname, 'temp-scheduler-setup.ps1');
    
    let triggerScript;
    if (isWeekly) {
        const weekdayMap = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const weekdayName = weekdayMap[weekday] || 'Monday';
        triggerScript = `$Trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek ${weekdayName} -At $Time`;
    } else {
        triggerScript = `$Trigger = New-ScheduledTaskTrigger -Daily -At $Time`;
    }
    
    const psScript = `$TaskName = "${taskName}"
$TaskDescription = "${description}"  
$ScriptPath = "${scriptPath.replace(/\\/g, '\\\\')}"
$WorkingDirectory = "${__dirname.replace(/\\/g, '\\\\')}"
$Time = "${time}"

try {
    # Check if task already exists
    $ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($ExistingTask) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed existing task"
    }
    
    # Create the scheduled task action
    $Action = New-ScheduledTaskAction -Execute $ScriptPath -Argument "auto" -WorkingDirectory $WorkingDirectory
    
    # Create the scheduled task trigger
    ${triggerScript}
    
    # Create the scheduled task settings
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    
    # Create the scheduled task principal
    $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive
    
    # Register the scheduled task
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description $TaskDescription
    
    Write-Host "SUCCESS"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    exit 1
}`;
    
    try {
        fs.writeFileSync(psScriptPath, psScript);
        const { stdout, stderr } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`);
        
        try {
            fs.unlinkSync(psScriptPath);
        } catch (e) {
            // Ignore cleanup errors
        }
        
        if (stdout.includes('SUCCESS')) {
            success(`✅ Windows Task Scheduler configured successfully!`);
            const scheduleDesc = isWeekly ? `weekly on ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday]}` : 'daily';
            info(`📅 Newsletter will run ${scheduleDesc} at ${formatTime12Hour(time)}`);
            info(`🔍 You can view/modify the task in Task Scheduler under "${taskName}"`);
        } else {
            throw new Error(`PowerShell output: ${stdout || 'No output'}, Error: ${stderr || 'No error'}`);
        }
    } catch (err) {
        try {
            fs.unlinkSync(psScriptPath);
        } catch (e) {
            // Ignore cleanup errors
        }
        throw new Error(`PowerShell execution failed: ${err?.message || err?.toString() || 'Unknown PowerShell error'}`);
    }
}

async function setupLinuxScheduler(time, isWeekly = false, weekday = null) {
    info('Setting up cron job for automatic scheduling...');
    
    const [hours, minutes = '0'] = time.split(':');
    let cronTime;
    
    if (isWeekly) {
        const cronWeekday = weekday === 7 ? 0 : weekday;
        cronTime = `${minutes} ${hours} * * ${cronWeekday}`;
    } else {
        cronTime = `${minutes} ${hours} * * *`;
    }
    
    const cronJob = `${cronTime} cd "${__dirname}" && bash run-newsletter.sh`;
    
    try {
        let existingCrontab = '';
        try {
            const { stdout } = await execAsync('crontab -l');
            existingCrontab = stdout;
        } catch (e) {
            // No existing crontab is fine
        }
        
        const filteredCrontab = existingCrontab
            .split('\n')
            .filter(line => !line.includes('run-newsletter.sh'))
            .filter(line => line.trim() !== '')
            .join('\n');
        
        const newCrontab = filteredCrontab + (filteredCrontab ? '\n' : '') + cronJob + '\n';
        
        await execAsync(`echo "${newCrontab}" | crontab -`);
        
        success(`✅ Cron job configured successfully!`);
        const scheduleDesc = isWeekly ? `weekly on ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday]}` : 'daily';
        info(`📅 Newsletter will run ${scheduleDesc} at ${formatTime12Hour(time)}`);
        info(`🔍 You can view cron jobs with: crontab -l`);
        info(`❌ To remove: crontab -e (then delete the reddit-newsletter line)`);
        
    } catch (err) {
        throw new Error(`Cron setup failed: ${err.message}`);
    }
}

async function configureSchedule() {
    const platform = getPlatformInfo();
    
    header('Newsletter Schedule Setup');
    info(`Platform: ${platform.platform}`);
    
    // Remove any existing schedule first
    await removeExistingSchedule(platform);
    
    // Get frequency
    console.log('\n📅 Schedule Options:');
    console.log('1. Daily - Run every day');
    console.log('2. Weekly - Run once per week');
    
    const frequency = await question('\nHow often should the newsletter run? (1=daily, 2=weekly): ');
    const isWeekly = frequency === '2';
    
    let weekday = null;
    if (isWeekly) {
        console.log('\n📅 Weekday Options:');
        console.log('1. Monday    5. Friday');
        console.log('2. Tuesday   6. Saturday');
        console.log('3. Wednesday 7. Sunday');
        console.log('4. Thursday');
        
        const weekdayInput = await question('\nWhich day of the week? (1-7): ');
        weekday = parseInt(weekdayInput) || 1;
        
        if (weekday < 1 || weekday > 7) {
            warning('Invalid weekday. Using Monday (1)');
            weekday = 1;
        }
    }
    
    // Get time in 24-hour format
    console.log('\n🕐 Time Format Examples:');
    console.log('• 07:00 (7:00 AM)   • 19:30 (7:30 PM)');
    console.log('• 12:00 (12:00 PM)  • 23:45 (11:45 PM)');
    
    const timeInput = await question('\nWhat time should it run? (24-hour format, e.g., "07:00"): ');
    let time = timeInput.trim() || '07:00';
    
    // Validate time format
    const timeRegex = /^([0-1]?\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
        warning('Invalid time format. Using default 07:00 (7:00 AM)');
        time = '07:00';
    }
    
    const scheduleDesc = isWeekly ? `weekly on ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday]}` : 'daily';
    
    console.log(`\n📋 Schedule Summary:`);
    info(`Frequency: ${isWeekly ? 'Weekly' : 'Daily'}`);
    if (isWeekly) {
        info(`Day: ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday]}`);
    }
    info(`Time: ${formatTime12Hour(time)} (${time})`);
    
    const confirm = await question('\nProceed with this schedule? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
        warning('Schedule setup cancelled');
        return;
    }
    
    try {
        if (platform.isWindows) {
            await setupWindowsScheduler(time, isWeekly, weekday);
        } else {
            await setupLinuxScheduler(time, isWeekly, weekday);
        }
        
        console.log('\n🎉 Schedule setup completed successfully!');
        console.log('\n💡 Useful Commands:');
        console.log('• npm run check-schedule  - View current schedule');
        console.log('• npm run schedule-setup  - Modify schedule');
        console.log('• npm start               - Run newsletter manually');
        
    } catch (err) {
        error(`Failed to set up schedule: ${err?.message || err?.toString() || 'Unknown error'}`);
        console.log('\n💡 You can try again with: npm run schedule-setup');
    }
}

configureSchedule().finally(() => {
    rl.close();
});