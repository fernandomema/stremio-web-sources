const { chromium } = require('playwright');
const { URL } = require('url');
const { logger } = require('../../core/logger');

/**
 * Handles authentication with series.ly.
 * Uses Playwright for login (Cloudflare Turnstile requires a browser).
 * Keeps a persistent browser context alive for Turnstile-protected link resolution.
 */
class SerieslyAuth {
    constructor(http, baseUrl) {
        this.http = http;
        this.baseUrl = baseUrl;
        this._loggedIn = false;
        this._sessionExpiry = 0;
        this._browser = null;
        this._context = null;
    }

    isLoggedIn() {
        if (this._sessionExpiry && Date.now() > this._sessionExpiry) {
            this._loggedIn = false;
        }
        return this._loggedIn;
    }

    async _ensureBrowser() {
        if (!this._browser || !this._browser.isConnected()) {
            this._browser = await chromium.launch({
                headless: false,
                args: ['--disable-blink-features=AutomationControlled'],
            });
            this._context = await this._browser.newContext();
        }
        return { browser: this._browser, context: this._context };
    }

    async closeBrowser() {
        if (this._browser) {
            await this._browser.close().catch(() => {});
            this._browser = null;
            this._context = null;
        }
    }

    /**
     * Login using Playwright to handle Cloudflare Turnstile.
     * Keeps browser alive for subsequent link resolution.
     */
    async login(email, password) {
        try {
            logger.info('Series.ly: launching browser for login...');
            const { context } = await this._ensureBrowser();
            const page = await context.newPage();

            await page.goto(`${this.baseUrl}/ingresar`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);

            logger.info('Series.ly: waiting for Turnstile...');
            await page.waitForFunction(() => {
                const btn = document.getElementById('submit-btn');
                return btn && !btn.disabled;
            }, { timeout: 30000 });

            await page.click('#submit-btn');
            await page.waitForURL((url) => !url.pathname.includes('/ingresar'), { timeout: 15000 });

            logger.info('Series.ly: login successful, extracting cookies...');

            // Extract cookies to HttpClient
            await this._syncCookiesToHttp();

            // Get CSRF token
            const html = await page.content();
            this.http.extractCsrfToken(html);

            await page.close();

            this._loggedIn = true;
            this._sessionExpiry = Date.now() + (3600000 * 12);

            logger.info('Series.ly: session active (browser kept alive)');
            return true;
        } catch (err) {
            logger.error('Series.ly login error:', err.message);
            await this.closeBrowser();
            return false;
        }
    }

    /**
     * Refresh CSRF token by fetching any authenticated page
     */
    async _refreshCsrf() {
        try {
            const res = await this.http.get(`${this.baseUrl}/`, { maxRedirects: 3 });
            this.http.extractCsrfToken(res.body);
        } catch {
            // Non-critical
        }
    }

    /**
     * Resolve video links using the persistent browser context.
     * Opens the detail page, waits for Turnstile auto-solve,
     * then uses fetch() in the page context to resolve /t/TOKEN URLs.
     */
    async resolveLinksViaBrowser(detailUrl, links, maxLinks = 10) {
        try {
            const count = Math.min(links.length, maxLinks);
            logger.info(`Series.ly: resolving ${count} links via browser...`);

            const { context } = await this._ensureBrowser();
            const page = await context.newPage();

            logger.info(`Series.ly: navigating to ${detailUrl}...`);
            await page.goto(detailUrl, { waitUntil: 'load', timeout: 60000 });
            logger.info('Series.ly: page loaded, waiting for Turnstile...');
            await page.waitForTimeout(5000);

            // Resolve all links via fetch() in page context (shares Turnstile state)
            const linksToResolve = links.slice(0, count).map(l => ({
                linkId: l.linkId,
                url: l.url,
            }));

            const resolved = await page.evaluate(async (linksData) => {
                const results = [];
                for (const link of linksData) {
                    try {
                        const res = await fetch(link.url, { credentials: 'same-origin' });
                        const text = await res.text();
                        if (text.includes('"e"')) {
                            const data = JSON.parse(text);
                            if (data.e) {
                                const m = data.e.match(/src=["']?([^"'\s>]+)/);
                                if (m) {
                                    results.push({ linkId: link.linkId, embedUrl: m[1] });
                                }
                            }
                        }
                    } catch {}
                }
                return results;
            }, linksToResolve);

            // Sync cookies back to HTTP client
            await this._syncCookiesToHttp();
            await page.close();

            logger.info(`Series.ly: resolved ${resolved.length}/${count} links via browser`);
            return resolved;
        } catch (err) {
            logger.error('Series.ly link browser error:', err.message);
            return [];
        }
    }

    async _syncCookiesToHttp() {
        if (!this._context) return;
        const domain = new URL(this.baseUrl).hostname;
        const cookies = await this._context.cookies();
        for (const cookie of cookies) {
            if (domain === cookie.domain || domain.endsWith(cookie.domain.replace(/^\./, ''))) {
                this.http.setCookies(domain, { [cookie.name]: cookie.value });
            }
        }
    }
}

module.exports = { SerieslyAuth };
