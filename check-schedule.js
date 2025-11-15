#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

function colorize(text, color) {
    return colors[color] + text + colors.reset;
}

function success(text) {
    console.log(colorize('✅ ' + text, 'green'));
}

function error(text) {
    console.log(colorize('❌ ' + text, 'red'));
}

function info(text) {
    console.log(colorize('ℹ️ ' + text, 'blue'));
}

function header(text) {
    console.log('\n' + colorize('='.repeat(50), 'blue'));
    console.log(colorize(text.toUpperCase().padStart((50 + text.length) / 2), 'bright'));
    console.log(colorize('='.repeat(50), 'blue') + '\n');
}

function formatTime12Hour(time24) {
    if (!time24 || time24 === 'N/A' || !time24.includes(':')) {
        return time24;
    }
    
    const [hours, minutes] = time24.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${displayHour}:${minutes} ${ampm}`;
}

function parseCronTime(cronExpression) {
    const parts = cronExpression.split(' ');
    if (parts.length >= 5) {
        const minute = parts[0];
        const hour = parts[1];
        const weekday = parts[4];
        
        const time24 = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
        const time12 = formatTime12Hour(time24);
        
        if (weekday !== '*') {
            const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const dayName = weekdayNames[parseInt(weekday)] || `Day ${weekday}`;
            return `${time12} every ${dayName}`;
        } else {
            return `${time12} daily`;
        }
    }
    return 'Custom schedule';
}

async function checkWindowsSchedule() {
    try {
        const { stdout } = await execAsync('schtasks /query /tn "Reddit Newsletter Generator" /fo LIST');
        
        if (stdout.includes('TaskName')) {
            success('Windows Task Scheduler task found');
            
            // Parse the output for key information
            const lines = stdout.split('\n');
            const taskInfo = {};
            
            lines.forEach(line => {
                const [key, value] = line.split(':', 2);
                if (key && value) {
                    taskInfo[key.trim()] = value.trim();
                }
            });
            
            console.log('\n📋 Task Details:');
            if (taskInfo['Next Run Time']) {
                const nextRun = taskInfo['Next Run Time'];
                // Try to extract and convert time if it contains a time pattern
                const timeMatch = nextRun.match(/(\d{1,2}):(\d{2}):(\d{2})/);
                if (timeMatch) {
                    const time24 = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
                    const time12 = formatTime12Hour(time24);
                    const nextRunFormatted = nextRun.replace(timeMatch[0], time12);
                    info(`Next run: ${nextRunFormatted}`);
                } else {
                    info(`Next run: ${nextRun}`);
                }
            }
            if (taskInfo['Status']) {
                const status = taskInfo['Status'];
                if (status === 'Ready') {
                    success(`Status: ${status}`);
                } else {
                    error(`Status: ${status}`);
                }
            }
            if (taskInfo['Last Run Time']) {
                const lastRun = taskInfo['Last Run Time'];
                const timeMatch = lastRun.match(/(\d{1,2}):(\d{2}):(\d{2})/);
                if (timeMatch) {
                    const time24 = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
                    const time12 = formatTime12Hour(time24);
                    const lastRunFormatted = lastRun.replace(timeMatch[0], time12);
                    info(`Last run: ${lastRunFormatted}`);
                } else {
                    info(`Last run: ${lastRun}`);
                }
            }
            if (taskInfo['Last Result']) {
                const result = taskInfo['Last Result'];
                if (result === '0') {
                    success(`Last result: Success (${result})`);
                } else {
                    error(`Last result: Failed (${result})`);
                }
            }
            
            console.log('\n🔧 Easy Management Commands:');
            console.log('• npm run schedule-enable        - Enable scheduled task');
            console.log('• npm run schedule-disable       - Disable scheduled task');
            console.log('• npm run schedule-delete        - Delete scheduled task');
            console.log('• npm run schedule-delete-admin  - Delete with admin elevation');
            console.log('• npm run schedule-setup         - Modify schedule settings');
            
            console.log('\n⚙️ Advanced Management:');
            console.log('• View in Task Scheduler: taskschd.msc');
            console.log('• Manual disable: schtasks /change /tn "Reddit Newsletter Generator" /disable');
            console.log('• Manual enable: schtasks /change /tn "Reddit Newsletter Generator" /enable');
            console.log('• Manual delete: schtasks /delete /tn "Reddit Newsletter Generator" /f');
            
        } else {
            error('No scheduled task found');
            info('Run "npm run setup" to create automatic scheduling');
        }
    } catch (err) {
        error('No scheduled task found or access denied');
        info('Run "npm run setup" to create automatic scheduling');
    }
}

async function checkLinuxSchedule() {
    try {
        const { stdout } = await execAsync('crontab -l');
        const cronJobs = stdout.split('\n')
            .filter(line => line.includes('run-newsletter'))
            .filter(line => !line.startsWith('#'));
        
        if (cronJobs.length > 0) {
            success(`Found ${cronJobs.length} scheduled cron job(s)`);
            
            console.log('\n📋 Cron Jobs:');
            cronJobs.forEach((job, index) => {
                console.log(`${index + 1}. ${job}`);
                
                // Parse and display schedule in friendly format
                const scheduleDesc = parseCronTime(job);
                info(`Schedule: ${scheduleDesc}`);
            });
            
            console.log('\n🔧 Easy Management Commands:');
            console.log('• npm run schedule-enable   - Enable cron job');
            console.log('• npm run schedule-disable  - Disable cron job');
            console.log('• npm run schedule-delete   - Delete cron job');
            console.log('• npm run schedule-setup    - Modify schedule settings');
            
            console.log('\n⚙️ Advanced Management:');
            console.log('• Edit cron jobs: crontab -e');
            console.log('• View all cron jobs: crontab -l');
            console.log('• View cron log: grep CRON /var/log/syslog');
            console.log('• Check cron service: systemctl status cron');
            
        } else {
            error('No scheduled cron jobs found');
            info('Run "npm run setup" to create automatic scheduling');
        }
    } catch (err) {
        if (err.message.includes('no crontab')) {
            error('No cron jobs configured');
            info('Run "npm run setup" to create automatic scheduling');
        } else {
            error('Failed to check cron jobs: ' + err.message);
        }
    }
}

async function checkSchedule() {
    header('Scheduled Task Status');
    
    const platform = process.platform;
    info(`Platform: ${platform}`);
    
    if (platform === 'win32') {
        await checkWindowsSchedule();
    } else if (platform === 'linux' || platform === 'darwin') {
        await checkLinuxSchedule();
    } else {
        error(`Unsupported platform: ${platform}`);
    }
}

checkSchedule().catch(err => {
    error('An error occurred: ' + (err?.message || err?.toString() || 'Unknown error'));
    process.exit(1);
});