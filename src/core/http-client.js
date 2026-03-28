const https = require('https');
const http = require('http');
const { URL } = require('url');
const { logger } = require('./logger');

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

/**
 * HTTP client with cookie support, redirect following, and retry logic.
 * Shared across all sources to avoid duplicating HTTP logic.
 */
class HttpClient {
    constructor(options = {}) {
        this.cookies = {};
        this.defaultHeaders = { ...DEFAULT_HEADERS, ...options.headers };
        this.timeout = options.timeout || 15000;
        this.maxRedirects = options.maxRedirects || 5;
        this.csrfToken = null;
    }

    /**
     * Make an HTTP request
     */
    async request(url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const maxRedirects = options.maxRedirects ?? this.maxRedirects;
        let currentUrl = url;
        let redirectCount = 0;

        while (redirectCount <= maxRedirects) {
            const result = await this._doRequest(currentUrl, {
                ...options,
                method: redirectCount > 0 ? 'GET' : method,
            });

            // Store cookies from response
            this._parseCookies(result.headers, currentUrl);

            // Follow redirects
            if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
                currentUrl = new URL(result.headers.location, currentUrl).href;
                redirectCount++;
                continue;
            }

            result.url = currentUrl;
            return result;
        }

        throw new Error(`Too many redirects (${maxRedirects})`);
    }

    async get(url, options = {}) {
        return this.request(url, { ...options, method: 'GET' });
    }

    async post(url, body, options = {}) {
        const headers = { ...options.headers };
        let bodyStr;

        if (typeof body === 'object' && !(body instanceof Buffer)) {
            bodyStr = JSON.stringify(body);
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        } else if (typeof body === 'string') {
            bodyStr = body;
            headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        }

        if (bodyStr) {
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        return this.request(url, { ...options, method: 'POST', body: bodyStr, headers });
    }

    /**
     * Get parsed JSON response
     */
    async getJSON(url, options = {}) {
        const res = await this.get(url, {
            ...options,
            headers: { ...options.headers, Accept: 'application/json' },
        });
        try {
            return { ...res, data: JSON.parse(res.body) };
        } catch {
            throw new Error(`Invalid JSON from ${url}: ${res.body.substring(0, 100)}`);
        }
    }

    async postJSON(url, body, options = {}) {
        const res = await this.post(url, body, {
            ...options,
            headers: { ...options.headers, Accept: 'application/json' },
        });
        try {
            return { ...res, data: JSON.parse(res.body) };
        } catch {
            throw new Error(`Invalid JSON from ${url}: ${res.body.substring(0, 100)}`);
        }
    }

    /**
     * Internal request implementation
     */
    _doRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;

            const headers = {
                ...this.defaultHeaders,
                ...options.headers,
                Cookie: this._getCookieString(url),
            };

            // Add CSRF token if available
            if (this.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method)) {
                headers['X-CSRF-TOKEN'] = this.csrfToken;
                headers['X-Requested-With'] = 'XMLHttpRequest';
            }

            const reqOptions = {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname + parsed.search,
                method: options.method || 'GET',
                headers,
            };

            const req = lib.request(reqOptions, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body,
                    });
                });
            });

            req.on('error', reject);
            req.setTimeout(options.timeout || this.timeout, () => {
                req.destroy();
                reject(new Error(`Request timeout: ${url}`));
            });

            if (options.body) {
                req.write(options.body);
            }

            req.end();
        });
    }

    /**
     * Parse Set-Cookie headers and store them
     */
    _parseCookies(headers, url) {
        const setCookies = headers['set-cookie'];
        if (!setCookies) return;

        const cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
        const domain = new URL(url).hostname;

        for (const cookieStr of cookieArr) {
            const parts = cookieStr.split(';')[0].split('=');
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            if (name) {
                if (!this.cookies[domain]) this.cookies[domain] = {};
                this.cookies[domain][name] = value;
            }
        }
    }

    /**
     * Build cookie string for a request URL
     */
    _getCookieString(url) {
        const domain = new URL(url).hostname;
        const cookies = [];

        for (const [cookieDomain, domainCookies] of Object.entries(this.cookies)) {
            if (domain === cookieDomain || domain.endsWith('.' + cookieDomain)) {
                for (const [name, value] of Object.entries(domainCookies)) {
                    cookies.push(`${name}=${value}`);
                }
            }
        }

        return cookies.join('; ');
    }

    /**
     * Extract CSRF token from HTML page
     */
    extractCsrfToken(html) {
        const match = html.match(/meta\s+name="csrf-token"\s+content="([^"]+)"/);
        if (match) {
            this.csrfToken = match[1];
        }
        return this.csrfToken;
    }

    /**
     * Set cookies manually (e.g., from config)
     */
    setCookies(domain, cookies) {
        this.cookies[domain] = { ...this.cookies[domain], ...cookies };
    }

    /**
     * Get all cookies for a domain
     */
    getAllCookies(domain) {
        return this.cookies[domain] || null;
    }

    /**
     * Clear all cookies
     */
    clearCookies() {
        this.cookies = {};
        this.csrfToken = null;
    }
}

module.exports = { HttpClient };
