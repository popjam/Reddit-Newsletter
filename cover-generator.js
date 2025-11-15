#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate a book cover with the current date
 * @param {Object} config - Configuration object with epub settings
 * @param {boolean} verbose - Enable verbose logging
 * @returns {Promise<boolean>} - Success status
 */
export async function generateDatedCover(config, verbose = false) {
    if (!config.epub.generateDatedCover) {
        if (verbose) console.log('ℹ️  Cover generation disabled');
        return true; // Not an error, just disabled
    }

    const baseCoverPath = path.join(__dirname, config.epub.baseCoverPath);
    const outputCoverPath = path.join(__dirname, 'epub_images', config.epub.outputCoverPath);

    // Check if base cover exists
    if (!fs.existsSync(baseCoverPath)) {
        console.log(`⚠️  Base cover not found: ${baseCoverPath}`);
        console.log('ℹ️  Using default EPUB generation without custom cover');
        return true; // Not a fatal error
    }

    try {
        // Check if ImageMagick is available
        const platform = process.platform;
        const magickCommand = platform === 'win32' ? 'magick' : 'convert';

        try {
            await execAsync(`${magickCommand} -version`);
        } catch (e) {
            console.log('⚠️  ImageMagick not found - cover generation disabled');
            console.log(`ℹ️  Install ImageMagick to enable automatic dated covers`);
            if (platform === 'win32') {
                console.log('   Download from: https://imagemagick.org/script/download.php#windows');
            } else {
                console.log('   Linux: sudo apt install imagemagick');
                console.log('   macOS: brew install imagemagick');
            }
            return true; // Not a fatal error
        }

        // Generate date text
        const now = new Date();
        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        const dateText = now.toLocaleDateString('en-US', options).toUpperCase();

        if (verbose) console.log(`ℹ️  Generating cover with date: ${dateText}`);

        // Generate cover with ImageMagick
        let command;
        if (platform === 'win32') {
            command = `magick "${baseCoverPath}" -gravity South -font Times-New-Roman -stroke "#000C" -strokewidth 2 -pointsize 150 -annotate +0+1400 "${dateText}" -stroke none -fill black -annotate +0+1400 "${dateText}" "${outputCoverPath}"`;
        } else {
            command = `convert "${baseCoverPath}" -gravity South -font Times-New-Roman -stroke "#000C" -strokewidth 2 -pointsize 150 -annotate +0+1400 "${dateText}" -stroke none -fill black -annotate +0+1400 "${dateText}" "${outputCoverPath}"`;
        }

        await execAsync(command);

        if (fs.existsSync(outputCoverPath)) {
            console.log('✅ Book cover updated with current date');
            return true;
        } else {
            throw new Error('Cover file not created');
        }

    } catch (error) {
        console.log(`❌ Failed to generate dated cover: ${error.message}`);
        console.log('ℹ️  Continuing with default EPUB generation');
        return false; // Cover generation failed, but not fatal
    }
}

/**
 * Standalone cover generation (for npm script)
 */
async function generateCoverStandalone() {
    try {
        // Load config
        const configPath = path.join(__dirname, 'user-config.json');
        const defaultConfigPath = path.join(__dirname, 'config.js');

        let config;
        if (fs.existsSync(configPath)) {
            const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const { defaultConfig } = await import('./config.js');

            // Merge configs
            config = { ...defaultConfig };
            if (userConfig.epub) {
                config.epub = { ...defaultConfig.epub, ...userConfig.epub };
            }
        } else {
            const { defaultConfig } = await import('./config.js');
            config = defaultConfig;
        }

        const success = await generateDatedCover(config, true);
        process.exit(success ? 0 : 1);

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
    }
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
    generateCoverStandalone();
}