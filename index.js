import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { format } from 'date-fns';
import Mercury from '@postlight/parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { decode } from 'html-entities';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { defaultConfig } from './config.js'; // Import the base default config
import { makeAuthenticatedRedditRequest, redditAuth } from './reddit-auth.js';
import { generateDatedCover } from './cover-generator.js';
import cliProgress from 'cli-progress';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- UNIFIED CONFIGURATION LOADER ---
function loadConfig() {
    let finalConfig = JSON.parse(JSON.stringify(defaultConfig)); // Deep copy defaults
    const userConfigPath = path.join(__dirname, 'user-config.json');

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
            console.log('ℹ️  Loaded and merged settings from user-config.json');
        } catch (e) {
            console.log(`⚠️  Could not parse user-config.json, using default settings. Error: ${e.message}`);
        }
    } else {
        console.log('ℹ️  user-config.json not found. Using default settings from config.js.');
        console.log('⚠️  Please run "npm run setup" to configure your credentials and subreddits.');
    }

    // Apply image optimization preset overrides
    applyImageOptimizationPreset(finalConfig);

    return finalConfig;
}

// Apply image optimization preset settings
function applyImageOptimizationPreset(config) {
    const preset = config.reddit.imageOptimizationPreset;

    if (preset === 'aggressive') {
        config.reddit.jpegQuality = 25;
        config.reddit.optimizationThreshold = 500 * 1024; // 500KB
    } else if (preset === 'extreme') {
        config.reddit.jpegQuality = 15;
        config.reddit.optimizationThreshold = 200 * 1024; // 200KB
    }
    // 'default' preset keeps original values
}

const config = loadConfig();
const { reddit: redditConfig, epub: epubConfig, version: SCRIPT_VERSION } = config;

// --- STATS TRACKER ---
// Stats are now defined below with progress tracking
// --- END OF STATS TRACKER ---

// --- RATE LIMITING & RETRY UTILITIES ---

let throttleUntil = 0; // NEW: Global timestamp for throttling. All API requests will pause until this time.
let consecutive429Errors = 0; // Track consecutive 429 errors for escalating backoff
let lastRateLimitTime = 0; // Track when we last got rate limited

// CONCURRENCY DISABLED - All operations now run sequentially
// Dynamic concurrency control - COMMENTED OUT
// let currentImageConcurrency = config.reddit.concurrency.maxConcurrentImages;
// let currentApiConcurrency = config.reddit.concurrency.maxConcurrentApiCalls;
// let consecutiveSuccesses = 0;
// let consecutiveFailures = 0;

// Create request queues with dynamic concurrency limits - COMMENTED OUT
// let imageQueue = pLimit(currentImageConcurrency);
// let apiQueue = pLimit(currentApiConcurrency);

// CONCURRENCY DISABLED - adjustConcurrency function commented out
// Function to adjust concurrency based on success/failure patterns - COMMENTED OUT
// function adjustConcurrency(isSuccess, type = 'api') {
//     // This function is no longer used since all operations are sequential
// }

// Sleep utility
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Add jitter to delays to prevent thundering herd effect
function addJitter(delay, jitterPercent = config.reddit.retries.jitterPercent) {
    const jitter = delay * jitterPercent * (Math.random() * 2 - 1); // Random between -jitter and +jitter
    return Math.max(0, Math.round(delay + jitter));
}

// Get appropriate request delays based on OAuth2 authentication status
function getRequestDelays() {
    // MODIFIED: Check if OAuth is blocked, not just enabled/configured
    const isOAuth2Active = config.reddit.enableOAuth2 && redditAuth.isConfigured() && !redditAuth.oauthBlocked;
    return isOAuth2Active ? config.reddit.requestDelays.oauth2 : config.reddit.requestDelays.unauthenticated;
}

// Calculate exponential backoff delay
function calculateBackoffDelay(attempt, baseDelay = config.reddit.retries.baseDelay) {
    const exponentialDelay = baseDelay * Math.pow(config.reddit.retries.exponentialBase, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, config.reddit.retries.maxDelay);
    return addJitter(cappedDelay);
}

// Check if error is retryable
function isRetryableError(error) {
    if (!error.response) {
        // Network errors, timeouts, connection refused, etc.
        return true;
    }

    const status = error.response.status;
    // Retry on server errors and rate limiting
    return status >= 500 || status === 429 || status === 408;
}

// Generic retry wrapper with exponential backoff
// Promise timeout wrapper removed - letting operations take as long as needed

async function withRetry(operation, context = 'operation', maxAttempts = Math.min(config.reddit.retries.maxAttempts, 2)) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await operation();
            if (attempt > 1) {
                log('info', `${context} succeeded on attempt ${attempt}`);
            }
            return result;
        } catch (error) {
            lastError = error;

            // Don't retry on final attempt
            if (attempt === maxAttempts) {
                break;
            }

            // Only retry on retryable errors
            if (!isRetryableError(error)) {
                log('warn', `${context} failed with non-retryable error: ${error.message}`);
                throw error;
            }

            stats.retriesPerformed++;

            // MODIFIED: Intelligent backoff for rate limiting with escalating delays
            let delay;
            if (error.response?.status === 429) {
                stats.rateLimitHits++;
                const now = Date.now();
                const retryAfterHeader = error.response.headers?.['retry-after'];
                let baseWaitTime = getRequestDelays().after429Error; // Default wait time

                if (retryAfterHeader) {
                    const waitTimeSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(waitTimeSeconds)) {
                        baseWaitTime = (waitTimeSeconds * 1000) + 500; // Use header value + 500ms buffer
                        log('warn', `Rate limit hit for ${context}. Reddit requested a wait of ${waitTimeSeconds}s.`);
                    }
                }

                // Check if this is a consecutive 429 error (within last 2 minutes)
                if (now - lastRateLimitTime < 120000) {
                    consecutive429Errors++;
                } else {
                    consecutive429Errors = 1; // Reset if it's been a while
                }
                lastRateLimitTime = now;

                // Escalating backoff: start at 60s, double each time, max 3 minutes (reduced from 10)
                const escalatingWaitTime = Math.min(60000 * Math.pow(2, consecutive429Errors - 1), 180000);
                const finalWaitTime = Math.max(baseWaitTime, escalatingWaitTime);

                log('warn', `Rate limit hit ${consecutive429Errors} time(s) in sequence. Using ${Math.round(finalWaitTime / 1000)}s wait (base: ${Math.round(baseWaitTime / 1000)}s, escalated: ${Math.round(escalatingWaitTime / 1000)}s)`);

                // Set the GLOBAL throttle timestamp
                throttleUntil = now + finalWaitTime;
                delay = calculateBackoffDelay(attempt); // Use shorter delay for the retry itself
                log('warn', `Pausing future requests until throttle lifts. Retrying this request in ${delay}ms.`);

            } else {
                delay = calculateBackoffDelay(attempt);
                log('warn', `${context} failed (attempt ${attempt}/${maxAttempts}): ${error.message}, retrying in ${delay}ms`);
            }

            await sleep(delay);
        }
    }

    // If we get here, all attempts failed
    log('error', `All ${maxAttempts} attempts failed for ${context}. Final error: ${lastError.message}`);
    throw lastError;
}

// Sequential request wrapper for Reddit API calls (NO CONCURRENCY)
async function makeRedditApiRequest(url, options = {}) {
    try {
        log('debug', `Making API request to: ${truncate(url, 60)}`);

        // Check and wait for the global throttle before every request
        const now = Date.now();
        if (now < throttleUntil) {
            const waitTime = throttleUntil - now;
            const waitTimeSeconds = Math.round(waitTime / 1000);
            log('warn', `Global rate limit throttle active. Pausing all API requests for ${waitTimeSeconds}s.`);

            // Update progress bar to show rate limiting
            await updateProgress('all', 'rate_limited', `⏳ Rate limited, waiting ${waitTimeSeconds}s...`);

            await sleep(waitTime);
        }

        await sleep(getRequestDelays().betweenApiCalls);

        // Check if OAuth is blocked
        const useOAuth = config.reddit.enableOAuth2 && redditAuth.isConfigured() && !redditAuth.oauthBlocked;

        const result = await withRetry(
            () => {
                if (useOAuth) {
                    log('debug', `Using OAuth for: ${truncate(url, 60)}`);
                    return makeAuthenticatedRedditRequest(url, options);
                } else {
                    log('debug', `Using unauthenticated request for: ${truncate(url, 60)}`);
                    return axios.get(url, {
                        timeout: options.timeout || config.reddit.timeouts.redditApi,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                        ...options
                    });
                }
            },
            `Reddit API request to ${truncate(url, 50)}`
        );

        // Reset consecutive 429 errors on successful request
        if (consecutive429Errors > 0) {
            log('info', `Rate limiting resolved after ${consecutive429Errors} consecutive 429 errors`);
            consecutive429Errors = 0;
        }

        log('debug', `API request completed for: ${truncate(url, 60)}`);
        return result;
    } catch (error) {
        log('error', `API request failed for ${truncate(url, 60)}: ${error.message}`);
        throw error;
    }
}

// Rate-limited image download wrapper
// Sequential image download wrapper (NO CONCURRENCY)
async function makeImageRequest(url, options = {}) {
    try {
        log('debug', `Downloading image from: ${truncate(url, 60)}`);
        await sleep(getRequestDelays().betweenImages);

        const result = await withRetry(
            () => axios.get(url, {
                responseType: 'arraybuffer',
                timeout: config.reddit.timeouts.imageDownload,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.reddit.com/'
                },
                ...options
            }),
            `Image download from ${truncate(url, 50)}`
        );

        log('debug', `Image download completed from: ${truncate(url, 60)}`);
        return result;
    } catch (error) {
        log('error', `Image download failed from ${truncate(url, 60)}: ${error.message}`);
        throw error;
    }
}

// --- END OF RATE LIMITING & RETRY UTILITIES ---


// --- UTILITIES & HELPERS ---

// **FIXED**: Moved escapeXml to global scope to be accessible everywhere
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.toString().replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' }[c]));
}

// Escape regex metacharacters for safe use in RegExp constructor
function escapeRegex(string) {
    if (!string) return '';
    return string.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Robust HTML sanitizer specifically designed for EPUB 2.0 compatibility.
 * Handles malformed Reddit HTML and ensures strict XHTML compliance.
 */
function sanitizeHtmlForEpub(html) {
    if (!html || typeof html !== 'string') return '';

    // SIMPLIFIED VERSION to prevent catastrophic backtracking
    let sanitized = decode(html);

    // Step 1: Remove script, style, and other non-content elements entirely
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script)<[^<]*)*<\/script>/gi, '');
    sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style)<[^<]*)*<\/style>/gi, '');
    sanitized = sanitized.replace(/<noscript\b[^<]*(?:(?!<\/noscript)<[^<]*)*<\/noscript>/gi, '');

    // Step 2: Remove problematic elements - SIMPLIFIED approach
    const badTags = [
        'script', 'style', 'noscript', 'iframe', 'form', 'input', 'button', 'select', 'textarea',
        'video', 'audio', 'figure', 'nav', 'aside', 'header', 'footer'
    ];

    // Simple removal of bad tags
    badTags.forEach(tag => {
        const simple = new RegExp(`<${tag}[^>]*>`, 'gi');
        const paired = new RegExp(`<${tag}[^>]*>[^<]*<\/${tag}>`, 'gi');
        sanitized = sanitized.replace(paired, '');
        sanitized = sanitized.replace(simple, '');
    });

    // Step 3: Basic image tag cleaning - SIMPLIFIED
    sanitized = sanitized.replace(/<img([^>]*)>/gi, (match, attrs) => {
        // Keep only src and alt attributes
        const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
        const altMatch = attrs.match(/alt\s*=\s*["']([^"']*)["']/i);

        const src = srcMatch ? srcMatch[1] : '';
        const alt = altMatch ? altMatch[1] : '';

        return `<img src="${src}" alt="${escapeXml(alt)}" />`;
    });

    // Step 4: Basic cleanup
    sanitized = sanitized.replace(/<br[^>]*>/gi, '<br />');
    sanitized = sanitized.replace(/<hr[^>]*>/gi, '<hr />');

    // Remove empty paragraphs
    sanitized = sanitized.replace(/<p[^>]*>\s*<\/p>/gi, '');

    // Basic attribute cleanup - remove style, class, id, etc.
    sanitized = sanitized.replace(/\s(style|class|id|onclick|onload|data-[^=]*)\s*=\s*["'][^"']*["']/gi, '');

    return sanitized.trim();
}

