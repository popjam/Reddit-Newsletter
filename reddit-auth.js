import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultConfig } from './config.js'; // Import the base default config

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Check for verbose logging
const VERBOSE_LOGGING = process.argv.includes('--verbose') || process.argv.includes('-v');
const authLog = (message) => {
    if (VERBOSE_LOGGING) {
        console.log(message);
    }
};

// --- UNIFIED CONFIGURATION LOADER (Copied from index.js) ---
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
        } catch (e) {
            authLog(`⚠️  [AUTH] Could not parse user-config.json, using default settings. Error: ${e.message}`);
        }
    } else {
        authLog('⚠️  [AUTH] user-config.json not found. Authentication might fail.');
    }
    return finalConfig;
}

// Load the final, merged configuration
const config = loadConfig();
const redditConfig = config.reddit; // Get the specific reddit part of the config

/**
 * Reddit OAuth2 Authentication Module
 * Handles Reddit API authentication using client credentials flow
 */
class RedditAuth {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.isAuthenticating = false;
        this.oauthBlocked = false; // Track if OAuth API calls are being blocked
        this.blockCheckDone = false; // Track if we've done the initial block check
        // Use the loaded and merged config
        this.config = redditConfig.oauth2;
    }

    /**
     * Get a valid access token, refreshing if necessary
     */
    async getAccessToken() {
        if (!redditConfig.enableOAuth2) {
            throw new Error('Reddit OAuth2 is disabled. Enable it in your config to use authenticated API calls.');
        }

        // Return existing token if still valid
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        // Prevent concurrent authentication requests
        if (this.isAuthenticating) {
            await this.waitForAuthentication();
            return this.accessToken;
        }

        return await this.authenticate();
    }

    /**
     * Authenticate with Reddit API using client credentials
     */
    async authenticate() {
        this.isAuthenticating = true;

        try {
            authLog('[AUTH] Authenticating with Reddit API...');

            // Prepare authentication request
            const authData = new URLSearchParams({
                grant_type: 'password',
                username: this.config.username,
                password: this.config.password
            });

            // Create basic auth header with client credentials
            const clientAuth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

            const response = await axios.post('https://www.reddit.com/api/v1/access_token', authData, {
                headers: {
                    'Authorization': `Basic ${clientAuth}`,
                    'User-Agent': this.config.userAgent,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 15000
            });

            const { access_token, expires_in } = response.data;

            if (!access_token) {
                throw new Error('No access token received from Reddit API');
            }

            // Store token and calculate expiry (with 5 minute buffer)
            this.accessToken = access_token;
            this.tokenExpiry = Date.now() + ((expires_in - 300) * 1000);

            authLog('[AUTH] Successfully authenticated with Reddit API');
            authLog(`[AUTH] Token expires in ${Math.floor(expires_in / 60)} minutes`);

            return this.accessToken;

        } catch (error) {
            this.accessToken = null;
            this.tokenExpiry = null;

            if (error.response) {
                const status = error.response.status;
                const message = error.response.data?.error || error.response.statusText;
                throw new Error(`Reddit authentication failed (${status}): ${message}`);
            } else if (error.code === 'ECONNABORTED') {
                throw new Error('Reddit authentication timed out');
            } else {
                throw new Error(`Reddit authentication error: ${error.message}`);
            }
        } finally {
            this.isAuthenticating = false;
        }
    }

    /**
     * Wait for ongoing authentication to complete
     */
    async waitForAuthentication() {
        while (this.isAuthenticating) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    /**
     * Create an authenticated axios instance for Reddit API calls
     */
    async createAuthenticatedClient() {
        const token = await this.getAccessToken();

        return axios.create({
            baseURL: 'https://oauth.reddit.com',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': this.config.userAgent
            },
            timeout: redditConfig.timeouts.redditApi
        });
    }

    /**
     * Check if OAuth API calls are working
     */
    async checkOAuthWorking() {
        if (this.blockCheckDone) {
            return !this.oauthBlocked;
        }

        try {
            authLog('[AUTH] Testing if OAuth API calls are working...');
            const client = await this.createAuthenticatedClient();
            
            // Try a simple API call to test if OAuth is working
            await client.get('/api/v1/me', { timeout: 10000 });
            
            authLog('[AUTH] ✅ OAuth API calls are working');
            this.oauthBlocked = false;
            this.blockCheckDone = true;
            return true;
        } catch (error) {
            if (error.response?.status === 403) {
                authLog('[AUTH] ⚠️  OAuth API calls are being blocked by Reddit. Disabling OAuth for this session.');
                this.oauthBlocked = true;
            } else if (error.response?.status === 401) {
                authLog('[AUTH] ⚠️  OAuth authentication failed. Check credentials.');
                this.oauthBlocked = true;
            } else {
                // For other errors (network, timeout, etc.), don't permanently block OAuth
                authLog('[AUTH] ⚠️  OAuth test failed temporarily:', error.message);
                authLog('[AUTH] Will still attempt OAuth for actual requests.');
                this.oauthBlocked = false; // Don't block for temporary issues
            }
            this.blockCheckDone = true;
            return !this.oauthBlocked;
        }
    }

    /**
     * Check if OAuth2 is enabled and properly configured
     */
    isConfigured() {
        if (!redditConfig.enableOAuth2 || this.oauthBlocked) {
            return false;
        }

        // Check for placeholder values from the default config
        const defaults = defaultConfig.reddit.oauth2;
        const required = ['clientId', 'clientSecret', 'userAgent', 'username', 'password'];

        return required.every(field => {
            const value = this.config[field];
            const defaultValue = defaults[field];
            // Check if value exists, is not the placeholder, and doesn't start with a placeholder prefix
            return value && value !== defaultValue && !value.toLowerCase().startsWith('your_');
        });
    }

    /**
     * Get configuration status for debugging
     */
    getStatus() {
        return {
            enabled: redditConfig.enableOAuth2,
            configured: this.isConfigured(),
            hasToken: !!this.accessToken,
            tokenExpiry: this.tokenExpiry ? new Date(this.tokenExpiry).toISOString() : null,
            isAuthenticating: this.isAuthenticating
        };
    }
}

