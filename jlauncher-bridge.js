#!/usr/bin/env node
/**
 * JLauncher bridge: lets JLauncher on the phone start the daily or weekly newsletter on this PC,
 * follow its progress, change its settings and read the finished issues.
 *
 * Both sides use the same Firebase Realtime Database as JLauncher's lockdown sync, through its plain
 * web API, under the phone's pairing key (inside /lockdown, which the database's rules allow):
 *   .../newsletter/requests/<id>   what the phone asks for, each done once and then removed:
 *                                  {type: "run", profile} | {type: "stop"} | {type: "settings", profile, settings}
 *   .../newsletter/status          the current or last run: state, profile, stage, percent, epub...
 *   .../newsletter/profiles/<p>    each profile's settings, without email or Reddit credentials
 *   .../newsletter/issues          the issues on Google Drive, newest first
 *   .../newsletter/bridge          when this PC was last heard from
 * where ... is /lockdown/<key>.
 *
 * Finished issues are copied to Google Drive (G:\My Drive\JLauncher\Newsletter by default), where
 * the phone reads them.
 *
 * Settings: %LOCALAPPDATA%\JLauncher\newsletter-bridge.json, {"url": "...", "key": "..."} at least.
 * Started at sign-in by the scheduled task install-jlauncher-bridge.ps1 adds.
 *
 *   node jlauncher-bridge.js            run until stopped
 *   node jlauncher-bridge.js --once     check for requests once, publish settings and issues, and exit
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { defaultConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = 1;

const POLL_MS = 10_000;
const PROGRESS_MS = 2_000;
const HEARTBEAT_MS = 5 * 60_000;
const REQUEST_MAX_AGE_MS = 60 * 60_000;

// --- Settings the phone can see and change ---

export const ENUMS = {
    sourceMode: ['html', 'rss', 'json', 'auto'],
    imageOptimizationPreset: ['default', 'aggressive', 'extreme'],
    sort: ['hot', 'new', 'top', 'rising', 'controversial'],
    timeframe: ['hour', 'day', 'week', 'month', 'year', 'all'],
    commentStyle: ['threaded', 'nested', 'html'],
};

/** The per-subreddit settings, with their types; a subreddit can override any of them */
export const DEFAULT_KEYS = {
    postsPerSubreddit: 'int',
    commentsPerPost: 'int',
    includeInternalLinks: 'bool',
    includeVideoContent: 'bool',
    skipImageAndGalleryPosts: 'bool',
    skipUnfetchableArticles: 'bool',
    skipAutoModerator: 'bool',
    allowImagePostsIfCantFindOtherPosts: 'bool',
    commentStyle: 'commentStyle',
    showNestedCommentGuideLines: 'bool',
    maxCommentDepth: 'int',
    minCommentLength: 'int',
    sort: 'sort',
    timeframe: 'timeframe',
};

const REDDIT_KEYS = {
    sourceMode: 'sourceMode',
    downloadImages: 'bool',
    randomizeSubredditOrder: 'bool',
    imageOptimizationPreset: 'imageOptimizationPreset',
};

const EPUB_KEYS = {
    title: 'string',
    simplifiedTOC: 'bool',
    hierarchicalTOC: 'bool',
    generateDatedCover: 'bool',
};

function cleanValue(type, value) {
    switch (type) {
        case 'bool':
            return typeof value === 'boolean' ? value : undefined;
        case 'int': {
            const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
            return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : undefined;
        }
        case 'string':
            return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
        default:
            return ENUMS[type]?.includes(value) ? value : undefined;
    }
}

function cleanObject(keys, source) {
    const out = {};
    if (!source || typeof source !== 'object') return out;
    for (const [key, type] of Object.entries(keys)) {
        const value = cleanValue(type, source[key]);
        if (value !== undefined) out[key] = value;
    }
    return out;
}