/**
        // Also remove any unclosed versions
        const selfClosingRegex = new RegExp(`<${tag}[^>]*\\/>`, 'gi');
        sanitized = sanitized.replace(selfClosingRegex, '');
        // Remove opening tags without closing
        const openingRegex = new RegExp(`<${tag}[^>]*>`, 'gi');
        sanitized = sanitized.replace(openingRegex, '');
    });

    // Step 3: Fix malformed img tags FIRST and remove ALL invalid attributes
    sanitized = sanitized.replace(/<img([^>]*?)>/gi, (match, attrs) => {
        let cleanAttrs = attrs.trim();

        // Remove ALL invalid attributes for EPUB 2.0 - only keep src, alt, width, height, title
        cleanAttrs = cleanAttrs.replace(/\b(?!(?:src|alt|width|height|title)\b)[a-zA-Z-]+\s*=\s*"[^"]*"/gi, '');
        cleanAttrs = cleanAttrs.replace(/\b(?!(?:src|alt|width|height|title)\b)[a-zA-Z-]+\s*=\s*'[^']*'/gi, '');
        cleanAttrs = cleanAttrs.replace(/\b(?!(?:src|alt|width|height|title)\b)[a-zA-Z-]+\s*=\s*[^\s>]+/gi, '');

        // Ensure alt attribute exists
        if (!/\balt\s*=/i.test(cleanAttrs)) {
            cleanAttrs += ' alt=""';
        }

        // Fix malformed alt attribute
        cleanAttrs = cleanAttrs.replace(/\balt\s*=\s*([^"'\s>][^\s>]*|"[^"]*"|'[^']*')/gi, (altMatch, value) => {
            if (!value || value === '=' || value === 'alt') {
                return 'alt=""';
            }
            let cleanValue = value.replace(/^["']|["']$/g, '');
            cleanValue = escapeXml(cleanValue);
            return `alt="${cleanValue}"`;
        });

        // Ensure self-closing for XHTML
        cleanAttrs = cleanAttrs.trim();
        if (!cleanAttrs.endsWith('/')) {
            cleanAttrs += ' /';
        }

        return `<img ${cleanAttrs}>`;
    });

    // Step 4: Fix self-closing tags to be XHTML compliant
    sanitized = sanitized.replace(/<br(?!\s*\/?>)[^>]*>/gi, '<br />');
    sanitized = sanitized.replace(/<hr(?!\s*\/?>)[^>]*>/gi, '<hr />');
    sanitized = sanitized.replace(/<meta([^>]*?)(?<!\/)>/gi, '<meta$1 />');

    // Step 5: CRITICAL - Fix invalid nesting and enforce proper EPUB 2.0 structure

    // Remove block elements that are improperly nested inside inline elements
    // This is the KEY fix for the validation errors

    // First pass: Extract content from improperly nested block elements inside inline contexts
    const blockElements = ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'pre', 'hr'];
    const inlineElements = ['a', 'em', 'strong', 'i', 'b', 'span', 'code', 'kbd', 'samp', 'var', 'abbr', 'acronym'];

    // Fix the most common violation: block elements inside inline elements
    // This is much more aggressive - we'll completely restructure invalid nesting
    inlineElements.forEach(inlineTag => {
        blockElements.forEach(blockTag => {
            // Pattern 1: <inline>...<block>content</block>...</inline> -> close inline, add block, reopen inline
            const nestedPattern = new RegExp(`(<${inlineTag}[^>]*>)([^<]*?)(<${blockTag}[^>]*>[\\s\\S]*?<\\/${blockTag}>)([^<]*?)(<\\/${inlineTag}>)`, 'gi');
            sanitized = sanitized.replace(nestedPattern, (match, openInline, beforeBlock, blockContent, afterBlock, closeInline) => {
                let result = '';
                if (beforeBlock.trim()) {
                    result += openInline + beforeBlock + closeInline;
                }
                result += blockContent;
                if (afterBlock.trim()) {
                    result += openInline + afterBlock + closeInline;
                }
                return result;
            });

            // Pattern 2: <inline><block> (unclosed inline with block) -> close inline first
            const openPattern = new RegExp(`(<${inlineTag}[^>]*>)(<${blockTag}[^>]*>)`, 'gi');
            sanitized = sanitized.replace(openPattern, `</${inlineTag}>$2`);
        });
    });

    // Step 6: Clean up remaining structural issues

    // Remove nested paragraphs
    sanitized = sanitized.replace(/<p[^>]*>\s*(<p[^>]*>[\\s\\S]*?<\/p>)\s*<\/p>/gi, '$1');

    // Fix unclosed paragraph tags by ensuring proper closing before block elements
    sanitized = sanitized.replace(/<p([^>]*)>([^<]*(?:<(?!\/p\b)[^>]*>[^<]*)*?)(?=<(?:div|h[1-6]|ul|ol|blockquote|p)\b)/gi, '<p$1>$2</p>');

    // More aggressive paragraph fixing - close any unclosed paragraphs at end of content
    sanitized = sanitized.replace(/<p([^>]*)>([^<]*(?:<(?!(?:\/p|p)\b)[^>]*>[^<]*)*)$/gi, '<p$1>$2</p>');

    // Step 7: Ensure all tags are properly closed using a more robust approach
    const tagStack = [];
    const tagsToBalance = ['p', 'div', 'em', 'strong', 'i', 'b', 'u', 'a'];

    // This is a simplified tag balancer - for production you'd want a full HTML parser
    tagsToBalance.forEach(tag => {
        const openTags = (sanitized.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')) || []).length;
        const closeTags = (sanitized.match(new RegExp(`<\\/${tag}>`, 'gi')) || []).length;

        if (openTags > closeTags) {
            // Add missing closing tags at the end
            for (let i = 0; i < (openTags - closeTags); i++) {
                sanitized += `</${tag}>`;
            }
        } else if (closeTags > openTags) {
            // Remove excess closing tags
            let removed = 0;
            sanitized = sanitized.replace(new RegExp(`<\\/${tag}>`, 'gi'), (match) => {
                if (removed < (closeTags - openTags)) {
                    removed++;
                    return '';
                }
                return match;
            });
        }
    });

    // Step 8: Remove any malformed or truncated HTML at the end of content
    sanitized = sanitized.replace(/<[^>]*$/g, ''); // Remove incomplete tags at the end
    sanitized = sanitized.replace(/<(\w+)[^>]*(?!>)[^<]*$/g, ''); // Remove incomplete opening tags
    
    // Step 8a: Fix orphaned list items by wrapping them in ul tags
    sanitized = sanitized.replace(/(<li\b[^>]*>(?:(?!<\/?(?:ul|ol|li)\b)[^<]*|<(?!\/li\b)[^<]*<)*?<\/li>)(?=\s*(?:<li\b|$|<(?!\/li\b)))/gi, '<ul>$1</ul>');
    
    // Step 8b: Remove invalid attributes from all remaining tags
    sanitized = sanitized.replace(/\s(?:srcset|data-[^=\s]*|on[^=\s]*|class|target|rel|style|id|loading|decoding|crossorigin|referrerpolicy)="[^"]*"/gi, '');
    sanitized = sanitized.replace(/\s(?:srcset|data-[^=\s]*|on[^=\s]*|class|target|rel|style|id|loading|decoding|crossorigin|referrerpolicy)='[^']*'/gi, '');

    // Step 9: Fix malformed href attributes first
    sanitized = sanitized.replace(/\bhref\s*([^=])/gi, 'href="$1"'); // Fix missing equals sign
    sanitized = sanitized.replace(/\bhref\s*=\s*([^"'\s>][^\s>]*)/gi, 'href="$1"'); // Fix unquoted values
    sanitized = sanitized.replace(/\bhref\s*=\s*$/gi, 'href=""'); // Fix empty values

    // Step 10: Fix relative Reddit URLs to absolute URLs
    sanitized = sanitized.replace(/href="\/r\//gi, 'href="https://www.reddit.com/r/');
    sanitized = sanitized.replace(/href="\/u\//gi, 'href="https://www.reddit.com/u/');
    sanitized = sanitized.replace(/href="\/user\//gi, 'href="https://www.reddit.com/user/');

    // Step 11: Remove any remaining remote image references and fix broken links
    sanitized = sanitized.replace(/<img[^>]+src="https?:\/\/[^"]*"[^>]*>/gi, '');
    sanitized = sanitized.replace(/src="_next\/image[^"]*"/gi, 'src=""'); // Fix the _next/image reference issue

    // Step 12: Escape lone ampersands that aren't part of HTML entities
    sanitized = sanitized.replace(/&(?![a-zA-Z]{2,8};|#[0-9]{2,6};|#x[0-9a-fA-F]{2,6};)/g, '&amp;');

    // Step 13: Remove empty elements and whitespace-only content
    sanitized = sanitized.replace(/<p[^>]*>\s*(?:<br\s*\/?>)?\s*<\/p>/gi, '');
    sanitized = sanitized.replace(/<div[^>]*>\s*<\/div>/gi, '');
    sanitized = sanitized.replace(/<span[^>]*>\s*<\/span>/gi, '');
    sanitized = sanitized.replace(/<em[^>]*>\s*<\/em>/gi, '');
    sanitized = sanitized.replace(/<strong[^>]*>\s*<\/strong>/gi, '');

    // Step 14: Final cleanup - remove malformed tags
    sanitized = sanitized.replace(/<(?![a-zA-Z\/!?])/g, '&lt;');

    return sanitized.trim();
}

/**
 * Ensures all content is properly cleaned and EPUB-safe before use
 */
async function cleanContentForEpub(content, postId) {
    log('debug', `Starting cleanContentForEpub for post ${postId}`);

    if (!content || typeof content !== 'string') {
        log('debug', `No content to clean for post ${postId}`);
        return '';
    }

    log('debug', `Content length: ${content.length} chars for post ${postId}`);

    // First pass: sanitize the HTML structure
    log('debug', `Starting sanitizeHtmlForEpub for post ${postId}`);
    let cleaned = sanitizeHtmlForEpub(content);
    log('debug', `Completed sanitizeHtmlForEpub for post ${postId}`);

    // Second pass: process any remaining images if downloads are enabled
    if (config.reddit.downloadImages) {
        log('debug', `Starting image processing for post ${postId}`);
        cleaned = await processImagesInContent(cleaned, postId);
        log('debug', `Completed image processing for post ${postId}`);
    }

    // Third pass: remove any remaining remote image references that might have been missed
    log('debug', `Removing remaining remote images for post ${postId}`);
    cleaned = cleaned.replace(/<img[^>]+src="https?:\/\/[^"]*"[^>]*>/gi, '<p><em>[External image removed for EPUB compatibility]</em></p>');

    // Final pass: ensure no empty or malformed elements remain
    log('debug', `Final cleanup for post ${postId}`);
    cleaned = cleaned.replace(/<p[^>]*>\s*<\/p>/gi, '');
    cleaned = cleaned.replace(/<div[^>]*>\s*<\/div>/gi, '');

    // Fix unclosed div tags by ensuring proper nesting - more robust approach
    let tempCleaned = cleaned;
    const divOpenRegex = /<div[^>]*>/gi;
    const divCloseRegex = /<\/div>/gi;
    const divOpenMatches = (tempCleaned.match(divOpenRegex) || []).length;
    const divCloseMatches = (tempCleaned.match(divCloseRegex) || []).length;
    if (divOpenMatches > divCloseMatches) {
        // Add missing closing div tags at the end
        const missingCloseTags = '</div>'.repeat(divOpenMatches - divCloseMatches);
        cleaned += missingCloseTags;
    }

    // Also fix any malformed or truncated tags at the end
    cleaned = cleaned.replace(/<[^>]*$/g, ''); // Remove incomplete tags at the end
    cleaned = cleaned.replace(/<(\w+)[^>]*(?!>)$/g, ''); // Remove incomplete opening tags

    return cleaned.trim();
}

// Generate human-readable sorting description
function generateSortingDescription(sort, timeframe) {
    const sortType = sort || 'hot';

    switch (sortType.toLowerCase()) {
        case 'hot': return 'hot posts';
        case 'new': return 'newest posts';
        case 'best': return 'best posts';
        case 'rising': return 'rising posts';
        case 'top':
            return `top of the ${timeframe || 'week'}`;
        case 'controversial':
            return `controversial this ${timeframe || 'week'}`;
        default: return `${sortType} posts`;
    }
}

const truncate = (str, len) => {
    if (!str || typeof str !== 'string') return '';
    if (str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
};
// Command line arguments
const args = process.argv.slice(2);
const VERBOSE_LOGGING = args.includes('--verbose') || args.includes('-v');
const SIMPLE_LOGGING = !VERBOSE_LOGGING;

// --- LOGGING SYSTEM (ADDED) ---
const logFilePath = process.env.LOG_FILE;
let logStream = null;

if (logFilePath) {
    try {
        // Open the file defined by the batch script for writing
        logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });

        // CRITICAL FIX: Handle stream errors (like EBUSY) to prevent crashes
        logStream.on('error', (err) => {
            console.error(`⚠️ Logging Stream Error: ${err.message}`);
            // Disable file logging if file is locked, fall back to console
            logStream = null;
        });
    } catch (e) {
        console.error(`Warning: Could not open log file: ${e.message}`);
        logStream = null;
    }
}

// Helper to write to file (Strips colors so text file is clean)
const writeToFile = (level, message) => {
    if (logStream) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const cleanMessage = message ? message.toString().replace(/\u001b\[\d+m/g, '') : '';
        logStream.write(`[${timestamp}] [${level.toUpperCase().padEnd(7)}] ${cleanMessage}\n`);
    }
};

// Progress tracking
let progressBar = null;
let currentSubredditIndex = 0;
let totalSubreddits = 0;
const completedSubreddits = [];
let progressUpdateLock = false;

// Stats object
const stats = {
    postsProcessed: 0,
    imagePostsSkipped: 0,
    galleryPostsSkipped: 0,
    videoPostsSkipped: 0,
    autoModPostsSkipped: 0,
    unfetchableArticlesSkipped: 0,
    largeImagesSkipped: 0,
    internalLinksSkipped: 0,
    fallbackImagePostsIncluded: 0,
    rateLimitHits: 0,
    retriesPerformed: 0,
    errors: [],
    subredditDetails: new Map(),
    imagesFailedToDownload: 0,
    mercuryFailures: 0,
    imagesOptimized: 0,
    totalSizeSaved: 0
};

// Logging functions
const log = (level, message) => {
    // 1. FILE: Always write verbose logs here
    writeToFile(level, message);

    // 2. SCREEN: Only write here if user specifically asked for --verbose
    if (VERBOSE_LOGGING) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        const cleanMessage = message.toString().replace(/(\r\n|\n|\r)/gm, " | ");
        console.log(`[${timestamp}] [${level.toUpperCase().padEnd(7)}] ${cleanMessage}`);
    }
};

const simpleLog = (message) => {
    // 1. FILE: Write this as INFO so the log is complete
    writeToFile('INFO', message);

    // 2. SCREEN: Always show simple logs (System Status, Progress Bar)
    if (SIMPLE_LOGGING) {
        console.log(message);
    }
};

const updateProgress = async (subredditName, status = 'processing', message = '') => {
    if (SIMPLE_LOGGING && progressBar && !progressBar.isCompleted && !progressUpdateLock) {
        progressUpdateLock = true;

        try {
            const statusMessages = {
                'processing': '📡 Fetching posts...',
                'filtering': '🔍 Filtering content...',
                'downloading': '📥 Downloading images...',
                'completed': '✅ Done',
                'rate_limited': '⏳ Rate limited, waiting...',
                'parsing': '📖 Processing articles...'
            };

            // For non-completion updates, don't increment currentSubredditIndex
            const displayIndex = status === 'completed' ? currentSubredditIndex : Math.min(currentSubredditIndex + 1, totalSubreddits);

            progressBar.update(displayIndex, {
                current: displayIndex,
                subredditCount: totalSubreddits,
                statusMessage: `r/${subredditName} ${message || statusMessages[status] || '⚙️  Working...'}`
            });

            // Small delay to prevent rapid updates
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
            // Silently handle progress bar errors to prevent crashes
        } finally {
            progressUpdateLock = false;
        }
    }
};

