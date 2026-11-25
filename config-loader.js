/**
 * Loads the settings a run uses: the program's defaults (config.js), then what every newsletter shares
 * (user-config.shared.json: email, Reddit login, images, the book's look), then the profile's own file
 * (user-config.json for the weekly, user-config.daily.json for the daily, or REDDIT_CONFIG), each
 * over the one before. A profile can still set a shared setting its own way by putting it in its file.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SHARED_FILE = 'user-config.shared.json';

/**
 * The settings that belong in the shared file rather than a profile's, by section. Moving a profile
 * over takes these out of it.
 */
export const SHARED_KEYS = {
    email: null, // the whole section
    reddit: ['enableOAuth2', 'oauth2', 'sourceMode', 'downloadImages', 'imageOptimizationPreset', 'galleryFirstImageOnly', 'articleImages'],
    epub: ['simplifiedTOC', 'hierarchicalTOC', 'generateDatedCover'],
};

export function deepMerge(target, source) {
    for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            deepMerge(target[key], source[key]);
        } else if (source[key] !== undefined) {
            target[key] = source[key];
        }
    }
    return target;
}

export function resolve(file) {
    return path.isAbsolute(file) ? file : path.join(__dirname, file);
}

/** The profile's file: REDDIT_CONFIG, or the weekly's user-config.json */
export function profilePath(file = process.env.REDDIT_CONFIG || 'user-config.json') {
    return resolve(file);
}

export function sharedPath() {
    return resolve(SHARED_FILE);
}

/** A JSON file's contents; null when it isn't there, and an error when it can't be read */
export function readJson(file) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The merged settings for [profileFile], and which files there were. [say] gets a line about each
 * file read or missing.
 */
export function loadUserConfig({ profileFile, say = () => {} } = {}) {
    const config = JSON.parse(JSON.stringify(defaultConfig));
    const found = { shared: false, profile: false };
    for (const [kind, file] of [['shared', sharedPath()], ['profile', profilePath(profileFile)]]) {
        const name = path.basename(file);
        try {
            const user = readJson(file);
            if (user) {
                deepMerge(config, user);
                found[kind] = true;
                say(`ℹ️  Loaded settings from ${name}`);
            } else {
                say(`ℹ️  ${name} not found`);
            }
        } catch (e) {
            say(`⚠️  Could not parse ${name}, leaving it out. Error: ${e.message}`);
        }
    }
    return { config, found };
}

/** [profile] split into what's shared and what's its own: { shared, own } */
export function splitShared(profile) {
    const shared = {};
    const own = JSON.parse(JSON.stringify(profile ?? {}));
    for (const [section, keys] of Object.entries(SHARED_KEYS)) {
        if (!own[section]) continue;
        if (keys === null) {
            shared[section] = own[section];
            delete own[section];
            continue;
        }
        for (const key of keys) {
            if (key in own[section]) {
                (shared[section] ??= {})[key] = own[section][key];
                delete own[section][key];
            }
        }
    }
    return { shared, own };
}