/** A subreddit entry as the program reads it: a plain name, or {name, ...overrides} */
export function cleanSubreddit(entry) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{2,40}$/.test(name.trim())) return null;
    if (typeof entry === 'string') return name.trim();
    const overrides = cleanObject(DEFAULT_KEYS, entry);
    return Object.keys(overrides).length ? { name: name.trim(), ...overrides } : name.trim();
}

/** Firebase gives arrays back as objects when they have gaps */
function asList(value) {
    if (Array.isArray(value)) return value.filter(v => v !== null && v !== undefined);
    if (value && typeof value === 'object') {
        return Object.keys(value).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => value[k]);
    }
    return [];
}

/** Only the settings the phone may change, checked, from whatever it sent */
export function cleanSettings(settings) {
    const reddit = settings?.reddit ?? {};
    const out = {
        reddit: {
            ...cleanObject(REDDIT_KEYS, reddit),
            defaults: cleanObject(DEFAULT_KEYS, reddit.defaults),
        },
        epub: cleanObject(EPUB_KEYS, settings?.epub),
    };
    if ('subreddits' in reddit) {
        out.reddit.subreddits = asList(reddit.subreddits).map(cleanSubreddit).filter(Boolean);
    }
    return out;
}

/** What a profile's file holds, merged onto the program's defaults, for the phone */
export function publicSettings(userConfig) {
    const reddit = userConfig?.reddit ?? {};
    const epub = userConfig?.epub ?? {};
    const pick = (keys, base, over) => cleanObject(keys, { ...base, ...over });
    return {
        reddit: {
            ...pick(REDDIT_KEYS, defaultConfig.reddit, reddit),
            defaults: pick(DEFAULT_KEYS, defaultConfig.reddit.defaults, reddit.defaults),
            subreddits: asList(reddit.subreddits ?? defaultConfig.reddit.subreddits).map(cleanSubreddit).filter(Boolean),
        },
        epub: pick(EPUB_KEYS, defaultConfig.epub, epub),
    };
}

/** The profile's file with the phone's changes in it; email, credentials and anything else are kept */
export function applySettings(userConfig, settings) {
    const clean = cleanSettings(settings);
    const next = JSON.parse(JSON.stringify(userConfig ?? {}));
    next.reddit = { ...(next.reddit ?? {}) };
    const { defaults, subreddits, ...rest } = clean.reddit;
    Object.assign(next.reddit, rest);
    next.reddit.defaults = { ...(next.reddit.defaults ?? {}), ...defaults };
    if (subreddits && subreddits.length) next.reddit.subreddits = subreddits;
    next.epub = { ...(next.epub ?? {}), ...clean.epub };
    return next;
}

// --- Progress ---

/** How far along a run is, 0-100, from what the program last wrote */
export function percentOf(progress) {
    if (!progress) return 0;
    switch (progress.stage) {
        case 'subreddits':
            return progress.total > 0 ? Math.min(90, Math.floor((progress.index / progress.total) * 90)) : 0;
        case 'book': return 92;
        case 'send': return 96;
        case 'done': return 100;
        default: return 0;
    }
}

// --- Issues on Drive ---

const ISSUE_RE = /^(daily|weekly|[a-z0-9-]+)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})\.epub$/;

/** "daily_2026-11-23_21-40.epub" from "reddit_2026-11-23_21-40.epub" */
export function issueName(profile, epub) {
    const m = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})\.epub$/.exec(epub ?? '');
    const stamp = m ? m[1] : new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    return `${profile}_${stamp}.epub`;
}