const completeSubreddit = (subredditName, postsFound, targetPosts, details = {}) => {
    currentSubredditIndex++;
    completedSubreddits.push({ name: subredditName, posts: postsFound, target: targetPosts, details });

    // Update progress bar when subreddit completes
    if (SIMPLE_LOGGING && progressBar && !progressBar.isCompleted) {
        const statusMessage = postsFound >= targetPosts ? '✅ Complete' : `⚠️  Only ${postsFound}/${targetPosts} posts`;
        progressBar.update(currentSubredditIndex, {
            current: currentSubredditIndex,
            subredditCount: totalSubreddits,
            statusMessage: `r/${subredditName} ${statusMessage}`
        });
    }

    // Store detailed info for final summary
    stats.subredditDetails.set(subredditName, {
        found: postsFound,
        target: targetPosts,
        metTarget: postsFound >= targetPosts,
        ...details
    });

    if (SIMPLE_LOGGING) {
        if (progressBar && !progressBar.isCompleted) {
            try {
                progressBar.update(currentSubredditIndex, {
                    current: currentSubredditIndex,
                    subredditCount: totalSubreddits,
                    statusMessage: `r/${subredditName} ✅ Done (${postsFound} posts)`
                });
            } catch (e) {
                // Silently handle progress bar errors
            }
        }
    } else {
        log('info', `--- Found ${postsFound} valid posts in r/${subredditName}. ---`);
    }
};

function convertToOauthUrl(url) {
    if (!url) return url;
    return url.replace(/^(https:\/\/)?(www\.)?reddit\.com/, 'https://oauth.reddit.com');
}

const imagesDir = path.join(__dirname, 'epub_images');
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
}

function isImageUrl(url) {
    if (!url) return false;

    // Always consider i.redd.it URLs as images (Reddit's image hosting)
    if (url.includes('i.redd.it')) {
        return true;
    }

    // Check for file extensions for other domains
    return /\.(jpg|jpeg|png|gif|webp|heif)$/i.test(url.split('?')[0]);
}

function isRedditGalleryUrl(url) {
    if (!url) return false;
    return url.includes('reddit.com/gallery/');
}

// Detect if a post is primarily an image post - VERY CONSERVATIVE approach
function isImagePost(postContent, externalUrl, title = '', rawData = null) {
    if (!postContent && !externalUrl && !title) return false;

    // ONLY trust Reddit's native post_hint field - most reliable indicator
    if (rawData && rawData.post_hint === 'image') {
        return true;
    }

    // ONLY consider Reddit hosted images (i.redd.it domain)
    if (rawData && rawData.domain === 'i.redd.it') {
        return true;
    }

    // ONLY consider direct image file URLs (not hosting sites)
    if (externalUrl && isImageUrl(externalUrl)) {
        return true;
    }

    // ONLY consider very specific imgur patterns that are definitely images
    if (externalUrl && /^https?:\/\/(i\.)?imgur\.com\/[a-zA-Z0-9]+\.(jpg|jpeg|png|gif|webp)$/i.test(externalUrl)) {
        return true;
    }

    // For everything else, be very conservative - only flag if there's absolutely 
    // no text content and it's clearly just an image
    if (postContent && title) {
        const textContent = postContent.replace(/<[^>]*>/g, '').replace(/\[link\]|\[comments\]/gi, '').trim();
        const titleContent = title.trim();

        // Only flag as image post if BOTH conditions are met:
        // 1. Extremely minimal content (less than 20 characters)
        // 2. Title clearly indicates it's just sharing an image
        if (textContent.length < 20 &&
            (/^(my |check out this |look at this )?photo|^pic |^image |^\[pic\]|^\[image\]/i.test(titleContent))) {
            return true;
        }
    }

    return false;
}

// Detect if a post is a gallery post - CONSERVATIVE approach
function isGalleryPost(postContent, externalUrl, title = '', rawData = null) {
    if (!postContent && !externalUrl && !title) return false;

    // ONLY trust Reddit's native fields for galleries - most reliable
    if (rawData) {
        if (rawData.is_gallery === true) return true;
        if (rawData.post_hint === 'gallery') return true;
        if (rawData.media_metadata && Object.keys(rawData.media_metadata).length > 0) return true;
    }

    // ONLY consider explicit Reddit gallery URLs
    if (externalUrl && isRedditGalleryUrl(externalUrl)) {
        return true;
    }

    // ONLY consider explicit imgur gallery URLs
    if (externalUrl && /^https?:\/\/imgur\.com\/(a|gallery)\/[a-zA-Z0-9]+$/i.test(externalUrl)) {
        return true;
    }

    // Don't rely on title patterns - too many false positives

    return false;
}

function isUnsupportedImageFormat(url) {
    return /\.svg$/i.test(url);
}

function isInternalRedditLink(url) {
    if (!url) return false;
    if (isRedditGalleryUrl(url)) return false;
    const internalPatterns = ['/comments/', '/live/', 'v.redd.it'];
    return internalPatterns.some(pattern => url.includes(pattern));
}

function isUnsupportedVideo(content, externalUrl) {
    // Check content for video indicators
    if (content && (
        content.includes('v.redd.it') ||
        content.includes('reddit.com/video/') ||
        content.includes('[link] [comments]') && content.includes('v.redd.it')
    )) {
        return true;
    }

    // Check external URL for video domains
    if (externalUrl) {
        const videoDomains = [
            'youtube.com', 'youtu.be', 'vimeo.com', 'streamable.com',
            'v.redd.it', 'reddit.com/video/', 'twitch.tv', 'tiktok.com',
            'instagram.com/p/', 'instagram.com/reel/', 'facebook.com/watch'
        ];
        return videoDomains.some(domain => externalUrl.includes(domain));
    }

    return false;
}

// --- CORE FUNCTIONS ---

async function optimizeImage(imageBuffer, originalUrl) {
    if (!config.reddit.enableImageOptimization) {
        return imageBuffer;
    }

    try {
        const originalSize = imageBuffer.byteLength;
        log('image', `Optimizing image (${(originalSize / 1024 / 1024).toFixed(1)}MB): ${truncate(originalUrl, 60)}`);

        const image = sharp(imageBuffer);
        const metadata = await image.metadata();

        log('debug', `Original: ${metadata.width}x${metadata.height}, ${metadata.format}, ${(originalSize / 1024 / 1024).toFixed(1)}MB`);

        const needsDownsize = metadata.width > config.reddit.maxImageWidth || metadata.height > config.reddit.maxImageHeight;
        const needsUpsize = metadata.width < config.reddit.minImageWidth || metadata.height < config.reddit.minImageHeight;
        const needsResize = needsDownsize || needsUpsize;

        let pipeline = image;

        if (needsResize) {
            if (needsDownsize) {
                // Downsize large images
                pipeline = pipeline.resize(config.reddit.maxImageWidth, config.reddit.maxImageHeight, {
                    fit: 'inside',
                    withoutEnlargement: true
                });
            } else if (needsUpsize) {
                // Upscale small images  
                pipeline = pipeline.resize(config.reddit.minImageWidth, config.reddit.minImageHeight, {
                    fit: 'outside',
                    withoutReduction: true
                });
            }
        }

        const isLosslessFormat = ['png', 'webp', 'tiff'].includes(metadata.format);
        const shouldConvertToJpeg = isLosslessFormat && originalSize > config.reddit.optimizationThreshold;

        let optimizedBuffer;
        if (shouldConvertToJpeg || metadata.format === 'jpeg') {
            optimizedBuffer = await pipeline.jpeg({ quality: config.reddit.jpegQuality, progressive: true }).toBuffer();
        } else {
            if (metadata.format === 'png') {
                optimizedBuffer = await pipeline.png({ compressionLevel: 9, progressive: true }).toBuffer();
            } else if (metadata.format === 'webp') {
                optimizedBuffer = await pipeline.webp({ quality: config.reddit.jpegQuality }).toBuffer();
            } else {
                optimizedBuffer = await pipeline.jpeg({ quality: config.reddit.jpegQuality, progressive: true }).toBuffer();
            }
        }

        const optimizedSize = optimizedBuffer.byteLength;
        const reductionPercent = Math.round((1 - optimizedSize / originalSize) * 100);
        log('image', `Optimized: ${(optimizedSize / 1024 / 1024).toFixed(1)}MB (${reductionPercent}% smaller)`);
        stats.imagesOptimized = (stats.imagesOptimized || 0) + 1;
        stats.totalSizeSaved = (stats.totalSizeSaved || 0) + (originalSize - optimizedSize);
        return optimizedBuffer;
    } catch (error) {
        log('error', `Failed to optimize image: ${error.message}, using original`);
        return imageBuffer;
    }
}

async function downloadImage(imageUrl, imageName) {
    try {
        log('image', `Downloading: ${truncate(imageUrl, 60)}`);
        const response = await makeImageRequest(imageUrl);
        let imageData = response.data;

        // **FIX**: Force conversion of unsupported formats
        const unsupportedFormats = ['heif', 'avif', 'webp'];
        const metadata = await sharp(imageData).metadata();
        if (metadata.format && unsupportedFormats.includes(metadata.format)) {
            log('image', `Unsupported format '${metadata.format}' detected. Converting to JPEG.`);
            imageData = await sharp(imageData).jpeg({ quality: config.reddit.jpegQuality }).toBuffer();
        }

        const originalSize = imageData.byteLength;
        const isLarge = originalSize > config.reddit.optimizationThreshold;

        if (isLarge) {
            if (config.reddit.enableImageOptimization) {
                log('image', `Large image detected (${(originalSize / 1024 / 1024).toFixed(1)}MB), optimizing...`);
                imageData = await optimizeImage(imageData, imageUrl); // Pass buffer directly

                if (imageData.byteLength > config.reddit.optimizationThreshold) {
                    log('warn', `Image still too large after optimization (${(imageData.byteLength / 1024 / 1024).toFixed(1)}MB), skipping.`);
                    stats.largeImagesSkipped++;
                    return null;
                }
            } else {
                log('warn', `Skipping large image (${(originalSize / 1024 / 1024).toFixed(1)}MB).`);
                stats.largeImagesSkipped++;
                return null;
            }
        }

        const finalMetadata = await sharp(imageData).metadata();
        const extension = `.${finalMetadata.format === 'jpeg' ? 'jpg' : finalMetadata.format}`;

        const fileName = `${imageName}${extension}`;
        const filePath = path.join(imagesDir, fileName);
        fs.writeFileSync(filePath, imageData);
        log('image', `Saved: ${fileName} (${(imageData.byteLength / 1024 / 1024).toFixed(1)}MB)`);
        return fileName;
    } catch (error) {
        log('error', `Failed to download ${truncate(imageUrl, 60)}: ${error.message}`);
        stats.imagesFailedToDownload++;
        return null;
    }
}

async function fetchSubredditInfo(subredditName) {
    try {
        log('info', `Fetching info for r/${subredditName}`);

        // Try OAuth first, then fall back to JSON API
        let response = null;

        if (config.reddit.enableOAuth2 && redditAuth.isConfigured()) {
            try {
                const oauthUrl = `https://oauth.reddit.com/r/${subredditName}/about`;
                response = await makeRedditApiRequest(oauthUrl);
            } catch (oauthError) {
                log('warn', `OAuth subreddit info failed, trying JSON API...`);
            }
        }

        if (!response) {
            // Try JSON API instead
            const jsonUrl = `https://www.reddit.com/r/${subredditName}/about.json`;
            response = await makeRedditApiRequest(jsonUrl);
        }

        const { data } = response.data;
        const iconUrl = data.community_icon || data.icon_img;
        const description = data.public_description;
        const cleanedIconUrl = iconUrl ? iconUrl.split('?')[0] : null;

        return { iconUrl: cleanedIconUrl, description };
    } catch (error) {
        log('error', `Failed to fetch info for r/${subredditName}: ${error.message}`);
        return { iconUrl: null, description: null };
    }
}

async function processImagesInContent(content, postIndex) {
    log('debug', `Processing images in content for post ${postIndex}`);

    if (!config.reddit.downloadImages) {
        // If image downloads are disabled, remove all remote image references
        log('debug', `Image downloads disabled, removing remote images`);
        return content.replace(/<img[^>]+src="https?:\/\/[^"]*"[^>]*>/gi, '<p><em>[Image downloads disabled]</em></p>');
    }

    const imageRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    const images = [];
    let match;
    let imageIndex = 0;

    log('debug', `Scanning content for images...`);
    while ((match = imageRegex.exec(content)) !== null) {
        const imageUrl = match[1];
        log('debug', `Found image URL: ${truncate(imageUrl, 80)}`);

        // Skip if already a local image
        if (imageUrl.startsWith('images/')) {
            log('debug', `Skipping local image: ${imageUrl}`);
            continue;
        }

        if (!isUnsupportedImageFormat(imageUrl) && isImageUrl(imageUrl)) {
            log('debug', `Adding image to download queue: ${truncate(imageUrl, 80)}`);
            images.push({ original: match[0], url: imageUrl, index: imageIndex++ });
        } else {
            log('debug', `Skipping unsupported/invalid image: ${truncate(imageUrl, 80)}`);
        }
    }

    log('debug', `Found ${images.length} images to process in content`);

    // Process images sequentially (NO CONCURRENCY)
    const results = [];
    for (let i = 0; i < images.length; i++) {
        const image = images[i];
        log('debug', `Processing content image ${i + 1}/${images.length}: ${truncate(image.url, 60)}`);
        const imageName = `post_${postIndex}_img_${image.index}`;
        try {
            const fileName = await downloadImage(image.url, imageName);
            results.push({ original: image.original, url: image.url, fileName });
            log('debug', `Content image ${i + 1} processed successfully: ${fileName || 'failed'}`);
        } catch (error) {
            log('error', `Failed to process content image ${i + 1}: ${error.message}`);
            results.push({ original: image.original, url: image.url, fileName: null });
        }
    }

    log('debug', `Replacing image URLs in content...`);
    for (const result of results) {
        if (result.fileName) {
            content = content.replace(result.original, `<img src="images/${result.fileName}" alt="Image from article" />`);
        } else {
            // Replace failed downloads with placeholder text instead of broken image tags
            content = content.replace(result.original, `<p><em>[Image unavailable: ${truncate(result.url, 60)}]</em></p>`);
        }
    }

    // Final safety check - remove any remaining remote image references
    content = content.replace(/<img[^>]+src="https?:\/\/[^"]*"[^>]*>/gi, '<p><em>[External image removed]</em></p>');

    log('debug', `Completed processing images in content for post ${postIndex}`);
    return content;
}

