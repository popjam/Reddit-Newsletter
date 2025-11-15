#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
function success(text) { console.log(colorize('✅ ' + text, 'green')); }
function error(text) { console.log(colorize('❌ ' + text, 'red')); }
function warning(text) { console.log(colorize('⚠️ ' + text, 'yellow')); }
function info(text) { console.log(colorize('ℹ️ ' + text, 'blue')); }

function getPlatformInfo() {
    return {
        platform: process.platform,
        isWindows: process.platform === 'win32',
        isLinux: process.platform === 'linux' || process.platform === 'darwin'
    };
}

async function manageWindowsSchedule(action) {
    const taskName = 'Reddit Newsletter Generator';
    
    try {
        let command;
        let successMsg;
        let needsAdmin = false;
        
        switch (action) {
            case 'enable':
                command = `schtasks /change /tn "${taskName}" /enable`;
                successMsg = 'Scheduled task enabled successfully';
                needsAdmin = true;
                break;
            case 'disable':
                command = `schtasks /change /tn "${taskName}" /disable`;
                successMsg = 'Scheduled task disabled successfully';
                needsAdmin = true;
                break;
            case 'delete':
                command = `schtasks /delete /tn "${taskName}" /f`;
                successMsg = 'Scheduled task deleted successfully';
                needsAdmin = true;
                break;
            default:
                error('Invalid action. Use: enable, disable, or delete');
                return false;
        }
        
        info(`Executing: ${command}`);
        const { stdout, stderr } = await execAsync(command);
        
        console.log('Command output:', stdout);
        if (stderr) console.log('Command errors:', stderr);
        
        if (stderr && (stderr.toLowerCase().includes('access is denied') || stderr.toLowerCase().includes('access denied'))) {
            error('Access denied - Administrator privileges required');
            console.log('\n💡 Solutions:');
            console.log('1. Right-click Command Prompt → "Run as administrator"');
            console.log('2. Navigate to your project folder');
            console.log(`3. Run: npm run schedule-${action}`);
            console.log('\n4. Or use Task Scheduler GUI:');
            console.log('   • Press Win+R, type "taskschd.msc", press Enter');
            console.log(`   • Find "${taskName}" in the task library`);
            console.log('   • Right-click and choose the desired action');
            return false;
        }
        
        if (stdout.toLowerCase().includes('success') || 
            (action === 'delete' && stdout.toLowerCase().includes('deleted')) ||
            (!stderr || stderr.trim() === '')) {
            success(successMsg);
            return true;
        } else {
            throw new Error(stderr || stdout || 'Unknown error');
        }
        
    } catch (err) {
        if (err.message.toLowerCase().includes('access is denied')) {
            error('Access denied - Administrator privileges required');
            console.log('\n💡 Solutions:');
            console.log(`1. Run Command Prompt as Administrator, then: npm run schedule-${action}`);
            console.log('2. Use Task Scheduler GUI (taskschd.msc) instead');
        } else if (err.message.toLowerCase().includes('cannot find')) {
            warning('No scheduled task found to ' + action);
            info('Use "npm run schedule-setup" to create a new schedule');
        } else {
            error(`Failed to ${action} scheduled task: ${err.message}`);
        }
        return false;
    }
}

async function manageLinuxSchedule(action) {
    try {
        let successMsg;
        
        switch (action) {
            case 'enable':
                warning('Cron jobs are automatically enabled when created');
                info('Use "crontab -l" to view active jobs');
                return true;
                
            case 'disable':
                info('Disabling cron job by commenting it out...');
                let existingCrontab = '';
                try {
                    const { stdout } = await execAsync('crontab -l');
                    existingCrontab = stdout;
                } catch (e) {
                    warning('No cron jobs found');
                    return true;
                }
                
                // Comment out reddit newsletter jobs
                const disabledCrontab = existingCrontab
                    .split('\n')
                    .map(line => {
                        if (line.includes('run-newsletter.sh') && !line.startsWith('#')) {
                            return '# DISABLED: ' + line;
                        }
                        return line;
                    })
                    .join('\n');
                
                await execAsync(`echo "${disabledCrontab}" | crontab -`);
                success('Cron job disabled (commented out)');
                return true;
                
            case 'delete':
                info('Removing cron job...');
                let currentCrontab = '';
                try {
                    const { stdout } = await execAsync('crontab -l');
                    currentCrontab = stdout;
                } catch (e) {
                    warning('No cron jobs found to delete');
                    return true;
                }
                
                // Remove reddit newsletter jobs
                const filteredCrontab = currentCrontab
                    .split('\n')
                    .filter(line => !line.includes('run-newsletter.sh'))
                    .filter(line => line.trim() !== '')
                    .join('\n');
                
                const newCrontab = filteredCrontab + (filteredCrontab ? '\n' : '');
                await execAsync(`echo "${newCrontab}" | crontab -`);
                success('Cron job deleted successfully');
                return true;
                
            default:
                error('Invalid action. Use: enable, disable, or delete');
                return false;
        }
        
    } catch (err) {
        error(`Failed to ${action} cron job: ${err.message}`);
        return false;
    }
}

async function manageSchedule(action) {
    const platform = getPlatformInfo();
    
    console.log(`\n${colorize('📅 Schedule Management', 'bright')} - ${colorize(action.toUpperCase(), 'cyan')}`);
    console.log(colorize('═'.repeat(40), 'blue'));
    
    info(`Platform: ${platform.platform}`);
    
    if (platform.isWindows) {
        return await manageWindowsSchedule(action);
    } else {
        return await manageLinuxSchedule(action);
    }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const action = process.argv[2];
    
    if (!action || !['enable', 'disable', 'delete'].includes(action)) {
        console.log(`
${colorize('📅 Schedule Manager', 'bright')}
${colorize('═'.repeat(30), 'blue')}

Usage: node schedule-manager.js [action]

Actions:
  ${colorize('enable', 'green')}   Enable the scheduled task/cron job
  ${colorize('disable', 'yellow')}  Disable the scheduled task/cron job  
  ${colorize('delete', 'red')}   Delete the scheduled task/cron job

Examples:
  node schedule-manager.js enable
  node schedule-manager.js disable
  node schedule-manager.js delete
`);
        process.exit(1);
    }
    
    manageSchedule(action).then(success => {
        process.exit(success ? 0 : 1);
    }).catch(err => {
        error('An error occurred: ' + err.message);
        process.exit(1);
    });
}

export { manageSchedule };