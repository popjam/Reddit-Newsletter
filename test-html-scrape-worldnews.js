#!/usr/bin/env node

import fs from 'fs';

const BASE_URL = 'https://old.reddit.com';
const DEFAULT_SUBREDDIT = 'worldnews';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
    const inline = args.find(arg => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    if (index !== -1 && args[index + 1]) return args[index + 1];
    return fallback;
};

const subreddit = getArg('--subreddit', DEFAULT_SUBREDDIT).replace(/^r\//i, '');
const postLimit = Number.parseInt(getArg('--posts', '5'), 10);
const commentLimit = Number.parseInt(getArg('--comments', '5'), 10);
const outputPath = getArg('--out', `html-scrape-${subreddit}.json`);

function decodeHtml(value = '') {
    return value
        .replace(/&#32;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)));
}

function stripTags(html = '') {
    return decodeHtml(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

function getAttr(tag, name) {
    const pattern = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = tag.match(pattern);
    return match ? decodeHtml(match[1]) : '';
}

async function fetchHtml(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        });

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
        }

        return text;
    } finally {
        clearTimeout(timeout);
    }
}

function parseListingPosts(html) {
    const posts = [];
    const postStartRegex = /<div class=" thing[^>]*data-type="link"[^>]*>/gi;
    const starts = [...html.matchAll(postStartRegex)];

    for (let i = 0; i < starts.length; i++) {
        const tag = starts[i][0];
        const startIndex = starts[i].index;
        const endIndex = starts[i + 1]?.index ?? html.length;
        const segment = html.slice(startIndex, endIndex);
        const className = getAttr(tag, 'class');
        const permalink = getAttr(tag, 'data-permalink');
        const commentsCount = Number.parseInt(getAttr(tag, 'data-comments-count') || '0', 10);
        const score = Number.parseInt(getAttr(tag, 'data-score') || '0', 10);
        const author = getAttr(tag, 'data-author');
        const url = getAttr(tag, 'data-url');
        const id = getAttr(tag, 'data-fullname');

        if (!permalink || className.includes('stickied')) continue;
        if (url.includes('/live/')) continue;

        const titleMatch = segment.match(/<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
        const title = stripTags(titleMatch?.[1] || '');
        if (!title) continue;

        posts.push({
            id,
            title,
            author,
            score,
            commentsCount,
            url,
            permalink: `${BASE_URL}${permalink}`
        });
    }

    return posts;
}

function parseComments(html, limit) {
    const comments = [];
    const commentStartRegex = /<div class=" thing[^"]*id-t1_[^"]*comment[^"]*"[^>]*>/gi;
    const starts = [...html.matchAll(commentStartRegex)];

    for (let i = 0; i < starts.length && comments.length < limit; i++) {
        const tag = starts[i][0];
        const startIndex = starts[i].index;
        const endIndex = starts[i + 1]?.index ?? html.length;
        const segment = html.slice(startIndex, endIndex);
        const className = getAttr(tag, 'class');
        const author = getAttr(tag, 'data-author');
        const permalink = getAttr(tag, 'data-permalink');
        const id = getAttr(tag, 'data-fullname');

        if (!author || author === 'AutoModerator') continue;
        if (/\bdeleted\b/.test(className) || /\bcollapsed\b/.test(className)) continue;

        const bodyMatch = segment.match(/<div class="usertext-body[^"]*"[^>]*>\s*<div class="md">([\s\S]*?)<\/div>\s*<\/div>/i);
        const bodyHtml = bodyMatch?.[1] || '';
        const text = stripTags(bodyHtml);
        if (!text || text === '[deleted]' || text === '[removed]') continue;

        comments.push({
            id,
            author,
            text,
            bodyHtml: bodyHtml.trim(),
            permalink: permalink ? `${BASE_URL}${permalink}` : null
        });
    }

    return comments;
}

async function main() {
    const listingUrl = `${BASE_URL}/r/${encodeURIComponent(subreddit)}/`;
    console.log(`Fetching listing: ${listingUrl}`);
    const listingHtml = await fetchHtml(listingUrl);
    const posts = parseListingPosts(listingHtml).slice(0, postLimit);

    console.log(`Found ${posts.length} posts from r/${subreddit}`);

    for (const [index, post] of posts.entries()) {
        console.log(`\n[${index + 1}/${posts.length}] ${post.title}`);
        console.log(`  ${post.permalink}`);

        try {
            const commentHtml = await fetchHtml(post.permalink);
            post.comments = parseComments(commentHtml, commentLimit);
            console.log(`  scraped ${post.comments.length} comments`);
            for (const comment of post.comments.slice(0, 3)) {
                console.log(`  - ${comment.author}: ${comment.text.slice(0, 140).replace(/\s+/g, ' ')}${comment.text.length > 140 ? '...' : ''}`);
            }
        } catch (error) {
            post.comments = [];
            post.commentError = error.message;
            console.log(`  comment scrape failed: ${error.message}`);
        }

        if (index < posts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }

    const result = {
        source: 'old.reddit.com html',
        subreddit,
        listingUrl,
        scrapedAt: new Date().toISOString(),
        postLimit,
        commentLimit,
        posts
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\nWrote ${outputPath}`);
}

main().catch(error => {
    console.error(`Scrape failed: ${error.stack || error.message}`);
    process.exit(1);
});
