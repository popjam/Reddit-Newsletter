import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { defaultConfig } from './config.js';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userConfigPath = path.join(__dirname, 'user-config.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// (Keep all color and helper functions like colorize, log, header, etc. as they were)
const colors = { reset: '\x1b[0m', bright: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m' };
function colorize(text, color) { return colors[color] + text + colors.reset; }
function log(message, color = 'reset') { console.log(colorize(message, color)); }
function question(prompt, color = 'cyan') { return new Promise((resolve) => rl.question(colorize(prompt, color), resolve)); }
function header(text) { console.log('\n' + colorize('='.repeat(60), 'blue') + '\n' + colorize(text.toUpperCase().padStart((60 + text.length) / 2), 'bright') + '\n' + colorize('='.repeat(60), 'blue') + '\n'); }
function section(text) { console.log('\n' + colorize('--- ' + text + ' ---', 'yellow')); }
function success(text) { console.log(colorize('✅ ' + text, 'green')); }
function error(text) { console.log(colorize('❌ ' + text, 'red')); }
function warning(text) { console.log(colorize('⚠️ ' + text, 'yellow')); }
function info(text) { console.log(colorize('ℹ️ ' + text, 'blue')); }
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Platform detection functions
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

async function checkDependencies() {
    const platform = getPlatformInfo();
    const checks = {
        node: false,
        npm: false,
        imagemagick: false
    };

    // Check Node.js
    try {
        await execAsync('node --version');
        checks.node = true;
    } catch (e) {
        checks.node = false;
    }

    // Check npm
    try {
        await execAsync('npm --version');
        checks.npm = true;
    } catch (e) {
        checks.npm = false;
    }

    // Check ImageMagick
    try {
        const command = platform.isWindows ? 'magick -version' : 'convert -version';
        await execAsync(command);
        checks.imagemagick = true;
    } catch (e) {
        checks.imagemagick = false;
    }

    return checks;
}

async function displayPlatformInfo() {
    const platform = getPlatformInfo();
    const deps = await checkDependencies();

    info(`Platform: ${platform.platform} (${platform.arch})`);
    info(`Node.js: ${platform.nodeVersion}`);

    console.log('\nDependency Check:');
    success(`Node.js: ${deps.node ? '✅ Installed' : '❌ Missing'}`);
    success(`npm: ${deps.npm ? '✅ Installed' : '❌ Missing'}`);
    success(`ImageMagick: ${deps.imagemagick ? '✅ Installed' : '❌ Missing (optional for cover generation)'}`);

    if (!deps.node || !deps.npm) {
        error('Missing required dependencies. Please install Node.js from https://nodejs.org/');
        return false;
    }

    if (!deps.imagemagick) {
        warning('ImageMagick not found - cover generation will be disabled');
        if (platform.isWindows) {
            info('Download ImageMagick from: https://imagemagick.org/script/download.php#windows');
        } else {
            info('Install ImageMagick: sudo apt install imagemagick (Ubuntu) or brew install imagemagick (macOS)');
        }
    }

    return true;
}

async function setupScheduler() {
    const platform = getPlatformInfo();

    section('Automatic Scheduling Setup (Optional)');
    info('Set up automatic newsletter generation to run on schedule');

    const setupSchedule = await question('Would you like to set up automatic scheduling? (y/n): ');
    if (setupSchedule.toLowerCase() !== 'y') {
        return;
    }

    return await configureSchedule(platform);
}

async function configureSchedule(platform) {
    // Get frequency
    const frequency = await question('How often should it run? (1=daily, 2=weekly): ');
    const isWeekly = frequency === '2';

    let weekday = null;
    if (isWeekly) {
        console.log('\nWeekdays: 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday');
        const weekdayInput = await question('Which day of the week? (1-7): ');
        weekday = parseInt(weekdayInput) || 1;
    }

    // Get time in 24-hour format
    const timeInput = await question('What time should it run? (24-hour format, e.g., "07:00" or "19:30"): ');
    const time = timeInput.trim() || '07:00';

    // Validate time format
    const timeRegex = /^([0-1]?\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
        warning('Invalid time format. Using default 07:00');
        time = '07:00';
    }

    const scheduleType = isWeekly ? 'weekly' : 'daily';
    const scheduleDesc = isWeekly ? `weekly on ${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday]}` : 'daily';

    info(`Setting up ${scheduleDesc} at ${formatTime12Hour(time)}`);

    try {
        if (platform.isWindows) {
            await setupWindowsScheduler(time, isWeekly, weekday);
        } else {
            await setupLinuxScheduler(time, isWeekly, weekday);
        }
    } catch (err) {
        error(`Failed to set up automatic scheduling: ${err?.message || err?.toString() || 'Unknown error'}`);
        info('You can set this up manually later using "npm run schedule-setup"');
    }
}

function formatTime12Hour(time24) {
    const [hours, minutes] = time24.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${displayHour}:${minutes} ${ampm}`;
}

async function setupWindowsScheduler(time, isWeekly = false, weekday = null) {
    info('Setting up Windows Task Scheduler...');

    const taskName = 'Reddit Newsletter Generator';
    const scriptPath = path.join(__dirname, 'run-newsletter.bat');
    const scheduleType = isWeekly ? 'weekly' : 'daily';
    const description = `${isWeekly ? 'Weekly' : 'Daily'} generation of Reddit newsletter`;

    // Write PowerShell script to temporary file
    const psScriptPath = path.join(__dirname, 'temp-scheduler-setup.ps1');

    let triggerScript;
    if (isWeekly) {
        // Convert weekday number to PowerShell DaysOfWeek enum
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
    $Action = New-ScheduledTaskAction -Execute $ScriptPath -WorkingDirectory $WorkingDirectory
    
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
        // Write PowerShell script to file
        fs.writeFileSync(psScriptPath, psScript);

        // Execute PowerShell script
        const { stdout, stderr } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`);

        // Clean up temporary script file
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
        // Clean up temporary script file in case of error
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

    // Convert time to cron format
    const [hours, minutes = '0'] = time.split(':');
    let cronTime;

    if (isWeekly) {
        // Cron uses 0=Sunday, 1=Monday, etc. Our input uses 1=Monday, 7=Sunday
        const cronWeekday = weekday === 7 ? 0 : weekday;
        cronTime = `${minutes} ${hours} * * ${cronWeekday}`;
    } else {
        cronTime = `${minutes} ${hours} * * *`;
    }

    const cronJob = `${cronTime} cd "${__dirname}" && bash run-newsletter.sh`;

    try {
        // Get existing crontab
        let existingCrontab = '';
        try {
            const { stdout } = await execAsync('crontab -l');
            existingCrontab = stdout;
        } catch (e) {
            // No existing crontab is fine
        }

        // Remove any existing reddit newsletter cron jobs
        const filteredCrontab = existingCrontab
            .split('\n')
            .filter(line => !line.includes('run-newsletter.sh'))
            .filter(line => line.trim() !== '')
            .join('\n');

        // Add new cron job
        const newCrontab = filteredCrontab + (filteredCrontab ? '\n' : '') + cronJob + '\n';

        // Install new crontab
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

// Function to load existing user config or use defaults
function loadInitialConfig() {
    let currentConfig = JSON.parse(JSON.stringify(defaultConfig)); // Deep copy
    if (fs.existsSync(userConfigPath)) {
        try {
            const existingUserConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
            // Deep merge existing user config onto defaults
            const deepMerge = (target, source) => {
                for (const key in source) {
                    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                        if (!target[key]) Object.assign(target, { [key]: {} });
                        deepMerge(target[key], source[key]);
                    } else {
                        Object.assign(target, { [key]: source[key] });
                    }
                }
                return target;
            };
            currentConfig = deepMerge(currentConfig, existingUserConfig);
            info('Loaded existing settings from user-config.json');
        } catch (e) {
            error('Could not parse user-config.json, starting with defaults.');
        }
    }
    return currentConfig;
}

async function setupEmail(config) {
    section('Email Configuration');
    log('Choose your email provider: 1. Gmail (requires App Password) 2. GMX');
    const providerChoice = await question(`Select provider (1 or 2) [${config.email.provider}]: `) || config.email.provider;
    config.email.provider = providerChoice === '1' ? 'gmail' : (providerChoice === '2' ? 'gmx' : config.email.provider);

    if (config.email.provider === 'gmail') {
        const email = await question(`Enter your Gmail address [${config.email.gmail.email}]: `) || config.email.gmail.email;
        const appPassword = await question(`Enter your Gmail App Password: `);
        config.email.gmail = { email, appPassword };
    } else {
        const email = await question(`Enter your GMX email address [${config.email.gmx.email}]: `) || config.email.gmx.email;
        const password = await question(`Enter your GMX password: `);
        config.email.gmx = { email, password };
    }

    const kindleEmail = await question(`Enter your Kindle email [${config.email.kindle.email}]: `) || config.email.kindle.email;
    config.email.kindle.email = kindleEmail;
    success('Email configuration completed!');
}

async function setupRedditOAuth(config) {
    section('Reddit OAuth Configuration');
    const useOAuth = await question(`Enable Reddit OAuth for better rate limits? (y/n) [${config.reddit.enableOAuth2 ? 'y' : 'n'}]: `) || (config.reddit.enableOAuth2 ? 'y' : 'n');
    config.reddit.enableOAuth2 = useOAuth.toLowerCase() === 'y';

    if (config.reddit.enableOAuth2) {
        info('Create a "script" type app at https://www.reddit.com/prefs/apps');
        const clientId = await question(`Enter your Reddit app Client ID [${config.reddit.oauth2.clientId}]: `) || config.reddit.oauth2.clientId;
        const clientSecret = await question('Enter your Reddit app Client Secret: ');
        const username = await question(`Enter your Reddit username [${config.reddit.oauth2.username}]: `) || config.reddit.oauth2.username;
        const password = await question('Enter your Reddit password: ');
        config.reddit.oauth2 = { clientId, clientSecret, userAgent: `RedditToKindle/2.0.0 by ${username}`, username, password };
        success('Reddit OAuth configured!');
    }
}

async function setupNewsletter(config) {
    section('Newsletter Content');
    // Ensure subreddits are strings when displaying
    const displaySubreddits = config.reddit.subreddits
        .map(sub => typeof sub === 'string' ? sub : sub.toString())
        .filter(sub => sub && sub !== '[object Object]');

    const subredditsInput = await question(`Enter subreddits, comma-separated [${displaySubreddits.join(', ')}]: `) || displaySubreddits.join(', ');
    config.reddit.subreddits = subredditsInput.split(',').map(s => s.trim()).filter(Boolean);

    const posts = await question(`Posts per subreddit [${config.reddit.defaults.postsPerSubreddit}]: `) || config.reddit.defaults.postsPerSubreddit;
    config.reddit.defaults.postsPerSubreddit = parseInt(posts, 10);

    const comments = await question(`Comments per post [${config.reddit.defaults.commentsPerPost}]: `) || config.reddit.defaults.commentsPerPost;
    config.reddit.defaults.commentsPerPost = parseInt(comments, 10);

    const timeframe = await question(`Timeframe for 'top' posts (day, week, month) [${config.reddit.defaults.timeframe}]: `) || config.reddit.defaults.timeframe;
    config.reddit.defaults.timeframe = timeframe;

    const downloadImages = await question(`Download images? (y/n) [${config.reddit.downloadImages ? 'y' : 'n'}]: `) || (config.reddit.downloadImages ? 'y' : 'n');
    config.reddit.downloadImages = downloadImages.toLowerCase() === 'y';

    const randomizeOrder = await question(`Randomize subreddit order in newsletter? (y/n) [${config.reddit.randomizeSubredditOrder ? 'y' : 'n'}]: `) || (config.reddit.randomizeSubredditOrder ? 'y' : 'n');
    config.reddit.randomizeSubredditOrder = randomizeOrder.toLowerCase() === 'y';

    success('Newsletter content configured!');
}

async function setupCoverGeneration(config) {
    section('Cover Generation');
    info('The newsletter can automatically generate a book cover with the current date');

    const generateCover = await question(`Enable automatic cover generation? (y/n) [${config.epub.generateDatedCover ? 'y' : 'n'}]: `) || (config.epub.generateDatedCover ? 'y' : 'n');
    config.epub.generateDatedCover = generateCover.toLowerCase() === 'y';

    if (config.epub.generateDatedCover) {
        info('✅ Cover will be automatically generated with current date');
        info('📝 Requires ImageMagick to be installed');
    } else {
        info('📖 Using static cover image');
    }

    success('Cover generation configured!');
}

async function saveConfiguration(config) {
    section('Saving Configuration');
    // We only save the user-configurable parts, not the entire default config
    const userSettings = {
        email: {
            provider: config.email.provider,
            gmail: config.email.provider === 'gmail' ? config.email.gmail : undefined,
            gmx: config.email.provider === 'gmx' ? config.email.gmx : undefined,
            kindle: { email: config.email.kindle.email }
        },
        reddit: {
            enableOAuth2: config.reddit.enableOAuth2,
            oauth2: config.reddit.enableOAuth2 ? config.reddit.oauth2 : undefined,
            downloadImages: config.reddit.downloadImages,
            randomizeSubredditOrder: config.reddit.randomizeSubredditOrder,
            subreddits: config.reddit.subreddits,
            defaults: config.reddit.defaults
        },
        epub: {
            title: config.epub.title,
            simplifiedTOC: config.epub.simplifiedTOC,
            hierarchicalTOC: config.epub.hierarchicalTOC,
            generateDatedCover: config.epub.generateDatedCover
        }
    };

    try {
        fs.writeFileSync(userConfigPath, JSON.stringify(userSettings, null, 2));
        success(`Configuration saved to ${userConfigPath}`);

        // Ensure user-config.json is in .gitignore
        const gitignorePath = path.join(__dirname, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            let gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            if (!gitignoreContent.includes('user-config.json')) {
                fs.appendFileSync(gitignorePath, '\n# User configuration with sensitive data\nuser-config.json\n');
            }
        } else {
            fs.writeFileSync(gitignorePath, '# User configuration with sensitive data\nuser-config.json\n');
        }
    } catch (err) {
        error('Failed to save configuration: ' + err.message);
    }
}

async function runSetup() {
    header('Reddit to Kindle Setup Wizard');

    // Display platform info and check dependencies first
    const depsOk = await displayPlatformInfo();
    if (!depsOk) {
        rl.close();
        return;
    }

    const config = loadInitialConfig();

    await setupEmail(config);
    await setupRedditOAuth(config);
    await setupNewsletter(config);
    await setupCoverGeneration(config);
    await setupScheduler();

    console.log('\n');
    const confirm = await question('Save this configuration to user-config.json? (y/n): ');
    if (confirm.toLowerCase() === 'y') {
        await saveConfiguration(config);
        header('Setup Complete!');

        const platform = getPlatformInfo();
        log('Your Reddit to Kindle newsletter is now configured!', 'green');
        console.log('\nNext Steps:');
        console.log('  1. To generate your first newsletter, run:');
        console.log(colorize('     npm start', 'cyan'));

        console.log('\n  2. To check the status of your automated schedule, run:');
        console.log(colorize('     npm run check-schedule', 'cyan'));

        console.log('\n  3. To change your settings again at any time, run:');
        console.log(colorize('     npm run setup', 'cyan'));

    } else {
        warning('Configuration not saved.');
    }

    rl.close();
}

runSetup().catch(e => {
    error('An unexpected error occurred: ' + (e?.message || e?.toString() || 'Unknown error'));
    rl.close();
});