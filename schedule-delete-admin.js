#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
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

async function deleteWindowsTaskWithElevation() {
    const taskName = 'Reddit Newsletter Generator';
    
    console.log(`\n${colorize('🗑️ Delete Scheduled Task', 'bright')}`);
    console.log(colorize('═'.repeat(35), 'blue'));
    
    // Create a PowerShell script that requests elevation
    const psScriptPath = path.join(__dirname, 'temp-delete-task.ps1');
    const psScript = `# Request administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator"))
{
    Write-Host "This script requires Administrator privileges. Requesting elevation..."
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \`"$PSCommandPath\`"" -Verb RunAs
    Exit
}

# We're running as administrator now
Write-Host "Running with Administrator privileges..."

try {
    # Check if task exists
    $task = Get-ScheduledTask -TaskName "${taskName}" -ErrorAction SilentlyContinue
    if ($task) {
        # Delete the task
        Unregister-ScheduledTask -TaskName "${taskName}" -Confirm:$false
        Write-Host "SUCCESS: Scheduled task '${taskName}' has been deleted."
    } else {
        Write-Host "NOTFOUND: No scheduled task '${taskName}' found."
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host "FAILED: Could not delete the scheduled task."
}

Write-Host "Press any key to continue..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
`;

    try {
        // Write the PowerShell script
        fs.writeFileSync(psScriptPath, psScript);
        
        info('Creating elevated PowerShell script to delete task...');
        info('This will open a new PowerShell window with administrator privileges');
        
        // Execute the PowerShell script with elevation request
        const { stdout, stderr } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`);
        
        // Clean up the script file
        try {
            fs.unlinkSync(psScriptPath);
        } catch (e) {
            // Ignore cleanup errors
        }
        
        if (stdout.includes('SUCCESS')) {
            success('Scheduled task deleted successfully!');
            return true;
        } else if (stdout.includes('NOTFOUND')) {
            warning('No scheduled task found to delete');
            info('The task may have already been deleted');
            return true;
        } else {
            console.log('PowerShell output:', stdout);
            if (stderr) console.log('PowerShell errors:', stderr);
            return false;
        }
        
    } catch (err) {
        // Clean up script file in case of error
        try {
            fs.unlinkSync(psScriptPath);
        } catch (e) {
            // Ignore cleanup errors
        }
        
        error(`Failed to execute elevated deletion: ${err.message}`);
        console.log('\n💡 Alternative methods:');
        console.log('1. Open Task Scheduler manually:');
        console.log('   • Press Win+R, type "taskschd.msc", press Enter');
        console.log(`   • Find "${taskName}" in the task library`);
        console.log('   • Right-click and select "Delete"');
        console.log('\n2. Run Command Prompt as Administrator:');
        console.log('   • Right-click Command Prompt → "Run as administrator"');
        console.log(`   • Run: schtasks /delete /tn "${taskName}" /f`);
        
        return false;
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    deleteWindowsTaskWithElevation().then(success => {
        process.exit(success ? 0 : 1);
    });
}

export { deleteWindowsTaskWithElevation };