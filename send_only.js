/**
 * Send Only Script
 * 
 * This script only sends the most recent EPUB file to Kindle
 * without regenerating it. Useful for testing email functionality.
 */

import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- UNIFIED CONFIGURATION LOADER ---
function loadConfig() {
    let finalConfig = JSON.parse(JSON.stringify(defaultConfig)); // Deep copy defaults
    const userConfigPath = path.join(__dirname, 'user-config.json');

    if (fsSync.existsSync(userConfigPath)) {
        try {
            const userConfig = JSON.parse(fsSync.readFileSync(userConfigPath, 'utf8'));
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
            console.log('ℹ️  Loaded and merged email settings from user-config.json');
        } catch (e) {
            console.log(`⚠️  Could not parse user-config.json, using default email settings. Error: ${e.message}`);
        }
    } else {
        console.log('⚠️  user-config.json not found. Cannot send email. Please run "npm run setup".');
        return null; // Return null if config is missing
    }
    return finalConfig;
}

const config = loadConfig();
if (!config) {
    process.exit(1);
}

// Get email configuration
const { email: emailConfig } = config;
const { gmail, gmx, kindle } = emailConfig;

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
                    connectionTimeout: 900000, // 15 minutes
                    greetingTimeout: 900000,   // 15 minutes
                    socketTimeout: 900000,     // 15 minutes
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
    const files = fsSync.readdirSync(__dirname);
    const epubFiles = files
        .filter(file => file.startsWith('reddit_') && file.endsWith('.epub'))
        .map(file => ({
            name: file,
            path: path.join(__dirname, file),
            mtime: fsSync.statSync(path.join(__dirname, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
    
    if (epubFiles.length > 0) {
        return {
            filename: epubFiles[0].name,
            path: epubFiles[0].path
        };
    }
    throw new Error('No EPUB files found. Please run the generator first.');
}


// Main logic to send the email
async function sendEpub() {
    try {
        const epubInfo = getMostRecentEpubFile();
        console.log(`📖 Found EPUB: ${epubInfo.filename}`);
        
        const data = await fs.readFile(epubInfo.path);
        const fileSizeMB = (data.length / 1024 / 1024).toFixed(1);
        
        console.log(`📊 File size: ${fileSizeMB}MB`);
        console.log(`📧 Sending to: ${kindle.email}`);
        console.log(`⏳ This may take several minutes for large files...`);
        
        // Get email provider configuration
        const providerConfig = getEmailProviderConfig(emailConfig);
        const transporter = nodemailer.createTransport(providerConfig.transport);
        
        const startTime = Date.now();
        
        const mailOptions = {
            from: providerConfig.from,
            to: kindle.email,
            subject: kindle.subject,
            text: kindle.message,
            attachments: [
                {
                    filename: epubInfo.filename,
                    content: data,
                    contentType: 'application/epub+zip',
                },
            ],
        };

        const info = await transporter.sendMail(mailOptions);
        const duration = Math.round((Date.now() - startTime) / 1000);
        
        console.log(`✅ Email sent successfully in ${duration} seconds!`);
        console.log(`📱 Response: ${info.response}`);
        console.log(`📚 Your EPUB should appear on your Kindle shortly.`);

    } catch (err) {
        console.error('❌ An error occurred:', err.message);
        process.exit(1);
    }
}

// Run the function
console.log('🚀 Reddit to Kindle - Email Only Mode');
console.log('=====================================\n');
sendEpub();