// Export a singleton instance
export const redditAuth = new RedditAuth();

/**
 * Convert Reddit URLs to OAuth API endpoints.
 * This function should only be here and not duplicated in index.js.
 */
function convertToOAuthUrlForAuth(url) {
    // This is a simplified version for the auth client's use case
    return url.replace(/^(https:\/\/)?(www\.)?reddit\.com/, 'https://oauth.reddit.com');
}

/**
 * Helper function to make authenticated Reddit API requests
 */
export async function makeAuthenticatedRedditRequest(url, options = {}) {
    if (!redditConfig.enableOAuth2 || !redditAuth.isConfigured()) {
        // Fall back to unauthenticated request
        authLog('⚠️  [AUTH] OAuth2 not enabled or configured, using unauthenticated request.');
        return axios.get(url, {
            timeout: options.timeout || redditConfig.timeouts.redditApi,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            ...options
        });
    }

    try {
        const token = await redditAuth.getAccessToken();
        
        // Create axios request with custom timeout if provided
        const requestConfig = {
            baseURL: 'https://oauth.reddit.com',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': redditAuth.config.userAgent
            },
            timeout: options.timeout || redditConfig.timeouts.redditApi,
            ...options
        };

        // The base URL is already set to oauth.reddit.com, so we need the path part
        const requestPath = new URL(url).pathname + new URL(url).search;

        return await axios.get(requestPath, requestConfig);
    } catch (error) {
        authLog('⚠️  [AUTH] Authenticated request failed, falling back to unauthenticated request.');
        authLog(`[AUTH] Error: ${error.message}`);
        
        // Fall back to unauthenticated request
        return axios.get(url, {
            timeout: options.timeout || redditConfig.timeouts.redditApi,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            ...options
        });
    }
}