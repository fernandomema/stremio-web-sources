const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { URL } = require('url');
const { logger } = require('../../core/logger');

// Enable stealth plugin to avoid Cloudflare detection
chromium.use(StealthPlugin());

/**
 * Handles authentication with series.ly.
 * Uses Playwright with stealth for login (Cloudflare Turnstile requires a browser).
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
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--window-size=1280,720',
                ],
            });
            this._context = await this._browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'es-ES',
                timezoneId: 'Europe/Madrid',
            });
            // Stealth plugin handles webdriver flag automatically
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
     * Wait for Turnstile to complete with multiple strategies
     */
    async _waitForTurnstile(page, timeout = 30000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            // Check if button is enabled
            const buttonEnabled = await page.evaluate(() => {
                const btn = document.getElementById('submit-btn');
                return btn && !btn.disabled;
            });
            
            if (buttonEnabled) {
                logger.info('Series.ly: Turnstile solved - button enabled');
                return true;
            }
            
            // Try to find and interact with Turnstile iframe
            try {
                const frames = page.frames();
                for (const frame of frames) {
                    if (frame.url().includes('turnstile') || frame.url().includes('challenges.cloudflare.com')) {
                        const checkbox = await frame.$('input[type="checkbox"]');
                        if (checkbox) {
                            const isVisible = await checkbox.isVisible();
                            if (isVisible) {
                                logger.info('Series.ly: Found Turnstile checkbox, clicking...');
                                await checkbox.click().catch(() => {});
                                await page.waitForTimeout(2000);
                            }
                        }
                    }
                }
            } catch {
                // Frames not accessible, continue waiting
            }
            
            // Log progress every 15 seconds
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            if (elapsed % 15 === 0 && elapsed > 0) {
                logger.info(`Series.ly: waiting for Turnstile... (${elapsed}s elapsed)`);
            }
            
            await page.waitForTimeout(1000);
        }
        
        return false;
    }

    /**
     * Login using Playwright to handle Cloudflare Turnstile.
     * Keeps browser alive for subsequent link resolution.
     */
    async login(email, password) {
        try {
            logger.info('Series.ly: launching browser for login (with stealth)...');
            const { context } = await this._ensureBrowser();
            const page = await context.newPage();

            await page.goto(`${this.baseUrl}/ingresar`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // Wait for form to be ready
            await page.waitForSelector('input[name="email"]', { timeout: 10000 });
            
            // Type more human-like with small delays
            await page.fill('input[name="email"]', email);
            await page.waitForTimeout(300);
            await page.fill('input[name="password"]', password);
            await page.waitForTimeout(300);

            logger.info('Series.ly: credentials filled, waiting for Turnstile...');
            
            // Wait for Turnstile with stealth plugin
            const turnstileResolved = await this._waitForTurnstile(page, 30000);
            
            if (!turnstileResolved) {
                logger.error('Series.ly: Turnstile timeout - could not resolve challenge');
                await page.close();
                return false;
            }

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