async function fetchRssFeed(rssUrl, isJsonMode = false) {
    try {
        const response = await makeRedditApiRequest(rssUrl);
        if (isJsonMode) {
            return convertJsonToRssFormat(response.data);
        } else {
            return await parseStringPromise(response.data);
        }
    } catch (error) {
        log('error', `Error fetching RSS feed from ${rssUrl}: ${error.message}`);
        return null;
    }
}

function convertJsonToRssFormat(jsonData) {
    if (!jsonData?.data?.children) return null;
    const posts = jsonData.data.children;
    const items = posts.map(post => {
        const data = post.data;
        return {
            title: [data.title || ''],
            link: [{ $: { href: `https://reddit.com${data.permalink}` } }],
            description: [data.selftext || ''],
            pubDate: [new Date(data.created_utc * 1000).toUTCString()],
            id: [`t3_${data.id}`],
            guid: [{ $: { isPermaLink: "false" }, _: data.id }],
            url: data.url,
            permalink: `https://reddit.com${data.permalink}`,
            selftext: data.selftext,
            selftext_html: data.selftext_html,
            'reddit:permalink': [`https://reddit.com${data.permalink}`],
            'reddit:score': [data.score?.toString() || '0'],
            'reddit:author': [data.author || 'unknown'],
            'reddit:subreddit': [data.subreddit || ''],
            'reddit:num_comments': [data.num_comments?.toString() || '0'],
            // Store raw Reddit API data for better image/gallery detection
            _rawRedditData: data
        };
    });
    return { rss: { channel: [{ item: items }] } };
}

function processComments(comments, resolvedConfig, depth = 0) {
    // Safety check for depth to prevent infinite recursion
    if (depth > resolvedConfig.maxCommentDepth || depth > 10) return [];

    // Safety check for valid comments array
    if (!comments || !Array.isArray(comments)) return [];

    let filteredComments = comments;
    if (resolvedConfig.skipAutoModerator) {
        filteredComments = comments.filter(comment => comment && comment.data && comment.data.author !== 'AutoModerator');
    }

    return filteredComments.map(comment => {
        // Safety check for valid comment structure
        if (!comment || !comment.data) return null;

        let replies = [];
        if (comment.data.replies && comment.data.replies.data && Array.isArray(comment.data.replies.data.children)) {
            replies = processComments(comment.data.replies.data.children, resolvedConfig, depth + 1);
        }

        return {
            author: comment.data.author,
            text: comment.data.body_html,
            replies: replies,
        };
    }).filter(comment => comment !== null); // Remove null entries
}

