// --- START OF FILE send_epub_to_kindle.js (REVISED) ---

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultConfig } from './config.js'; // Import the base default config

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- UNIFIED CONFIGURATION LOADER ---
function getUserConfigPath() {
    const configFile = process.env.REDDIT_CONFIG || 'user-config.json';
    return path.isAbsolute(configFile) ? configFile : path.join(__dirname, configFile);
}

function loadConfig() {
    let finalConfig = JSON.parse(JSON.stringify(defaultConfig)); // Deep copy defaults
    const userConfigPath = getUserConfigPath();
    const userConfigName = path.basename(userConfigPath);

    if (fs.existsSync(userConfigPath)) {
        try {
            const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
            // Deep merge user config onto the defaults
            const deepMerge = (target, source) => {
                for (const key in source) {
                    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                        if (!target[key]) Object.assign(target, { [key]: {} });
                        deepMerge(target[key], source[key]);
                    } else if (source[key] !== undefined) {
                        Object.assign(target, { [key]: source[key] });
                    }
                }
                return target;
            };
            finalConfig = deepMerge(finalConfig, userConfig);
            console.log(`ℹ️  Loaded and merged email settings from ${userConfigName}`);
        } catch (e) {
            console.log(`⚠️  Could not parse ${userConfigName}, using default email settings. Error: ${e.message}`);
        }
    } else {
        console.log(`⚠️  ${userConfigName} not found. Cannot send email. Please run "npm run setup".`);
        return null; // Return null if config is missing
    }
    return finalConfig;
}

const config = loadConfig();
// --- END OF UNIFIED CONFIGURATION LOADER ---


// Function to get email provider configuration
function getEmailProviderConfig(emailConfig) {
    const { provider, gmail, gmx } = emailConfig;
    switch (provider) {
        case 'gmail':
            return {
                transport: {
                    host: 'smtp.gmail.com',
                    port: 465,
                    secure: true,
                    auth: {
                        user: gmail.email,
                        pass: gmail.appPassword,
                    }
                },
                from: `"Reddit Feed" <${gmail.email}>`,
            };
        case 'gmx':
            return {
                transport: {
                    host: 'mail.gmx.com',
                    port: 587,
                    secure: false,
                    connectionTimeout: 900000,
                    greetingTimeout: 900000,
                    socketTimeout: 900000,
                    tls: {
                        rejectUnauthorized: false
                    },
                    auth: {
                        user: gmx.email,
                        pass: gmx.password,
                    },
                    pool: true,
                    maxConnections: 1,
                    maxMessages: 1
                },
                from: `"Reddit Feed" <${gmx.email}>`,
            };
        default:
            throw new Error(`Unsupported email provider: ${provider}. Supported providers: 'gmail', 'gmx'`);
    }
}

// Function to find the most recent EPUB file
function getMostRecentEpubFile() {
    const files = fs.readdirSync(__dirname);
    const epubFiles = files
        .filter(file => file.startsWith('reddit_') && file.endsWith('.epub'))
        .map(file => ({
            name: file,
            path: path.join(__dirname, file),
            mtime: fs.statSync(path.join(__dirname, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);

    if (epubFiles.length > 0) {
        return {
            filename: epubFiles[0].name,
            path: epubFiles[0].path
        };
    }
    return null; // Return null if no EPUB found
}


// --- Main logic to send the email ---
async function sendEpub() {
    // Check if config was loaded successfully
    if (!config) {
        return; // Exit if the selected user config is missing
    }

    const { email: emailConfig } = config;

    try {
        const epubInfo = getMostRecentEpubFile();
        if (!epubInfo) {
            console.log('ℹ️  No EPUB file found to send. Skipping email step.');
            return;
        }

        console.log(`\n--- Sending EPUB to Kindle ---`);
        console.log(`Reading EPUB file: ${epubInfo.filename}...`);

        const data = fs.readFileSync(epubInfo.path);

        const emailProviderConfig = getEmailProviderConfig(emailConfig);
        // Create transporter inside retry function to ensure fresh connections

        console.log(`Sending email to ${emailConfig.kindle.email} via ${emailConfig.provider.toUpperCase()}...`);
        console.log(`File size: ${(data.length / 1024 / 1024).toFixed(1)}MB`);
        console.log('This may take several minutes for large files...');

        // Retry function with exponential backoff
        const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 5000) => {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    return await fn();
                } catch (error) {
                    if (attempt === maxRetries) {
                        throw error;
                    }
                    
                    const delay = baseDelay * Math.pow(2, attempt - 1);
                    console.log(`⚠️  Attempt ${attempt} failed: ${error.message}`);
                    console.log(`🔄 Retrying in ${delay / 1000} seconds... (${attempt}/${maxRetries})`);
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        };

        const sendMailWithRetry = async () => {
            const transporter = nodemailer.createTransport(emailProviderConfig.transport);
            
            const mailOptions = {
                from: emailProviderConfig.from,
                to: emailConfig.kindle.email,
                subject: emailConfig.kindle.subject,
                text: emailConfig.kindle.message,
                attachments: [
                    {
                        filename: epubInfo.filename,
                        content: data,
                        contentType: 'application/epub+zip',
                    },
                ],
            };

            return await transporter.sendMail(mailOptions);
        };

        const info = await retryWithBackoff(sendMailWithRetry, 3, 5000);
        console.log('✅ Email sent successfully!', info.response);
        console.log('Your EPUB should appear on your Kindle shortly.');

    } catch (err) {
        console.error('❌ Failed to send email after all retry attempts:', err);
        console.log('\n💡 Troubleshooting tips:');
        console.log('   • Check your internet connection');
        console.log('   • Verify your GMX email credentials');  
        console.log('   • Try again in a few minutes (GMX may be temporarily blocking)');
        process.exitCode = 1;
    }
}

// Run the function
sendEpub();
