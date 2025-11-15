#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Image Quality Configuration Tool
 * Set image optimization presets for the Reddit to Kindle newsletter
 */

function showCurrentSettings() {
    const userConfigPath = path.join(__dirname, 'user-config.json');
    
    if (fs.existsSync(userConfigPath)) {
        try {
            const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
            const currentPreset = userConfig.reddit?.imageOptimizationPreset || 'default';
            console.log(`📸 Current image quality preset: ${currentPreset}`);
            return currentPreset;
        } catch (e) {
            console.log('⚠️  Error reading user-config.json');
            return 'default';
        }
    } else {
        console.log('📸 Current image quality preset: default (no user-config.json found)');
        return 'default';
    }
}

function setImageQuality(preset) {
    const userConfigPath = path.join(__dirname, 'user-config.json');
    
    let userConfig = {};
    if (fs.existsSync(userConfigPath)) {
        try {
            userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
        } catch (e) {
            console.log('⚠️  Error reading existing user-config.json, creating new one');
        }
    }
    
    // Ensure reddit section exists
    if (!userConfig.reddit) {
        userConfig.reddit = {};
    }
    
    userConfig.reddit.imageOptimizationPreset = preset;
    
    try {
        fs.writeFileSync(userConfigPath, JSON.stringify(userConfig, null, 2));
        console.log(`✅ Image quality preset set to: ${preset}`);
        
        // Show what this means
        if (preset === 'default') {
            console.log('   📊 JPEG Quality: 50, Convert threshold: 1MB');
        } else if (preset === 'aggressive') {
            console.log('   📊 JPEG Quality: 25, Convert threshold: 500KB');
            console.log('   💾 Significantly smaller file sizes, some quality loss');
        } else if (preset === 'extreme') {
            console.log('   📊 JPEG Quality: 15, Convert threshold: 200KB');
            console.log('   💾 Maximum compression, noticeable quality loss');
        }
        
    } catch (e) {
        console.log(`❌ Error saving config: ${e.message}`);
    }
}

function showHelp() {
    console.log('📸 Image Quality Configuration Tool\n');
    console.log('Usage:');
    console.log('  npm run image-quality                 Show current setting');
    console.log('  npm run image-quality default         High quality (50% JPEG, 1MB threshold)');
    console.log('  npm run image-quality aggressive      Medium quality (25% JPEG, 500KB threshold)');
    console.log('  npm run image-quality extreme         Low quality (15% JPEG, 200KB threshold)\n');
    console.log('Quality vs Size Trade-offs:');
    console.log('• default:    Best quality, larger EPUB files');
    console.log('• aggressive: Good balance, ~60-70% size reduction');
    console.log('• extreme:    Smallest files, ~80-90% size reduction\n');
    console.log('Note: Image dimensions (resolution) are not affected by these presets.');
}

// Main execution
const args = process.argv.slice(2);
const command = args[0];

if (!command) {
    showCurrentSettings();
} else if (['default', 'aggressive', 'extreme'].includes(command)) {
    setImageQuality(command);
} else if (command === 'help' || command === '--help' || command === '-h') {
    showHelp();
} else {
    console.log(`❌ Unknown preset: ${command}`);
    console.log('Valid options: default, aggressive, extreme');
    console.log('Run "npm run image-quality help" for more information.');
}