// Timeout wrapper to prevent indefinite hanging
async function withTimeout(promise, timeoutMs, context = 'operation') {
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error(`${context} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
}

async function fetchComments(postUrl, maxComments, resolvedConfig, attempt = 1) {
    try {
        await sleep(getRequestDelays().betweenComments);
        let url = `${postUrl}.json`;
        if (config.reddit.enableOAuth2 && redditAuth.isConfigured()) {
            url = convertToOauthUrl(url);
        }

        // Progressive timeout: increase timeout based on number of comments requested and attempt number
        const baseTimeout = config.reddit.timeouts.redditApi;
        const commentMultiplier = Math.max(1, maxComments / 10); // Scale with comment count
        const attemptMultiplier = attempt * 1.5; // Increase timeout on retries
        const dynamicTimeout = Math.min(baseTimeout * commentMultiplier * attemptMultiplier, 120000); // Cap at 2 minutes

        // Log the attempt for visibility
        if (attempt > 1) {
            log('info', `Comment fetch attempt ${attempt} for ${truncate(postUrl, 60)} (timeout: ${Math.round(dynamicTimeout / 1000)}s)`);
        }

        // Wrap the API request with an additional timeout to prevent indefinite hanging
        const response = await withTimeout(
            makeRedditApiRequest(url, { timeout: dynamicTimeout }),
            dynamicTimeout + 5000, // Add 5s buffer to the timeout
            `Comment fetch for ${truncate(postUrl, 60)}`
        );

        // Safety check for response structure
        if (!response || !response.data || !Array.isArray(response.data) || response.data.length < 2) {
            log('warn', `Invalid comment response structure for ${truncate(postUrl, 60)}`);
            return [];
        }

        const postData = response.data[1]?.data?.children;
        if (!postData || !Array.isArray(postData)) {
            log('warn', `No comment data found for ${truncate(postUrl, 60)}`);
            return [];
        }

        return processComments(postData.slice(0, maxComments), resolvedConfig);
    } catch (error) {
        // More aggressive retry logic with exponential backoff
        const maxRetries = Math.max(config.reddit.retries.maxAttempts * 2, 6); // At least 6 attempts for comments

        if ((error.code === 'ECONNABORTED' || error.message.includes('timeout') || error.message.includes('timed out')) && attempt < maxRetries) {
            // Aggressive exponential backoff for comment fetching (longer delays than general API calls)
            const baseDelay = config.reddit.retries.baseDelay;
            const exponentialDelay = baseDelay * Math.pow(config.reddit.retries.exponentialBase, attempt - 1);
            const jitter = exponentialDelay * config.reddit.retries.jitterPercent * Math.random();

            // For comment fetching, use much higher max delays to handle persistent issues
            const commentMaxDelay = Math.max(120000, config.reddit.retries.maxDelay); // At least 2 minutes
            const totalDelay = Math.min(exponentialDelay + jitter, commentMaxDelay);

            log('warn', `Comment fetch timeout (attempt ${attempt}/${maxRetries}) for ${truncate(postUrl, 60)}, retrying in ${Math.round(totalDelay / 1000)}s...`);

            // Add periodic logging during long waits to show progress
            if (totalDelay > 30000) { // If waiting more than 30 seconds
                const logInterval = 15000; // Log every 15 seconds
                let remainingDelay = totalDelay;

                while (remainingDelay > 0) {
                    const waitTime = Math.min(logInterval, remainingDelay);
                    await sleep(waitTime);
                    remainingDelay -= waitTime;

                    if (remainingDelay > 0) {
                        log('info', `Still waiting to retry comment fetch for ${truncate(postUrl, 60)} (${Math.round(remainingDelay / 1000)}s remaining)`);
                    }
                }
            } else {
                await sleep(totalDelay);
            }

            return fetchComments(postUrl, maxComments, resolvedConfig, attempt + 1);
        }

        log('error', `Error fetching comments for ${truncate(postUrl, 60)} after ${attempt} attempts: ${error.message}`);
        return [];
    }
}

function generateNestedCommentsHtml(comments, postConfig, depth = 0) {
    if (!comments || comments.length === 0) return '';
    const style = depth > 0 ? `margin-left: 10px; padding-left: 10px; border-left: 1px solid #000;` : '';
    return comments.map(comment => {
        if (!comment.author || !comment.text || comment.author === '[deleted]') return '';
        const sanitizedText = sanitizeHtmlForEpub(comment.text);
        if (postConfig.effectiveMinLength > 0 && sanitizedText.length < postConfig.effectiveMinLength) return '';
        const repliesHtml = generateNestedCommentsHtml(comment.replies, postConfig, depth + 1);
        return `<div style="${style} margin-top: 1em;">
            <p style="margin: 0; font-size: 0.9em;"><strong>${escapeXml(comment.author)}</strong></p>
            <div style="margin: 0;">${sanitizedText}</div>
            ${repliesHtml}
        </div>`;
    }).filter(html => html.length > 0).join('');
}

function generateThreadedCommentsHtml(comments, postConfig) {
    if (!comments || comments.length === 0) return '';
    return comments.map(comment => {
        if (postConfig.effectiveMinLength > 0) {
            let isThreadLongEnough = false;
            let threadWalker = comment;
            let depth = 0;
            while (threadWalker && depth < postConfig.maxCommentDepth) {
                const currentSanitizedText = threadWalker.text ? sanitizeHtmlForEpub(threadWalker.text) : '';
                if (currentSanitizedText.length >= postConfig.effectiveMinLength) {
                    isThreadLongEnough = true;
                    break;
                }
                threadWalker = (threadWalker.replies && threadWalker.replies.length > 0) ? threadWalker.replies[0] : null;
                depth++;
            }
            if (!isThreadLongEnough) return '';
        }
        let threadHtml = '';
        let currentComment = comment;
        let depth = 0;
        while (currentComment && depth < postConfig.maxCommentDepth) {
            if (currentComment.author && currentComment.text && currentComment.author !== '[deleted]') {
                const sanitizedText = sanitizeHtmlForEpub(currentComment.text);
                threadHtml += `
                    <div class="thread-comment" style="margin-top: 0.8em;">
                        <p style="margin: 0; font-size: 0.9em;"><strong>${escapeXml(currentComment.author)}</strong></p>
                        <div style="margin: 0;">${sanitizedText}</div>
                    </div>`;
            }
            currentComment = (currentComment.replies && currentComment.replies.length > 0) ? currentComment.replies[0] : null;
            depth++;
        }
        if (threadHtml) return `<div class="comment-thread">${threadHtml}</div>`;
        return '';
    }).filter(html => html.length > 0).join('');
}

function generateCommentsHtml(comments, postConfig) {
    const safeConfig = { ...config.reddit.defaults, ...postConfig };
    const tempPostConfig = { ...safeConfig };
    tempPostConfig.effectiveMinLength = tempPostConfig.minCommentLength || 0;
    if (tempPostConfig.disableMinLengthIfFewerComments && tempPostConfig.minCommentLength > 0 && comments && comments.length > 0) {
        let validCommentCount = 0;
        if (tempPostConfig.commentStyle === 'threaded') {
            comments.forEach(comment => {
                let threadWalker = comment;
                let depth = 0;
                while (threadWalker && depth < tempPostConfig.maxCommentDepth) {
                    const sanitizedText = threadWalker.text ? sanitizeHtmlForEpub(threadWalker.text) : '';
                    if (sanitizedText.length >= tempPostConfig.minCommentLength) {
                        validCommentCount++;
                        break;
                    }
                    threadWalker = (threadWalker.replies && threadWalker.replies.length > 0) ? threadWalker.replies[0] : null;
                    depth++;
                }
            });
        } else {
            validCommentCount = comments.filter(c => c.text && sanitizeHtmlForEpub(c.text).length >= tempPostConfig.minCommentLength).length;
        }
        if (validCommentCount < tempPostConfig.commentsPerPost) {
            log('info', `Disabling minCommentLength for post (found ${validCommentCount} valid comments, less than ${tempPostConfig.commentsPerPost})`);
            tempPostConfig.effectiveMinLength = 0;
        }
    }
    if (tempPostConfig.commentStyle === 'threaded') {
        return generateThreadedCommentsHtml(comments, tempPostConfig);
    }
    return generateNestedCommentsHtml(comments, tempPostConfig);
}

async function formatDescription(description, postIndex) {
    const imageRegex = /<a[^>]*>\s*<img[^>]*>\s*<\/a>/i;
    const imageMatch = description.match(imageRegex);
    if (imageMatch) {
        let imageHtml = imageMatch[0].replace(/style="[^"]*"/, '');
        if (!imageHtml.includes('images/') && imageHtml.includes('http')) {
            imageHtml = await processImagesInContent(imageHtml, postIndex);
        }
        return `<div class="img-container">${sanitizeHtmlForEpub(imageHtml)}</div>`;
    }

    // Use the new cleaning function for all description content
    return await cleanContentForEpub(description, postIndex);
}

function extractSubreddit(link) {
    const match = link.match(/reddit\.com\/r\/([^/]+)/);
    return match ? match[1].toLowerCase() : 'Unknown Subreddit';
}

async function createEpub(subredditsWithPosts) {
    // Generate dated cover if enabled
    await generateDatedCover(config, VERBOSE_LOGGING);
    const coverImageFilename = epubConfig.outputCoverPath;

    const totalPosts = subredditsWithPosts.reduce((acc, sub) => acc + sub.posts.length, 0);
    if (totalPosts === 0) {
        log('warn', "No valid posts found to create an EPUB. Exiting.");
        process.exit(1);
        return;
    }
    const bookId = `reddit-${Date.now()}`;
    const currentDate = format(new Date(), 'MMMM do, yyyy');
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.folder('META-INF').file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    const oebps = zip.folder('OEBPS');
    const imagesFolder = oebps.folder('images');
    const imageFiles = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];
    log('epub', `Adding ${imageFiles.length} downloaded images to EPUB file.`);
    for (const imageFile of imageFiles) {
        const imagePath = path.join(imagesDir, imageFile);
        if (fs.existsSync(imagePath)) {
            const imageData = fs.readFileSync(imagePath);
            imagesFolder.file(imageFile, imageData);
        }
    }
    const flatPageList = [];
    const usedIds = new Set();
    const subredditIndexMap = new Map();

    subredditsWithPosts.forEach((subreddit, subredditIndex) => {
        if (subreddit.posts.length > 0) {
            let baseIntroId = `intro_${subreddit.name}`;
            let introId = baseIntroId;
            let suffix = 1;
            if (subredditIndexMap.has(subreddit.name)) {
                suffix = subredditIndexMap.get(subreddit.name) + 1;
                introId = `${baseIntroId}_${suffix}`;
            }
            subredditIndexMap.set(subreddit.name, suffix);
            subreddit._uniqueId = introId;
            usedIds.add(introId);
            flatPageList.push({
                type: 'intro', name: subreddit.name, description: subreddit.description,
                iconFilename: subreddit.iconFilename, sortingDescription: subreddit.sortingDescription,
                id: introId, href: `${introId}.xhtml`, subredditIndex: subredditIndex,
            });
            subreddit.posts.forEach((post, index) => {
                const postId = `post_${subreddit.name}_${suffix > 1 ? suffix + '_' : ''}${index}`;
                usedIds.add(postId);
                flatPageList.push({ type: 'post', post: post, id: postId, href: `${postId}.xhtml`, subredditIndex: subredditIndex });
            });
        }
    });

    const manifestImageItems = imageFiles
        .filter(file => file !== coverImageFilename)
        .map((file, index) => {
            const ext = path.extname(file).toLowerCase().substring(1);
            let mediaType = 'image/jpeg';
            if (ext === 'png') mediaType = 'image/png';
            if (ext === 'gif') mediaType = 'image/gif';
            return `    <item id="img${index}" href="images/${file}" media-type="${mediaType}"/>`;
        }).join('\n');

    const manifestChapterItems = flatPageList.map(page => `    <item id="${page.id}" href="${page.href}" media-type="application/xhtml+xml"/>`).join('\n');

    const subredditTocItems = epubConfig.hierarchicalTOC
        ? subredditsWithPosts.filter(s => s.posts.length > 0).map(subreddit => `    <item id="${subreddit._uniqueId}_toc" href="${subreddit._uniqueId}_toc.xhtml" media-type="application/xhtml+xml"/>`).join('\n')
        : '';

    const spineItems = ['    <itemref idref="toc"/>', ...flatPageList.map(page => `    <itemref idref="${page.id}"/>`)].join('\n');

    oebps.file('content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(epubConfig.title)} - ${currentDate}</dc:title>
    <dc:creator>${escapeXml(epubConfig.creator)}</dc:creator>
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:language>${epubConfig.language}</dc:language>
    <meta name="cover" content="cover-image" />
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="images/${coverImageFilename}" media-type="image/jpeg"/>
${manifestChapterItems}
${subredditTocItems}
${manifestImageItems}
  </manifest>
  <spine toc="ncx">${spineItems}</spine>
</package>`);

    oebps.file('styles.css', `
body { font-family: Georgia, serif; line-height: 1.5; margin: 1em; }
.nav-bar-top, .nav-bar-bottom { padding: 0.5em 0; font-family: monospace; font-size: 0.8em; text-align: center; border-top: 1px solid #000; border-bottom: 1px solid #000; margin: 1em 0; }
h1, h2, h3, h4 { margin: 1.5em 0 0.5em 0; } h1 { font-size: 1.5em; font-weight: bold; overflow-wrap: anywhere; }
h2 { font-size: 1.8em; text-align: center; } h3 { font-size: 1.2em; } h4 { font-weight: bold; }
img { display: block; margin: 1em auto; max-width: 100%; height: auto; } .img-container { text-align: center; margin: 1em 0; }
.comments { margin-top: 2em; border-top: 2px solid #000; padding-top: 1em; } .comment-thread { border-bottom: 1px solid #888; padding-bottom: 1em; margin-bottom: 1em; }
.comment-thread:last-child { border-bottom: none; margin-bottom: 0; } .subreddit { font-size: 0.9em; font-style: italic; }
.subreddit-title-page { text-align: center; padding: 15% 0; page-break-inside: avoid; }
.subreddit-sorting { font-size: 0.9em; color: #666; font-weight: normal; margin-top: 0.5em; font-style: italic; }
.subreddit-logo { width: 100px; height: 100px; border: 1px solid #000; margin: 0 auto 1em auto; }
.subreddit-description { font-style: italic; max-width: 80%; margin: 0 auto; }
.page-break { page-break-before: always; }
.toc-list { column-count: 1; }
.toc-list h2 { text-transform: capitalize; font-size: 1.2em; text-align: left; border: none; margin: 0.5em 0 0.2em 0; font-weight: normal; }
.toc-subreddit-group { margin: 0.3em 0; line-height: 1.4; }
.toc-subreddit-group a { text-decoration: none; color: #000; } 
.toc-entry { margin: 0.5em 0 0.5em 1.5em; } 
.toc-entry a { text-decoration: none; color: #000; }
.post-count { font-size: 0.85em; color: #666; font-style: italic; font-weight: normal; }
.sort-indicator { font-size: 0.85em; color: #888; font-style: italic; font-weight: normal; }
.subreddit-posts-link { text-align: center; margin: 1.5em 0; }
.subreddit-posts-link a { display: inline-block; padding: 0.5em 1em; background-color: #f0f0f0; border: 1px solid #ccc; text-decoration: none; color: #000; border-radius: 3px; }
.post-text { margin: 1em 0; padding: 1em; border-left: 3px solid #ddd; background-color: #f9f9f9; }
`);
    const tocEntries = subredditsWithPosts.map(subreddit => {
        if (subreddit.posts.length === 0) return '';

        if (epubConfig.hierarchicalTOC || epubConfig.simplifiedTOC) {
            const postCount = subreddit.posts.length;
            const countText = postCount === 1 ? '1 post' : `${postCount} posts`;
            const capitalizedName = subreddit.name.charAt(0).toUpperCase() + subreddit.name.slice(1).toLowerCase();
            const defaultSort = redditConfig.defaults.sort;
            const sortIndicator = subreddit.sort && subreddit.sort !== defaultSort
                ? ` <span class="sort-indicator">(${subreddit.sort.charAt(0).toUpperCase() + subreddit.sort.slice(1)})</span>`
                : '';
            return `<div class="toc-subreddit-group" id="${subreddit._uniqueId}">
                <h2><strong><a href="${subreddit._uniqueId}.xhtml">${capitalizedName}</a></strong>${sortIndicator} <span class="post-count">(${countText})</span></h2>
            </div>`;
        } else {
            const postLinks = subreddit.posts.map((post, index) => {
                const postPage = flatPageList.find(p => p.type === 'post' && p.subredditIndex === subredditsWithPosts.indexOf(subreddit) && p.post === post);
                const href = postPage ? postPage.href : `post_${subreddit.name}_${index}.xhtml`;
                return `<div class="toc-entry"><a href="${href}">${escapeXml(post.title)}</a></div>`;
            }).join('');
            const defaultSort = redditConfig.defaults.sort;
            const sortIndicator = subreddit.sort && subreddit.sort !== defaultSort
                ? ` <span class="sort-indicator">(${subreddit.sort.charAt(0).toUpperCase() + subreddit.sort.slice(1)})</span>`
                : '';
            return `<div class="toc-subreddit-group" id="${subreddit._uniqueId}"><h2><strong><a href="${subreddit._uniqueId}.xhtml">${subreddit.name}</a></strong>${sortIndicator}</h2>${postLinks}</div>`;
        }
    }).join('');
    oebps.file('toc.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Table of Contents</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body><h2>${escapeXml(epubConfig.title)} - ${currentDate}</h2><h3>Table of Contents</h3><div class="toc-list">${tocEntries}</div></body></html>`);

    if (epubConfig.hierarchicalTOC) {
        subredditsWithPosts.forEach(subreddit => {
            if (subreddit.posts.length === 0) return;

            const postLinks = subreddit.posts.map((post, index) => {
                const postPage = flatPageList.find(p => p.type === 'post' && p.subredditIndex === subredditsWithPosts.indexOf(subreddit) && p.post === post);
                const href = postPage ? postPage.href : `post_${subreddit.name}_${index}.xhtml`;
                return `<div class="toc-entry"><a href="${href}">${escapeXml(post.title)}</a></div>`;
            }).join('');

            const capitalizedName = subreddit.name.charAt(0).toUpperCase() + subreddit.name.slice(1).toLowerCase();
            const sortingDescription = subreddit.sort && subreddit.sort !== redditConfig.defaults.sort
                ? `<p class="subreddit-sorting">Sorted by: ${subreddit.sort.charAt(0).toUpperCase() + subreddit.sort.slice(1)}</p>`
                : '';

            const subredditTocContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>r/${subreddit.name} - Posts</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>
    <div class="page-break"></div>
    <div class="nav-bar-top"><a href="toc.xhtml#${subreddit._uniqueId}">Home</a></div>
    <h2>r/${capitalizedName}</h2>
    ${sortingDescription}
    <h3>Posts (${subreddit.posts.length})</h3>
    <div class="toc-list">${postLinks}</div>
</body></html>`;

            oebps.file(`${subreddit._uniqueId}_toc.xhtml`, subredditTocContent);
        });
    }
    const navPoints = subredditsWithPosts.map(subreddit => {
        if (subreddit.posts.length === 0) return '';
        const introPage = flatPageList.find(p => p.type === 'intro' && p.name === subreddit.name);
        if (!introPage) {
            console.warn(`Could not find intro page for subreddit: ${subreddit.name}`);
            return '';
        }
        const introPlayOrder = flatPageList.indexOf(introPage) + 2;
        const postNavPoints = subreddit.posts.map((post, postIndex) => {
            const postPage = flatPageList.find(p => p.type === 'post' && p.post && p.post.title === post.title && p.post.link === post.link);
            if (!postPage) {
                console.warn(`Could not find page for post: ${post.title}`);
                return '';
            }
            const postPlayOrder = flatPageList.indexOf(postPage) + 2;
            const safeTitle = escapeXml(post.title.substring(0, 80) + (post.title.length > 80 ? '...' : ''));
            return `<navPoint id="nav-${postPage.id}" playOrder="${postPlayOrder}"><navLabel><text>${safeTitle}</text></navLabel><content src="${postPage.href}"/></navPoint>`;
        }).filter(navPoint => navPoint !== '').join('\n');
        return `<navPoint id="nav-${introPage.id}" playOrder="${introPlayOrder}"><navLabel><text>${subreddit.name}</text></navLabel><content src="${introPage.href}"/>${postNavPoints}</navPoint>`;
    }).filter(navPoint => navPoint !== '').join('\n');
    oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${bookId}"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${escapeXml(epubConfig.title)} - ${currentDate}</text></docTitle>
<navMap>
<navPoint id="nav-toc" playOrder="1"><navLabel><text>Table of Contents</text></navLabel><content src="toc.xhtml"/></navPoint>
${navPoints}
</navMap></ncx>`);
    const orderedSubreddits = subredditsWithPosts.filter(s => s.posts.length > 0);
    const subIntroHrefs = {};
    flatPageList.forEach(p => {
        if (p.type === 'intro') {
            const subreddit = orderedSubreddits[p.subredditIndex];
            subIntroHrefs[p.subredditIndex] = p.href;
        }
    });
    for (let i = 0; i < flatPageList.length; i++) {
        const page = flatPageList[i];
        const prevPage = i > 0 ? flatPageList[i - 1] : null;
        const nextPage = i < flatPageList.length - 1 ? flatPageList[i + 1] : null;
        const currentSubIndex = page.subredditIndex;
        const navParts = [];
        if (currentSubIndex > 0) {
            const prevSubreddit = orderedSubreddits[currentSubIndex - 1];
            navParts.push(`<a href="${subIntroHrefs[currentSubIndex - 1]}">&lt;&lt; r/${prevSubreddit.name}</a>`);
        }
        if (prevPage) { navParts.push(`<a href="${prevPage.href}">&lt; Prev</a>`); }
        const currentSubreddit = orderedSubreddits[currentSubIndex];
        let homeLink;
        if (epubConfig.hierarchicalTOC) {
            if (page.type === 'intro') {
                homeLink = currentSubreddit ? `toc.xhtml#${currentSubreddit._uniqueId}` : 'toc.xhtml';
                navParts.push(`<a href="${homeLink}">Home</a>`);
            } else {
                homeLink = `${currentSubreddit._uniqueId}_toc.xhtml`;
                navParts.push(`<a href="${homeLink}">Home</a>`);
            }
        } else {
            const menuHref = currentSubreddit ? `toc.xhtml#${currentSubreddit._uniqueId}` : 'toc.xhtml';
            navParts.push(`<a href="${menuHref}">Menu</a>`);
        }
        if (nextPage) { navParts.push(`<a href="${nextPage.href}">Next &gt;</a>`); }
        if (currentSubIndex > -1 && currentSubIndex < orderedSubreddits.length - 1) {
            const nextSubreddit = orderedSubreddits[currentSubIndex + 1];
            navParts.push(`<a href="${subIntroHrefs[currentSubIndex + 1]}">r/${nextSubreddit.name} &gt;&gt;</a>`);
        }
        const navLinks = navParts.join(' | ');
        let pageContent = '';
        if (page.type === 'intro') {
            const iconHtml = page.iconFilename ? `<img src="images/${page.iconFilename}" alt="${page.name} logo" class="subreddit-logo" />` : '';
            const sortingHtml = page.sortingDescription ? `<p class="subreddit-sorting">${page.sortingDescription}</p>` : '';
            const descriptionHtml = page.description ? `<p class="subreddit-description">${escapeXml(page.description)}</p>` : '';
            const postsTocLink = epubConfig.hierarchicalTOC
                ? `<div class="subreddit-posts-link"><a href="${currentSubreddit._uniqueId}_toc.xhtml">View Posts →</a></div>`
                : '';

            pageContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(page.name)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>
    <div class="nav-bar-top">${navLinks}</div>
    <div class="subreddit-title-page">${iconHtml}<h1>${escapeXml(page.name)}</h1>${sortingHtml}${descriptionHtml}${postsTocLink}</div>
</body></html>`;
        } else {
            const post = page.post;
            const commentsHtml = generateCommentsHtml(post.comments, post.config);
            let rawDescription = post.description;
            if (post.link.includes('reddit.com/r/')) {
                rawDescription = rawDescription.replace(new RegExp(`^\\s*${escapeRegex(escapeXml(post.title))}\\s*`, 'i'), '');
                rawDescription = rawDescription.replace(new RegExp(`^\\s*<h[1-6][^>]*>\\s*${escapeRegex(escapeXml(post.title))}\\s*</h[1-6]>\\s*`, 'i'), '');
                rawDescription = rawDescription.replace(post.title, '');
            }
            const formattedDescription = await formatDescription(rawDescription, post.postIndex);
            const description = sanitizeHtmlForEpub(formattedDescription);

            pageContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(post.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>
    <div class="nav-bar-top">${navLinks}</div>
    <div class="main-content">
        <h1>${escapeXml(post.title)}</h1><p class="subreddit">r/${escapeXml(post.subreddit)}</p>
        <div>${description}</div>
        ${commentsHtml ? `<div class="comments"><h4>Comments:</h4>${commentsHtml}</div>` : ''}
    </div>
</body></html>`;
        }
        oebps.file(page.href, pageContent);
    }
    const content = await zip.generateAsync({ type: 'nodebuffer' });

    let currentEpubFilename;
    if (typeof epubConfig.generateFilename === 'function') {
        currentEpubFilename = epubConfig.generateFilename();
    } else {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        currentEpubFilename = `reddit_${year}-${month}-${day}_${hours}-${minutes}.epub`;
    }

    const currentEpubPath = path.join(__dirname, currentEpubFilename);
    fs.writeFileSync(currentEpubPath, content);
    log('epub', `EPUB file created successfully as "${currentEpubFilename}"`);
}


async function processSinglePost(entry, currentPostNum, totalPostsInSub, sourceSubredditName, resolvedConfig) {
    try {
        const postId = (entry.id?.[0] || entry.id || '').toString().split('_')[1] || `unknown_${Date.now()}_${Math.random()}`;
        const title = entry.title?.[0] || entry.title || 'Untitled';
        const redditLink = entry.link?.[0]?.$.href || entry.permalink || entry.link;
        const subreddit = extractSubreddit(redditLink);

        log('process', `(${currentPostNum}/${totalPostsInSub}) [r/${subreddit}] Processing: "${truncate(title, 60)}"`);

        let postContent = entry.content?.[0]?._ || entry.description?.[0] || '';
        const articleLinkRegex = /<a href="([^"]+)">\[link\]<\/a>/;
        const match = postContent.match(articleLinkRegex);
        let externalUrl = entry.url || (match ? match[1] : null);

        // Check if this post has an image based on Reddit's metadata
        const rawData = entry._rawRedditData;
        const hasRedditImage = rawData && (
            rawData.post_hint === 'image' ||
            rawData.domain === 'i.redd.it' ||
            (rawData.url && rawData.url.includes('i.redd.it'))
        );

        // If we have a Reddit image but no external URL detected, use the raw data URL
        if (hasRedditImage && !externalUrl && rawData && rawData.url) {
            externalUrl = rawData.url;
        }

        // For RSS feeds without rawData, try to extract image URL from content
        if (!rawData && postContent) {
            const imageMatch = postContent.match(/<img[^>]+src="([^"]+)"/);
            if (imageMatch && imageMatch[1] && imageMatch[1].includes('i.redd.it')) {
                // This is likely an image post from RSS - use the image URL
                if (!externalUrl || externalUrl.includes('reddit.com')) {
                    externalUrl = imageMatch[1];
                }
            }
        }

        const isLinkPost = externalUrl && externalUrl !== redditLink;

        if (isLinkPost) {
            if (isImageUrl(externalUrl) || hasRedditImage) {
                log('info', `Type: Image Link -> ${truncate(externalUrl, 60)}`);
                let imageHtml;
                if (config.reddit.downloadImages) {
                    const imageName = `post_${postId}_main`;
                    const fileName = await downloadImage(externalUrl, imageName);
                    imageHtml = fileName
                        ? `<div class="img-container"><img src="images/${fileName}" alt="${escapeXml(title)}" /></div>`
                        : `<div class="img-container"><p><em>[Image unavailable]</em></p></div>`;
                } else {
                    imageHtml = `<div class="img-container"><img src="${externalUrl}" alt="${escapeXml(title)}" /></div>`;
                }

                // Add selftext if available
                let selftextHtml = '';
                if (entry.selftext_html && entry.selftext_html.trim()) {
                    selftextHtml = `<div class="post-text">${entry.selftext_html}</div>`;
                } else if (entry.selftext && entry.selftext.trim()) {
                    selftextHtml = `<div class="post-text">${escapeXml(entry.selftext).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br />')}</div>`;
                } else if (!rawData && postContent) {
                    // For RSS feeds, extract text from the existing HTML content
                    const textMatch = postContent.match(/<div class="md">(.*?)<\/div>/s);
                    if (textMatch && textMatch[1] && textMatch[1].trim() && textMatch[1].trim() !== '') {
                        selftextHtml = `<div class="post-text">${textMatch[1]}</div>`;
                    }
                }

                postContent = imageHtml + selftextHtml;
            } else if (isRedditGalleryUrl(externalUrl)) {
                log('info', `Type: Reddit Gallery. Parsing: ${truncate(redditLink, 60)}`);
                let galleryUrl = `${redditLink}.json`;
                if (config.reddit.enableOAuth2 && redditAuth.isConfigured()) {
                    galleryUrl = convertToOauthUrl(galleryUrl);
                }
                const galleryResponse = await makeRedditApiRequest(galleryUrl, { timeout: config.reddit.timeouts.galleryParsing });
                const mediaMetadata = galleryResponse.data[0].data.children[0].data.media_metadata;
                if (mediaMetadata) {
                    const galleryImagesHtml = [];
                    const imageItems = Object.values(mediaMetadata);

                    // Process gallery images sequentially (NO CONCURRENCY)
                    for (let index = 0; index < imageItems.length; index++) {
                        const item = imageItems[index];
                        const highestRes = item.p[item.p.length - 1];
                        const imageUrl = decode(highestRes.u);
                        if (config.reddit.downloadImages) {
                            const imageName = `post_${postId}_gallery_${index}`;
                            const fileName = await downloadImage(imageUrl, imageName);
                            if (fileName) {
                                galleryImagesHtml[index] = `<img src="images/${fileName}" alt="Gallery image ${index + 1}" />`;
                            }
                        } else {
                            galleryImagesHtml[index] = `<img src="${imageUrl}" alt="Gallery image ${index + 1}" />`;
                        }
                    }
                    let galleryHtml = `<div class="img-container">${galleryImagesHtml.join('')}</div>`;

                    // Add selftext if available
                    let selftextHtml = '';
                    if (entry.selftext_html && entry.selftext_html.trim()) {
                        selftextHtml = `<div class="post-text">${entry.selftext_html}</div>`;
                    } else if (entry.selftext && entry.selftext.trim()) {
                        selftextHtml = `<div class="post-text">${escapeXml(entry.selftext).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br />')}</div>`;
                    } else if (!rawData && postContent) {
                        // For RSS feeds, extract text from the existing HTML content
                        const textMatch = postContent.match(/<div class="md">(.*?)<\/div>/s);
                        if (textMatch && textMatch[1] && textMatch[1].trim() && textMatch[1].trim() !== '') {
                            selftextHtml = `<div class="post-text">${textMatch[1]}</div>`;
                        }
                    }

                    postContent = galleryHtml + selftextHtml;
                }
            } else {
                log('info', `Type: Article Link. Parsing: ${truncate(externalUrl, 60)}`);
                log('debug', `Starting Mercury parse for: ${externalUrl}`);

                const article = await withRetry(async () => {
                    log('debug', `Mercury parse attempt for: ${truncate(externalUrl, 50)}`);
                    return await Mercury.parse(externalUrl);
                }, `Mercury parsing for ${truncate(externalUrl, 50)}`, 2);

                log('debug', `Mercury parse completed for: ${truncate(externalUrl, 50)}`);
                if (article && article.content) {
                    let leadImageHtml = '';
                    if (article.lead_image_url && !isUnsupportedImageFormat(article.lead_image_url)) {
                        if (config.reddit.downloadImages) {
                            const imageName = `post_${postId}_lead`;
                            const fileName = await downloadImage(article.lead_image_url, imageName);
                            if (fileName) {
                                leadImageHtml = `<div class="img-container"><img src="images/${fileName}" alt="Lead article image" /></div>`;
                            }
                        } else {
                            leadImageHtml = `<div class="img-container"><img src="${article.lead_image_url}" alt="Lead article image" /></div>`;
                        }
                    }

                    // Clean the article content using our new function
                    let cleanedArticleContent = await cleanContentForEpub(article.content, postId);

                    const sourceInfo = `Source: ${escapeXml(article.domain)}${article.author ? ` | By ${escapeXml(article.author)}` : ''}`;
                    const linkLabel = redditLink.includes('reddit.com/r/') ? 'Original Post' : 'Original Article';
                    // Use full cleaned article content with preserved paragraph formatting
                    const formattedContent = cleanedArticleContent
                        // Convert paragraph tags to line breaks
                        .replace(/<\/p>/gi, '\n\n')
                        .replace(/<p[^>]*>/gi, '')
                        // Convert br tags to line breaks
                        .replace(/<br[^>]*>/gi, '\n')
                        // Remove other HTML tags but keep structure
                        .replace(/<[^>]+>/g, ' ')
                        // Clean up whitespace but preserve paragraph breaks
                        .replace(/[ \t]+/g, ' ')
                        .replace(/\n[ \t]*/g, '\n')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();

                    // Convert line breaks back to proper HTML paragraphs
                    const paragraphs = formattedContent.split('\n\n').filter(p => p.trim().length > 0);
                    const htmlContent = paragraphs.map(p => `<p>${escapeXml(p.trim())}</p>`).join('');

                    postContent = `<h2>${escapeXml(article.title)}</h2><h4>${sourceInfo}</h4><p><em>${linkLabel}: <a href="${escapeXml(article.url)}">${escapeXml(article.url)}</a></em></p>${leadImageHtml}${htmlContent}`;
                } else {
                    log('warn', `Mercury found no content for: "${truncate(title, 60)}"`);
                    stats.mercuryFailures++;

                    // Skip unfetchable articles if option is enabled
                    if (resolvedConfig.skipUnfetchableArticles) {
                        log('skip', `Skipping unfetchable article: "${truncate(title, 60)}"`);
                        stats.unfetchableArticlesSkipped++;
                        return null; // Return null to indicate this post should be skipped
                    }

                    // Try to get lead image even if Mercury parsing failed
                    let fallbackImageHtml = '';
                    if (config.reddit.downloadImages) {
                        const imageName = `post_${postId}_fallback`;
                        const fileName = await downloadImage(externalUrl, imageName);
                        if (fileName) {
                            fallbackImageHtml = `<div class="img-container"><img src="images/${fileName}" alt="Article thumbnail" /></div>`;
                        }
                    }

                    postContent = `<p>Could not parse article from: <a href="${externalUrl}">${escapeXml(externalUrl)}</a></p>${fallbackImageHtml}`;
                }
            }
        } else {
            // This might be a text post with an associated image
            let imageHtml = '';
            if (hasRedditImage && externalUrl) {
                log('info', `Type: Text Post with Image -> ${truncate(externalUrl, 60)}`);
                if (config.reddit.downloadImages) {
                    const imageName = `post_${postId}_text_image`;
                    const fileName = await downloadImage(externalUrl, imageName);
                    imageHtml = fileName
                        ? `<div class="img-container"><img src="images/${fileName}" alt="${escapeXml(title)}" /></div>`
                        : `<div class="img-container"><p><em>[Image unavailable]</em></p></div>`;
                } else {
                    imageHtml = `<div class="img-container"><img src="${externalUrl}" alt="${escapeXml(title)}" /></div>`;
                }
            } else {
                log('info', `Type: Text Post (Self-Post)`);
            }

            let selfText = '';
            if (entry.selftext_html) {
                selfText = entry.selftext_html;
            } else if (entry.selftext) {
                selfText = `<p>${escapeXml(entry.selftext).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br />')}</p>`;
            } else if (postContent) {
                selfText = postContent;
            }

            if (selfText && selfText.trim() && selfText !== '[removed]' && selfText !== '[deleted]') {
                const cleanedSelfText = await cleanContentForEpub(selfText, postId);
                postContent = imageHtml + cleanedSelfText;
            } else {
                postContent = imageHtml || '<p><em>This post has no text content.</em></p>';
            }
        }

        // Add Reddit discussion link at the end of each post
        postContent += `<hr /><p><strong>Discussion on Reddit:</strong> <a href="${redditLink}">${redditLink}</a></p>`;

        log('debug', `Starting comment fetch for: ${truncate(title, 60)}`);
        const comments = await fetchComments(redditLink, resolvedConfig.commentsPerPost, resolvedConfig);
        log('debug', `Comment fetch completed for: ${truncate(title, 60)}`);
        log('success', `Finished processing "${truncate(title, 60)}"`);
        return { title, link: redditLink, description: postContent, comments, subreddit, sourceSubreddit: sourceSubredditName, postIndex: -1, config: { ...resolvedConfig } };
    } catch (error) {
        stats.mercuryFailures++; // Count any post failure as a mercury/parsing failure
        log('error', `Failed to process post "${truncate(entry.title?.[0] || 'Untitled', 50)}": ${error.message}`);
        return null; // Return null to indicate failure
    }
}


async function processSubredditFeed(resolvedConfig) {
    const { name, sort, timeframe, postsPerSubreddit } = resolvedConfig;
    const sortString = sort ? `/${sort}` : '';
    const timeString = (sort === 'top' || sort === 'controversial') && timeframe ? `?t=${timeframe}` : '';
    const displayString = `r/${name}${sortString}${timeString ? ` (${timeframe})` : ''}`;

    log('info', `--- Fetching posts from ${displayString} ---`);
    await updateProgress(name, 'processing');

    return processSubredditFeedInternal(resolvedConfig);
}

async function processSubredditFeedInternal(resolvedConfig) {
    const { name, sort, timeframe, postsPerSubreddit } = resolvedConfig;
    const sortString = sort ? `/${sort}` : '';
    const timeString = (sort === 'top' || sort === 'controversial') && timeframe ? `?t=${timeframe}` : '';
    const displayString = `r/${name}${sortString}${timeString ? ` (${timeframe})` : ''}`;

    // Initialize subreddit-specific tracking
    let subredditStats = {
        totalEntriesAvailable: 0,
        entriesProcessed: 0,
        imagePostsSkipped: 0,
        galleryPostsSkipped: 0,
        videoPostsSkipped: 0,
        autoModPostsSkipped: 0,
        internalLinksSkipped: 0,
        fallbackImagePostsIncluded: 0,
        sourceMethod: 'unknown'
    };

    // Try authenticated first, then fall back to RSS
    let rssData = null;

    if (config.reddit.enableOAuth2 && redditAuth.isConfigured()) {
        try {
            // Request more posts than needed to account for filtering (up to 100, Reddit's limit)
            const requestLimit = Math.min(100, postsPerSubreddit * 4); // 4x buffer for filtering
            const limitParam = timeString ? `&limit=${requestLimit}` : `?limit=${requestLimit}`;
            const authUrl = `https://oauth.reddit.com/r/${name}${sortString}.json${timeString}${limitParam}`;
            rssData = await fetchRssFeed(authUrl, true); // true indicates JSON mode
            subredditStats.sourceMethod = 'OAuth2 API';
        } catch (error) {
            log('warn', `OAuth request failed for ${displayString}: ${error.message}, falling back to RSS`);
            rssData = null;
        }
    }

    if (!rssData) {
        try {
            // RSS feeds are limited to ~25 posts by Reddit, but we can still try
            const rssUrl = `https://www.reddit.com/r/${name}${sortString}/.rss${timeString}`;
            rssData = await fetchRssFeed(rssUrl, false); // false indicates RSS mode
            subredditStats.sourceMethod = 'RSS Feed';
        } catch (error) {
            log('error', `Both OAuth and RSS requests failed for ${displayString}: ${error.message}`);
            rssData = null;
        }
    }

    const entries = rssData?.feed?.entry || rssData?.rss?.channel?.[0]?.item;
    if (!rssData || !entries || entries.length === 0) {
        log('warn', `Could not get posts from ${displayString}. Skipping.`);
        return [];
    }

    subredditStats.totalEntriesAvailable = entries.length;
    await updateProgress(name, 'filtering');
    const validEntries = [];
    const skippedEntries = []; // Collect skipped posts for potential quota fill (preserves RSS order)

    for (const entry of entries) {
        // If we've already got enough valid posts, stop processing (but continue collecting skipped entries)
        if (validEntries.length >= postsPerSubreddit) {
            // Still collect skipped entries for potential quota fill even after target reached
            const postContent = entry.content?.[0]?._ || entry.description?.[0] || '';
            const externalUrl = entry.link?.[0]?.$.href || entry.link?.[0] || entry.url || null;
            const title = entry.title?.[0] || entry.title || '';
            let finalExternalUrl = externalUrl;
            if (postContent) {
                const match = postContent.match(/<a href="([^"]+)">\[link\]<\/a>/);
                if (match && match[1] !== externalUrl) {
                    finalExternalUrl = match[1];
                }
            }

            // Quick collection of remaining skipped entries
            if (resolvedConfig.skipImageAndGalleryPosts && resolvedConfig.allowImagePostsIfCantFindOtherPosts &&
                (isImagePost(postContent, finalExternalUrl, title, entry._rawRedditData) ||
                    isGalleryPost(postContent, finalExternalUrl, title, entry._rawRedditData))) {
                skippedEntries.push(entry);
            } else if (!resolvedConfig.includeInternalLinks && isInternalRedditLink(finalExternalUrl) &&
                !isUnsupportedVideo(postContent, finalExternalUrl)) {
                skippedEntries.push(entry);
            }
            continue;
        }
        const postContent = entry.content?.[0]?._ || entry.description?.[0] || '';
        const externalUrl = entry.link?.[0]?.$.href || entry.link?.[0] || entry.url || null;
        const title = entry.title?.[0] || entry.title || '';
        const author = entry['reddit:author']?.[0] || entry._rawRedditData?.author || 'unknown';
        let finalExternalUrl = externalUrl;
        // For RSS feeds, always check the [link] tag as it contains the actual content URL
        // (entry.link points to comments, not the actual content)
        if (postContent) {
            const match = postContent.match(/<a href="([^"]+)">\[link\]<\/a>/);
            if (match && match[1] !== externalUrl) { // Only use if different from comments URL
                finalExternalUrl = match[1];
            }
        }

        // Filter AutoModerator posts
        if (resolvedConfig.skipAutoModerator && author === 'AutoModerator') {
            log('skip', `Skipping AutoModerator post: "${truncate(title, 60)}"`);
            subredditStats.autoModPostsSkipped++;
            stats.autoModPostsSkipped = (stats.autoModPostsSkipped || 0) + 1;
            continue;
        }

        // Filter video posts
        if (!resolvedConfig.includeVideoContent && isUnsupportedVideo(postContent, finalExternalUrl)) {
            log('skip', `Skipping video post: "${truncate(title, 60)}"`);
            subredditStats.videoPostsSkipped++;
            stats.videoPostsSkipped++;
            continue;
        }

        // Filter image posts - but collect them for potential quota fill if enabled
        if (resolvedConfig.skipImageAndGalleryPosts && isImagePost(postContent, finalExternalUrl, title, entry._rawRedditData)) {
            log('skip', `Skipping image post: "${truncate(title, 60)}"`);
            subredditStats.imagePostsSkipped++;
            stats.imagePostsSkipped++;
            // Store skipped image post for potential quota fill (only if allowImagePostsIfCantFindOtherPosts is true)
            if (resolvedConfig.allowImagePostsIfCantFindOtherPosts) {
                skippedEntries.push(entry);
            }
            continue;
        }

        // Filter gallery posts - but collect them for potential quota fill if enabled
        if (resolvedConfig.skipImageAndGalleryPosts && isGalleryPost(postContent, finalExternalUrl, title, entry._rawRedditData)) {
            log('skip', `Skipping gallery post: "${truncate(title, 60)}"`);
            subredditStats.galleryPostsSkipped++;
            stats.galleryPostsSkipped++;
            // Store skipped gallery post for potential quota fill (only if allowImagePostsIfCantFindOtherPosts is true)
            if (resolvedConfig.allowImagePostsIfCantFindOtherPosts) {
                skippedEntries.push(entry);
            }
            continue;
        }

        // Filter internal links - but collect non-video articles for potential quota fill
        if (!resolvedConfig.includeInternalLinks && isInternalRedditLink(finalExternalUrl)) {
            log('skip', `Skipping internal link: "${truncate(title, 60)}"`);
            subredditStats.internalLinksSkipped++;
            stats.internalLinksSkipped++;
            // Store skipped internal link for potential quota fill (exclude videos)
            if (!isUnsupportedVideo(postContent, finalExternalUrl)) {
                skippedEntries.push(entry);
            }
            continue;
        }

        validEntries.push(entry);
    }


    // Quota fill: If we still don't have enough posts, fill from skipped entries in RSS order
    log('info', `QUOTA CHECK: ${validEntries.length}/${postsPerSubreddit}, skippedEntries: ${skippedEntries.length}`);

    // TEMPORARILY DISABLED FOR DEBUGGING
    if (false && validEntries.length < postsPerSubreddit && skippedEntries.length > 0) {
        const neededPosts = postsPerSubreddit - validEntries.length;
        const availableSkipped = skippedEntries.length;
        log('info', `🔄 QUOTA FILL STARTING: Need ${neededPosts} more posts, have ${availableSkipped} skipped entries available`);

        let quotaFillCount = 0;
        for (const entry of skippedEntries) {
            if (validEntries.length >= postsPerSubreddit) break;

            const title = entry.title?.[0] || entry.title || '';
            const author = entry['reddit:author']?.[0] || entry._rawRedditData?.author || 'unknown';
            const postContent = entry.content?.[0]?._ || entry.description?.[0] || '';
            const externalUrl = entry.link?.[0]?.$.href || entry.link?.[0] || entry.url || null;
            let finalExternalUrl = externalUrl;
            if (!finalExternalUrl && postContent) {
                const match = postContent.match(/<a href="([^"]+)">\[link\]<\/a>/);
                finalExternalUrl = match ? match[1] : null;
            }

            // Still filter AutoModerator and other unwanted content during quota fill
            if (resolvedConfig.skipAutoModerator && author === 'AutoModerator') {
                log('debug', `Quota fill: Skipping AutoModerator post: "${truncate(title, 40)}"`);
                continue;
            }
            if (!resolvedConfig.includeVideoContent && isUnsupportedVideo(postContent, finalExternalUrl)) {
                log('debug', `Quota fill: Skipping video post: "${truncate(title, 40)}"`);
                continue;
            }

            // Determine post type for logging
            const isImage = isImagePost(postContent, finalExternalUrl, title, entry._rawRedditData);
            const isGallery = isGalleryPost(postContent, finalExternalUrl, title, entry._rawRedditData);
            const postType = isImage ? 'image' : isGallery ? 'gallery' : 'article';

            log('info', `✅ QUOTA FILL SUCCESS: Adding "${truncate(title, 60)}" (${postType})`);

            // Update appropriate statistics
            if (isImage || isGallery) {
                subredditStats.fallbackImagePostsIncluded = (subredditStats.fallbackImagePostsIncluded || 0) + 1;
                stats.fallbackImagePostsIncluded = (stats.fallbackImagePostsIncluded || 0) + 1;
            } else {
                subredditStats.fallbackArticlesIncluded = (subredditStats.fallbackArticlesIncluded || 0) + 1;
                stats.fallbackArticlesIncluded = (stats.fallbackArticlesIncluded || 0) + 1;
            }

            validEntries.push(entry);
            quotaFillCount++;
        }
        log('info', `🔄 QUOTA FILL COMPLETE: Added ${quotaFillCount} posts, final count: ${validEntries.length}/${postsPerSubreddit}`);
    } else {
        const reason = validEntries.length >= postsPerSubreddit ? 'Already sufficient posts' :
            skippedEntries.length === 0 ? 'No skipped entries available' : 'Unknown reason';
        log('info', `⏭️  QUOTA FILL SKIPPED: ${reason}`);
    }

    const entriesToProcess = validEntries;
    await updateProgress(name, 'parsing');

    // Process posts sequentially (NO CONCURRENCY)  
    const results = [];
    for (let i = 0; i < entriesToProcess.length; i++) {
        const entry = entriesToProcess[i];
        const result = await processSinglePost(entry, i + 1, entriesToProcess.length, name, resolvedConfig);
        results.push(result);
    }
    // **FIX**: Filter out null results from failed posts
    let successfulPosts = results.filter(Boolean);

    // Additional quota fill: TEMPORARILY DISABLED FOR TESTING
    // if (successfulPosts.length < postsPerSubreddit) {
    //     log('info', `POST-PROCESSING QUOTA FILL: Have ${successfulPosts.length}/${postsPerSubreddit} posts after processing`);
    // }

    // Update progress and log completion
    const subredditName = resolvedConfig._subredditName || resolvedConfig.name;
    subredditStats.entriesProcessed = entries.length;
    completeSubreddit(subredditName, successfulPosts.length, postsPerSubreddit, subredditStats);
    return successfulPosts;
}

async function main() {
    if (SIMPLE_LOGGING) {
        console.log("\n🗞️  Reddit to Kindle Newsletter Generator");
        console.log("════════════════════════════════════════\n");
    } else {
        console.log("\n/============================================\\");
        console.log(`|  Reddit Weekly Newsletter Generator v${SCRIPT_VERSION}  |`);
        console.log("\\============================================/\n");
    }

    log('info', "Starting process...");
    log('config', `Using global config: ${JSON.stringify({ ...config, reddit: { ...config.reddit, subreddits: undefined, defaults: undefined, oauth2: undefined } })}`);
    log('config', `Using default subreddit settings: ${JSON.stringify(config.reddit.defaults)}`);
    log('config', `Image download mode: ${config.reddit.downloadImages ? 'ON' : 'OFF'}`);

    // Initialize progress tracking
    totalSubreddits = config.reddit.subreddits.length;

    // Display vital information in simple mode
    if (SIMPLE_LOGGING) {
        // OAuth status check
        let oauthStatus = "❌ Disabled";
        if (config.reddit.enableOAuth2) {
            if (redditAuth.isConfigured()) {
                const oauthWorking = await redditAuth.checkOAuthWorking();
                oauthStatus = oauthWorking ? "✅ Enabled & Working" : "⚠️  Enabled but Blocked";
            } else {
                oauthStatus = "⚠️  Enabled but Not Configured";
            }
        }

        simpleLog(`📊 System Status:`);
        simpleLog(`   • OAuth2: ${oauthStatus}`);
        simpleLog(`   • Images: ${config.reddit.downloadImages ? '✅ Downloading' : '❌ Skipping'}`);
        simpleLog(`   • Default posts per subreddit: ${config.reddit.defaults.postsPerSubreddit}`);
        simpleLog(`   • Processing ${totalSubreddits} subreddits\n`);

        // Initialize progress bar (only if not already created)
        if (!progressBar) {
            progressBar = new cliProgress.SingleBar({
                format: 'Progress |{bar}| {percentage}% | {current}/{subredditCount} | {statusMessage}',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                hideCursor: true,
                stopOnComplete: true,
                clearOnComplete: false
            });
            progressBar.start(totalSubreddits, 0, {
                current: 0,
                subredditCount: totalSubreddits,
                statusMessage: '🚀 Initializing...'
            });
        }
    }

    // Only log detailed OAuth configuration info in verbose mode
    // (Simple mode already checked OAuth status above)
    if (VERBOSE_LOGGING) {
        const delays = getRequestDelays();
        if (config.reddit.enableOAuth2) {
            if (redditAuth.isConfigured()) {
                log('config', 'Reddit OAuth2 authentication: ENABLED and CONFIGURED');

                // Check if OAuth API calls are actually working
                const oauthWorking = await redditAuth.checkOAuthWorking();
                if (oauthWorking) {
                    log('config', `Reddit API rate limit: 60 requests/minute (1 request per ${delays.betweenApiCalls / 1000}s)`);
                } else {
                    log('config', 'Reddit OAuth2 authentication: Detected API blocking, falling back to RSS feeds');
                    const unauthDelays = getRequestDelays();
                    log('config', `Reddit API rate limit: 10 requests/minute (1 request per ${unauthDelays.betweenApiCalls / 1000}s)`);
                }
            } else {
                log('warn', 'Reddit OAuth2 authentication: ENABLED but NOT CONFIGURED (check config.js)');
                log('config', `Falling back to unauthenticated requests (1 request per ${delays.betweenApiCalls / 1000}s)`);
            }
        } else {
            log('config', `Reddit OAuth2 authentication: DISABLED (1 request per ${delays.betweenApiCalls / 1000}s)`);
        }
    }

    log('init', 'Preparing a clean image directory...');
    if (fs.existsSync(imagesDir)) {
        fs.rmSync(imagesDir, { recursive: true, force: true });
        log('init', 'Removed old image directory.');
    }
    fs.mkdirSync(imagesDir, { recursive: true });
    log('init', 'Created fresh image directory.');

    // Process all subreddit configs (allowing duplicates with different settings)
    const allSubredditConfigs = config.reddit.subreddits.map((sub, index) => {
        const subConfig = typeof sub === 'string' ? { name: sub } : sub;
        // Add unique identifier for each config to handle duplicates
        return { ...subConfig, _configIndex: index };
    });

    // Optionally randomize the order if enabled
    const subredditConfigs = config.reddit.randomizeSubredditOrder
        ? allSubredditConfigs.sort(() => Math.random() - 0.5)
        : allSubredditConfigs;

    log('config', `Processing ${subredditConfigs.length} subreddit configurations (${[...new Set(subredditConfigs.map(s => s.name.toLowerCase()))].length} unique subreddits).`);

    // Update progress bar to show work is starting
    if (SIMPLE_LOGGING && progressBar) {
        progressBar.update(0, {
            current: 0,
            subredditCount: totalSubreddits,
            statusMessage: '🚀 Starting subreddit processing...'
        });
    }

    // Process subreddits sequentially (NO CONCURRENCY)
    let allPosts = [];
    for (let index = 0; index < subredditConfigs.length; index++) {
        const subConfig = subredditConfigs[index];
        const resolvedConfig = Object.freeze({ ...config.reddit.defaults, ...subConfig, name: subConfig.name.toLowerCase(), _subredditName: subConfig.name });
        log('debug', `Config for r/${subConfig.name}: ${JSON.stringify(resolvedConfig)}`);

        if (index > 0) await sleep(getRequestDelays().betweenSubreddits);

        try {
            const posts = await processSubredditFeed(resolvedConfig);
            posts.forEach(post => { if (!post.config) { log('error', `Post "${truncate(post.title, 50)}" missing config!`); post.config = resolvedConfig; } });
            allPosts.push(...posts);
        } catch (error) {
            log('error', `Failed to process subreddit r/${subConfig.name}: ${error.message}`);
        }
    }

    log('debug', `All posts sourceSubreddits: ${[...new Set(allPosts.map(p => p.sourceSubreddit))].join(', ')}`);

    allPosts.forEach((post, index) => { post.postIndex = index; });

    const subredditsWithPosts = [];

    // Process subreddit info sequentially (NO CONCURRENCY)
    for (const subConfig of subredditConfigs) {
        const subredditName = subConfig.name.toLowerCase();
        // Find posts that match this specific configuration instance
        const postsForThisSub = allPosts.filter(p =>
            p.sourceSubreddit.toLowerCase() === subredditName &&
            p.config && p.config._configIndex === subConfig._configIndex
        );
        log('debug', `r/${subredditName} (config ${subConfig._configIndex}): Found ${postsForThisSub.length} posts`);
        if (postsForThisSub.length > 0) {
            const subInfo = await fetchSubredditInfo(subredditName);
            let localIconFilename = null;
            if (subInfo.iconUrl && config.reddit.downloadImages) {
                localIconFilename = await downloadImage(subInfo.iconUrl, `logo_${subredditName}_${subConfig._configIndex}`);
            }
            subredditsWithPosts.push({
                name: subredditName,
                posts: postsForThisSub,
                description: subInfo.description,
                iconFilename: localIconFilename,
                sortingDescription: generateSortingDescription(subConfig.sort || config.reddit.defaults.sort, subConfig.timeframe || config.reddit.defaults.timeframe),
                configIndex: subConfig._configIndex,
                sort: subConfig.sort || config.reddit.defaults.sort
            });
        }
    }
    await createEpub(subredditsWithPosts);

    // Complete progress bar and show final summary
    if (SIMPLE_LOGGING && progressBar) {
        try {
            if (!progressBar.isCompleted) {
                progressBar.update(totalSubreddits, {
                    current: totalSubreddits,
                    subredditCount: totalSubreddits,
                    statusMessage: '🎉 All subreddits completed!'
                });
                progressBar.stop();
            }
            console.log('\n');
        } catch (e) {
            // Handle any progress bar completion errors
            console.log('\n');
        }
    }

    const totalPosts = allPosts.length;
    const imageFiles = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];

    if (SIMPLE_LOGGING) {
        console.log("🎉 Newsletter Generation Complete!\n");
        console.log("═══════════════════════════════════════════\n");

        // Concise summary
        const underperformingSubs = Array.from(stats.subredditDetails.entries())
            .filter(([name, details]) => !details.metTarget);
        const successfulSubs = completedSubreddits.length - underperformingSubs.length;
        const totalSkipped = stats.imagePostsSkipped + stats.galleryPostsSkipped + stats.videoPostsSkipped + stats.autoModPostsSkipped;

        console.log(`📊 Quick Summary:`);
        console.log(`   • Total posts: ${totalPosts}`);
        console.log(`   • Successful subreddits: ${successfulSubs}/${completedSubreddits.length}`);

        if (underperformingSubs.length > 0) {
            console.log(`   • Underperforming: ${underperformingSubs.length} subreddits`);
        }

        if (totalSkipped > 0) {
            console.log(`   • Content filtered: ${totalSkipped} posts`);
        }

        if (config.reddit.downloadImages && imageFiles.length > 0) {
            console.log(`   • Images: ${imageFiles.length} downloaded`);
        }

        if (stats.errors.length > 0) {
            console.log(`   • Warnings: ${stats.errors.length}`);
        }

        console.log(`\n💡 For detailed breakdown: node index.js --stats`);

        // Store detailed stats for --stats command
        const detailedStats = {
            underperformingSubs,
            totalPosts,
            completedSubreddits,
            stats,
            imageFiles: imageFiles.length,
            config: {
                enableOAuth2: config.reddit.enableOAuth2,
                downloadImages: config.reddit.downloadImages
            }
        };

        // Write stats to temp file for --stats command
        try {
            fs.writeFileSync('.reddit-stats.json', JSON.stringify(detailedStats, null, 2));
        } catch (e) {
            // Ignore write errors
        }

        console.log('\n📖 Ready to send to Kindle!');
        console.log('═══════════════════════════════════════════\n');

    } else {
        console.log("\n/============================================\\");
        console.log("|               PROCESS COMPLETE               |");
        console.log("\\============================================/\n");
    }

    if (totalPosts > 0) {
        log('summary', `Generated EPUB with ${totalPosts} total posts.`);
        log('summary', `Breakdown by subreddit:`);
        subredditsWithPosts.forEach(sub => { log('summary', `  - r/${sub.name}: ${sub.posts.length} posts`); });
        if (config.reddit.downloadImages) {
            log('summary', `Successfully downloaded and embedded ${imageFiles.length} images.`);
        }
        const hasIssues = Object.values(stats).some(value => value > 0);
        if (hasIssues) {
            log('summary', `--------------------------------------------------`);
            log('summary', `Issues & Skipped Items Report:`);
            if (stats.videoPostsSkipped > 0) log('summary', `  - Skipped ${stats.videoPostsSkipped} video posts.`);
            if (stats.imagePostsSkipped > 0) log('summary', `  - Skipped ${stats.imagePostsSkipped} image posts.`);
            if (stats.galleryPostsSkipped > 0) log('summary', `  - Skipped ${stats.galleryPostsSkipped} gallery posts.`);
            if (stats.unfetchableArticlesSkipped > 0) log('summary', `  - Skipped ${stats.unfetchableArticlesSkipped} unfetchable articles.`);
            if (stats.internalLinksSkipped > 0) log('summary', `  - Skipped ${stats.internalLinksSkipped} internal Reddit links.`);
            if (stats.mercuryFailures > 0) log('summary', `  - Failed to parse ${stats.mercuryFailures} external articles.`);
            if (stats.imagesFailedToDownload > 0) log('summary', `  - Failed to download ${stats.imagesFailedToDownload} images.`);
            if (stats.largeImagesSkipped > 0) log('summary', `  - Skipped ${stats.largeImagesSkipped} images due to size limit.`);
            if (stats.imagesOptimized > 0) {
                const savedMB = (stats.totalSizeSaved / 1024 / 1024).toFixed(1);
                log('summary', `  - Optimized ${stats.imagesOptimized} large images, saved ${savedMB}MB total.`);
            }
            if (stats.retriesPerformed > 0) log('summary', `  - Performed ${stats.retriesPerformed} retries for failed requests.`);
            if (stats.rateLimitHits > 0) log('summary', `  - Hit rate limits ${stats.rateLimitHits} times (handled automatically).`);
        }
    } else {
        log('summary', `No valid posts were found to generate an EPUB.`);
    }
    console.log("\n");
}

// Command line help system
// args already declared above

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Reddit to Kindle Newsletter Generator v${SCRIPT_VERSION}

Usage:
  npm start              Generate and send newsletter to Kindle
  npm run setup          Run interactive setup wizard
  npm run reconfigure    Modify existing configuration
  node index.js --config Show current configuration
  node index.js --help   Show this help message

Options:
  --config               Display current configuration settings
  --stats                Show detailed statistics from last run
  --verbose, -v          Enable detailed verbose logging
  --help, -h             Show this help message

Examples:
  npm start                    # Generate newsletter with current settings
  npm run setup               # First-time setup or reconfiguration
  node index.js --config     # View current settings

For setup and configuration, use the interactive wizard:
  npm run setup

For more information, see: https://github.com/jstriblet/reddit-to-kindle
`);
    process.exit(0);
}

// Display current configuration
if (args.includes('--config')) {
    console.log('\nCurrent Configuration:');
    console.log('=====================\n');

    // Display subreddits
    console.log('📚 Subreddits:', config.reddit.subreddits.length);
    config.reddit.subreddits.forEach((sub, i) => {
        if (typeof sub === 'string') {
            console.log(`  ${i + 1}. r/${sub}`);
        } else {
            console.log(`  ${i + 1}. r/${sub.name} (custom settings)`);
        }
    });

    // Display defaults
    console.log('\n⚙️ Default Settings:');
    console.log(`  Posts per subreddit: ${config.reddit.defaults.postsPerSubreddit}`);
    console.log(`  Comments per post: ${config.reddit.defaults.commentsPerPost}`);
    console.log(`  Sorting: ${config.reddit.defaults.sort}`);
    console.log(`  Time period: ${config.reddit.defaults.timeframe}`);
    console.log(`  Image downloads: ${config.reddit.downloadImages ? 'Enabled' : 'Disabled'}`);
    console.log(`  OAuth2: ${config.reddit.enableOAuth2 ? 'Enabled' : 'Disabled'}`);

    // Display EPUB settings
    console.log('\n📖 EPUB Settings:');
    console.log(`  Title: ${epubConfig.title}`);
    console.log(`  Simplified TOC: ${epubConfig.simplifiedTOC ? 'Enabled' : 'Disabled'}`);
    console.log(`  Dated Cover: ${epubConfig.generateDatedCover ? 'Enabled' : 'Disabled'}`);
    console.log(`  Language: ${epubConfig.language}`);

    console.log('\nTo modify these settings, run: npm run setup\n');
    process.exit(0);
}

// Display detailed statistics from last run
if (args.includes('--stats')) {
    try {
        const statsData = JSON.parse(fs.readFileSync('.reddit-stats.json', 'utf8'));

        console.log('\n📊 Detailed Newsletter Statistics');
        console.log('════════════════════════════════════════\n');

        // Overview
        console.log(`📈 Overview:`);
        console.log(`   • Total posts: ${statsData.totalPosts}`);
        console.log(`   • Subreddits: ${statsData.completedSubreddits.length}`);
        console.log(`   • Images downloaded: ${statsData.imageFiles}`);
        console.log(`   • OAuth2: ${statsData.config.enableOAuth2 ? 'Enabled' : 'Disabled'}`);

        // Underperforming subreddits
        if (statsData.underperformingSubs.length > 0) {
            console.log(`\n⚠️  Underperforming Subreddits (${statsData.underperformingSubs.length}):`);
            statsData.underperformingSubs.forEach(([name, details]) => {
                const deficit = details.target - details.found;
                console.log(`\n   r/${name}: ${details.found}/${details.target} posts (-${deficit})`);

                // Show filtering details
                const reasons = [];
                if (details.imagePostsSkipped > 0) reasons.push(`${details.imagePostsSkipped} image`);
                if (details.galleryPostsSkipped > 0) reasons.push(`${details.galleryPostsSkipped} gallery`);
                if (details.videoPostsSkipped > 0) reasons.push(`${details.videoPostsSkipped} video`);
                if (details.autoModPostsSkipped > 0) reasons.push(`${details.autoModPostsSkipped} AutoMod`);
                if (details.internalLinksSkipped > 0) reasons.push(`${details.internalLinksSkipped} internal`);

                if (reasons.length > 0) {
                    console.log(`   📋 Skipped: ${reasons.join(', ')} posts`);
                }

                if (details.fallbackImagePostsIncluded > 0) {
                    console.log(`   🖼️  Fallback images: ${details.fallbackImagePostsIncluded} included`);
                }

                console.log(`   📡 Source: ${details.sourceMethod} (${details.totalEntriesAvailable} available)`);
            });
        }

        // Global filtering stats
        const totalFiltered = statsData.stats.imagePostsSkipped + statsData.stats.galleryPostsSkipped +
            statsData.stats.videoPostsSkipped + statsData.stats.autoModPostsSkipped +
            statsData.stats.internalLinksSkipped;

        if (totalFiltered > 0) {
            console.log(`\n🔍 Global Content Filtering:`);
            console.log(`   • Total filtered: ${totalFiltered} posts`);
            if (statsData.stats.imagePostsSkipped > 0) console.log(`     - Image posts: ${statsData.stats.imagePostsSkipped}`);
            if (statsData.stats.galleryPostsSkipped > 0) console.log(`     - Gallery posts: ${statsData.stats.galleryPostsSkipped}`);
            if (statsData.stats.videoPostsSkipped > 0) console.log(`     - Video posts: ${statsData.stats.videoPostsSkipped}`);
            if (statsData.stats.autoModPostsSkipped > 0) console.log(`     - AutoModerator: ${statsData.stats.autoModPostsSkipped}`);
            if (statsData.stats.internalLinksSkipped > 0) console.log(`     - Internal links: ${statsData.stats.internalLinksSkipped}`);
            if (statsData.stats.fallbackImagePostsIncluded > 0) console.log(`   • Fallback images used: ${statsData.stats.fallbackImagePostsIncluded}`);
        }

        // Top performing subreddits
        const topPerformers = statsData.completedSubreddits
            .filter(sub => sub.details?.metTarget)
            .sort((a, b) => b.posts - a.posts)
            .slice(0, 10);

        if (topPerformers.length > 0) {
            console.log(`\n🏆 Top Performing Subreddits:`);
            topPerformers.forEach((sub, i) => {
                console.log(`   ${i + 1}. r/${sub.name}: ${sub.posts} posts`);
            });
        }

        if (statsData.stats.errors.length > 0) {
            console.log(`\n⚠️  Warnings (${statsData.stats.errors.length}):`);
            statsData.stats.errors.slice(0, 5).forEach((error, i) => {
                console.log(`   ${i + 1}. ${error}`);
            });
            if (statsData.stats.errors.length > 5) {
                console.log(`   ... and ${statsData.stats.errors.length - 5} more`);
            }
        }

        console.log('\n════════════════════════════════════════\n');

    } catch (e) {
        console.log('❌ No statistics available. Run the newsletter generator first.\n');
        console.log('Usage: node index.js (to generate newsletter)\n');
    }
    process.exit(0);
}

main().catch(err => {
    log('FATAL', `An unhandled error occurred: ${err.stack}`);
    process.exit(1);
});