/** The issues in a folder listing, newest first, and which ones are past what's kept */
export function sortIssues(files, keep) {
    const issues = files
        .map(f => ({ f, m: ISSUE_RE.exec(f.name) }))
        .filter(x => x.m)
        .map(({ f, m }) => ({ file: f.name, profile: m[1], date: `${m[2]} ${m[3]}:${m[4]}`, size: f.size }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const seen = {};
    const kept = [];
    const extra = [];
    for (const issue of issues) {
        seen[issue.profile] = (seen[issue.profile] ?? 0) + 1;
        (seen[issue.profile] <= (keep[issue.profile] ?? 4) ? kept : extra).push(issue);
    }
    return { kept, extra };
}

// --- Keeping secrets out of what's sent ---

function secretsOf(userConfig) {
    const e = userConfig?.email ?? {};
    const o = userConfig?.reddit?.oauth2 ?? {};
    let cookie = '';
    try { cookie = fs.readFileSync(path.join(__dirname, '.reddit-cookie'), 'utf8').trim(); } catch { /* none */ }
    return [e.gmx?.password, e.gmail?.appPassword, o.clientSecret, o.password, cookie, process.env.REDDIT_COOKIE]
        .filter(s => typeof s === 'string' && s.length >= 4);
}

export function scrub(text, secrets) {
    let out = String(text ?? '');
    for (const s of secrets) out = out.split(s).join('***');
    return out.replace(/reddit_session=[^;\s]+/g, 'reddit_session=***').replace(/token_v2=[^;\s]+/g, 'token_v2=***');
}

// --- The bridge ---

class Bridge {
    constructor(settings) {
        this.url = settings.url.trim().replace(/\/+$/, '');
        this.key = settings.key.trim();
        this.drive = settings.driveFolder ?? 'G:\\My Drive\\JLauncher\\Newsletter';
        this.keep = { daily: 7, weekly: 4, ...(settings.keep ?? {}) };
        this.profiles = { daily: 'user-config.daily.json', weekly: 'user-config.json', ...(settings.profiles ?? {}) };
        this.local = settings.localFolder;
        this.child = null;
        this.run = null;
        this.pendingCopies = [];
        this.lastHeartbeat = 0;
        this.lastProfilesSent = {};
    }

    log(message) {
        const line = `${new Date().toISOString()} ${message}\n`;
        process.stdout.write(line);
        try {
            const file = path.join(this.local, 'newsletter-bridge.log');
            if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.old`);
            fs.appendFileSync(file, line);
        } catch { /* logging is best effort */ }
    }

    endpoint(p) { return `${this.url}/lockdown/${this.key}/newsletter/${p}.json`; }

    async request(method, p, body) {
        const res = await fetch(this.endpoint(p), {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status}`);
        return method === 'GET' ? res.json() : null;
    }

    profilePath(profile) {
        const file = this.profiles[profile];
        return file ? path.join(__dirname, file) : null;
    }

    readProfile(profile) {
        const file = this.profilePath(profile);
        if (!file || !fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    async setStatus(fields) {
        this.status = { ...(this.status ?? {}), ...fields, at: Date.now() };
        await this.request('PUT', 'status', this.status);
    }

    // Settings

    async publishProfiles(force = false) {
        for (const profile of Object.keys(this.profiles)) {
            const file = this.profilePath(profile);
            if (!file || !fs.existsSync(file)) continue;
            const changed = fs.statSync(file).mtimeMs;
            if (!force && this.lastProfilesSent[profile] === changed) continue;
            const settings = publicSettings(this.readProfile(profile));
            await this.request('PUT', `profiles/${profile}`, { settings, updatedAt: Date.now() });
            this.lastProfilesSent[profile] = changed;
        }
    }

    async applySettingsRequest(req) {
        const user = this.readProfile(req.profile);
        if (!user) return this.log(`Settings for unknown profile "${req.profile}" ignored`);
        const next = applySettings(user, req.settings);
        const file = this.profilePath(req.profile);
        fs.copyFileSync(file, `${file}.bak`);
        fs.writeFileSync(file, JSON.stringify(next, null, 2));
        this.log(`Settings for ${req.profile} changed from the phone`);
        await this.publishProfiles(true);
    }

    // Runs

    async startRun(id, req) {
        if (this.child) return this.log(`Run request for ${req.profile} ignored: a run is going`);
        const file = this.profilePath(req.profile);
        if (!file || !fs.existsSync(file)) {
            return this.setStatus({ state: 'failed', profile: req.profile, message: `No settings file for ${req.profile}`, finishedAt: Date.now(), requestId: id });
        }
        const progressFile = path.join(this.local, 'newsletter-progress.json');
        try { fs.rmSync(progressFile, { force: true }); } catch { /* none */ }
        const logFile = path.join(__dirname, 'newsletter-log.txt');
        try { fs.rmSync(logFile, { force: true }); } catch { /* none */ }

        this.run = { id, profile: req.profile, progressFile, logFile, startedAt: Date.now(), stopped: false, lastProgress: '' };
        this.child = spawn(process.execPath, ['--no-deprecation', 'index.js', '--send'], {
            cwd: __dirname,
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, REDDIT_CONFIG: this.profiles[req.profile], NEWSLETTER_PROGRESS_FILE: progressFile, LOG_FILE: logFile },
        });
        this.log(`Started ${req.profile} (pid ${this.child.pid})`);
        this.status = {};
        await this.setStatus({ state: 'running', profile: req.profile, requestId: id, startedAt: this.run.startedAt, stage: 'starting', percent: 0 });

        this.child.on('exit', code => { this.finishRun(code).catch(e => this.log(`Finishing the run failed: ${e.message}`)); });
        this.progressTimer = setInterval(() => this.checkProgress().catch(e => this.log(`Progress: ${e.message}`)), PROGRESS_MS);
    }

    readProgress() {
        try { return JSON.parse(fs.readFileSync(this.run.progressFile, 'utf8')); } catch { return null; }
    }

    async checkProgress() {
        if (!this.run) return;
        const raw = (() => { try { return fs.readFileSync(this.run.progressFile, 'utf8'); } catch { return ''; } })();
        if (!raw || raw === this.run.lastProgress) return;
        this.run.lastProgress = raw;
        const p = this.readProgress();
        if (!p) return;
        await this.setStatus({
            stage: p.stage,
            index: p.index ?? null,
            total: p.total ?? null,
            subreddit: p.subreddit ?? null,
            percent: percentOf(p),
            epub: p.epub ?? this.status?.epub ?? null,
        });
    }

    async stopRun() {
        if (!this.child) return;
        this.run.stopped = true;
        this.log(`Stopping pid ${this.child.pid}`);
        await new Promise(resolve => execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], () => resolve()));
    }

    lastErrorLine(secrets) {
        try {
            const lines = fs.readFileSync(this.run.logFile, 'utf8').split(/\r?\n/).filter(l => /\[(ERROR|FATAL)/.test(l));
            const last = lines.at(-1);
            return last ? scrub(last.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*/, ''), secrets).slice(0, 200) : null;
        } catch { return null; }
    }

    async finishRun(code) {
        clearInterval(this.progressTimer);
        await this.checkProgress().catch(() => {});
        const run = this.run;
        const progress = this.readProgress();
        const secrets = secretsOf(this.readProfile(run.profile));
        this.child = null;
        this.run = null;

        const epub = progress?.epub;
        if (epub && fs.existsSync(path.join(__dirname, epub))) {
            this.pendingCopies.push({ from: path.join(__dirname, epub), name: issueName(run.profile, epub) });
        }
        const sent = code === 0 && progress?.stage === 'done';
        const state = run.stopped ? 'stopped' : sent ? 'sent' : 'failed';
        const message = state === 'failed' ? (this.lastErrorLine(secrets) ?? `Exited with code ${code}`) : null;
        this.log(`Run of ${run.profile} ended: ${state}${message ? ` (${message})` : ''}`);
        await this.setStatus({
            state,
            finishedAt: Date.now(),
            percent: sent ? 100 : this.status?.percent ?? 0,
            message,
            issue: this.pendingCopies.at(-1)?.name ?? null,
        });
        await this.syncIssues();
    }

    // Issues

    async syncIssues() {
        if (!fs.existsSync(path.dirname(this.drive))) return; // Drive isn't mounted yet; try again later
        fs.mkdirSync(this.drive, { recursive: true });
        while (this.pendingCopies.length) {
            const { from, name } = this.pendingCopies[0];
            if (fs.existsSync(from)) fs.copyFileSync(from, path.join(this.drive, name));
            this.log(`Copied ${name} to Drive`);
            this.pendingCopies.shift();
        }
        const files = fs.readdirSync(this.drive).map(name => {
            try { return { name, size: fs.statSync(path.join(this.drive, name)).size }; } catch { return null; }
        }).filter(Boolean);
        const { kept, extra } = sortIssues(files, this.keep);
        for (const issue of extra) {
            fs.rmSync(path.join(this.drive, issue.file), { force: true });
            this.log(`Removed old issue ${issue.file}`);
        }
        const listing = JSON.stringify(kept);
        if (listing !== this.lastIssues) {
            await this.request('PUT', 'issues', kept.length ? kept : null);
            this.lastIssues = listing;
        }
    }

    // Requests

    async checkRequests() {
        const requests = await this.request('GET', 'requests');
        if (!requests) return;
        for (const id of Object.keys(requests).sort()) {
            const req = requests[id];
            await this.request('DELETE', `requests/${id}`);
            if (!req || typeof req !== 'object') continue;
            const age = Date.now() - (Number(req.at) || 0);
            this.log(`Request ${id}: ${req.type}${req.profile ? ` ${req.profile}` : ''}`);
            if (req.type === 'run') {
                if (age > REQUEST_MAX_AGE_MS) {
                    await this.setStatus({ state: 'expired', profile: req.profile, requestId: id, finishedAt: Date.now(), message: null });
                } else {
                    await this.startRun(id, req);
                }
            } else if (req.type === 'stop') {
                await this.stopRun();
            } else if (req.type === 'settings') {
                await this.applySettingsRequest(req);
            }
        }
    }

    async heartbeat(force = false) {
        if (!force && Date.now() - this.lastHeartbeat < HEARTBEAT_MS) return;
        await this.request('PATCH', 'bridge', { seen: Date.now(), version: VERSION, host: os.hostname() });
        this.lastHeartbeat = Date.now();
    }

    async tick() {
        for (const step of [() => this.checkRequests(), () => this.publishProfiles(), () => this.syncIssues(), () => this.heartbeat()]) {
            try { await step(); } catch (e) { this.log(e.message); }
        }
    }

    async start(once) {
        this.log(`Bridge started${once ? ' (once)' : ''}`);
        try {
            this.status = (await this.request('GET', 'status')) ?? {};
            // A run that was going when this PC stopped can't be followed any more
            if (this.status.state === 'running') await this.setStatus({ state: 'failed', message: 'The PC stopped during the run', finishedAt: Date.now() });
            await this.heartbeat(true);
            await this.publishProfiles(true);
        } catch (e) { this.log(e.message); }
        await this.tick();
        if (once) return;
        setInterval(() => this.tick(), POLL_MS);
    }
}

function loadBridgeSettings() {
    const local = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'JLauncher');
    fs.mkdirSync(local, { recursive: true });
    const file = path.join(local, 'newsletter-bridge.json');
    if (!fs.existsSync(file)) {
        console.error(`Missing ${file}. Put {"url": "<Firebase database URL>", "key": "<pairing key>"} in it.`);
        process.exit(1);
    }
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!settings.url || !settings.key) {
        console.error(`${file} needs "url" and "key".`);
        process.exit(1);
    }
    return { ...settings, localFolder: local };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const bridge = new Bridge(loadBridgeSettings());
    bridge.start(process.argv.includes('--once'));
}
