#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Cross-platform process checker for Reddit Newsletter
 * Returns true if the newsletter process is already running
 */
async function isNewsletterProcessRunning() {
    const isWindows = process.platform === 'win32';
    
    try {
        let command;
        const scriptNames = ['index.js', 'send_epub_to_kindle.js', 'send_only.js'];
        
        if (isWindows) {
            // Windows: Use wmic to get detailed process information
            command = 'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv';
        } else {
            // Linux/macOS: Use ps to find node processes
            command = 'ps aux | grep node';
        }
        
        const { stdout } = await execAsync(command);
        
        if (isWindows) {
            // On Windows, check if any node process contains our scripts
            const lines = stdout.split('\n');
            for (const line of lines) {
                const lowerLine = line.toLowerCase();
                if (scriptNames.some(script => lowerLine.includes(script))) {
                    return true;
                }
            }
            return false;
        } else {
            // On Linux/macOS, filter out grep itself and check for our scripts
            const lines = stdout.split('\n').filter(line => 
                scriptNames.some(script => line.includes(script)) && !line.includes('grep')
            );
            return lines.length > 0;
        }
        
    } catch (error) {
        // If we can't check processes, assume none are running
        console.warn('Warning: Could not check for running processes:', error.message);
        return false;
    }
}

/**
 * Terminate all Reddit Newsletter related processes
 */
async function killNewsletterProcesses() {
    const isWindows = process.platform === 'win32';
    
    try {
        const scriptNames = ['index.js', 'send_epub_to_kindle.js', 'send_only.js'];
        let killedProcesses = 0;
        
        if (isWindows) {
            // Windows: Use wmic to find processes, then taskkill to terminate
            const command = 'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv';
            const { stdout } = await execAsync(command);
            const lines = stdout.split('\n');
            
            for (const line of lines) {
                const lowerLine = line.toLowerCase();
                // Extract ProcessId from the CSV output
                const matches = line.match(/,(\d+),/);
                if (matches && scriptNames.some(script => lowerLine.includes(script))) {
                    const pid = matches[1];
                    try {
                        await execAsync(`taskkill /PID ${pid} /F`);
                        killedProcesses++;
                        console.log(`✅ Killed process ${pid} running newsletter script`);
                    } catch (killError) {
                        console.warn(`⚠️  Could not kill process ${pid}: ${killError.message}`);
                    }
                }
            }
        } else {
            // Linux/macOS: Use pkill with pattern matching
            for (const script of scriptNames) {
                try {
                    await execAsync(`pkill -f "${script}"`);
                    killedProcesses++;
                    console.log(`✅ Killed processes running ${script}`);
                } catch (killError) {
                    // pkill returns non-zero if no processes found, which is not an error
                    if (!killError.message.includes('No such process')) {
                        console.warn(`⚠️  Could not kill ${script} processes: ${killError.message}`);
                    }
                }
            }
        }
        
        return killedProcesses;
        
    } catch (error) {
        console.error('Error killing newsletter processes:', error.message);
        return 0;
    }
}

/**
 * Get platform-specific information
 */
function getPlatformInfo() {
    return {
        platform: process.platform,
        isWindows: process.platform === 'win32',
        isLinux: process.platform === 'linux',
        isMacOS: process.platform === 'darwin',
        arch: process.arch,
        nodeVersion: process.version
    };
}

// If called directly from command line
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    
    if (args.includes('--info')) {
        console.log(JSON.stringify(getPlatformInfo(), null, 2));
        process.exit(0);
    }
    
    if (args.includes('--check')) {
        try {
            const isRunning = await isNewsletterProcessRunning();
            console.log(isRunning ? 'RUNNING' : 'NOT_RUNNING');
            process.exit(isRunning ? 1 : 0);
        } catch (error) {
            console.error('Error checking processes:', error.message);
            process.exit(2);
        }
    }
    
    if (args.includes('--kill')) {
        try {
            console.log('🔍 Checking for newsletter processes...');
            const killedCount = await killNewsletterProcesses();
            if (killedCount > 0) {
                console.log(`✅ Successfully terminated ${killedCount} newsletter process(es)`);
            } else {
                console.log('ℹ️  No newsletter processes found running');
            }
            process.exit(0);
        } catch (error) {
            console.error('Error killing processes:', error.message);
            process.exit(2);
        }
    }
    
    console.log('Usage:');
    console.log('  node process-checker.js --check    Check if newsletter is running');
    console.log('  node process-checker.js --kill     Kill all newsletter processes');
    console.log('  node process-checker.js --info     Show platform information');
}

export { isNewsletterProcessRunning, killNewsletterProcesses, getPlatformInfo };