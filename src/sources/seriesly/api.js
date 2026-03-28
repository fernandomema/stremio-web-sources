const { logger } = require('../../core/logger');

/**
 * API client for series.ly endpoints.
 * All endpoints require authentication (session cookies + CSRF token).
 */
class SerieslyApi {
    constructor(http, baseUrl, cache) {
        this.http = http;
        this.baseUrl = baseUrl;
        this.cache = cache;
    }

    /**
     * Common headers for API requests
     */
    _apiHeaders() {
        const csrfToken = this.http.csrfToken;
        return {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-TOKEN': csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': this.baseUrl,
            'Origin': this.baseUrl,
        };
    }

    /**
     * Search posts (movies, series, anime)
     * POST /api/search/posts
     * Body: { query: string, page: number }
     * Returns: { people: [], posts: [], pagination: {} }
     */
    async search(query, page = 1) {
        const cacheKey = `search:${query}:${page}`;
        return this.cache.getOrSet(cacheKey, async () => {
            const res = await this.http.postJSON(`${this.baseUrl}/api/search/posts`, {
                query,
                page,
            }, { headers: this._apiHeaders() });

            return res.data;
        }, 300000); // Cache 5 min
    }

    /**
     * Get posts listing with filters
     * POST /api/posts/list
     * Body: { type, page, showUpdates, l, q, g, n, r, fy, ty }
     */
    async getPostsList(type = 'movie', page = 1, filters = {}) {
        const body = {
            type,
            page,
            showUpdates: '0',
            l: filters.l || [],   // languages
            q: filters.q || [],   // qualities
            g: filters.g || [],   // genres
            n: filters.n || [],   // networks
            r: filters.r || [],   // ratings
        };
        if (filters.fy) body.fy = filters.fy;
        if (filters.ty) body.ty = filters.ty;

        const cacheKey = `list:${type}:${page}:${JSON.stringify(filters)}`;
        return this.cache.getOrSet(cacheKey, async () => {
            const res = await this.http.postJSON(`${this.baseUrl}/api/posts/list`, body, {
                headers: this._apiHeaders(),
            });
            return res.data;
        }, 300000); // Cache 5 min
    }

    /**
     * Get home page posts in batch
     * POST /api/home/posts/batch
     * Body: { types: [], filterBy, genres, networks, customHome }
     */
    async getHomePosts(types = ['movie', 'serie', 'anime'], filterBy = '', genres = [], networks = []) {
        const body = {
            types,
            filterBy,
            genres,
            networks,
            customHome: false,
        };

        const cacheKey = `home:${types.join(',')}:${filterBy}`;
        return this.cache.getOrSet(cacheKey, async () => {
            const res = await this.http.postJSON(`${this.baseUrl}/api/home/posts/batch`, body, {
                headers: this._apiHeaders(),
            });
            return res.data;
        }, 600000); // Cache 10 min
    }

    /**
     * Get available filters (genres, languages, qualities, networks)
     * POST /api/posts/filters
     * Body: { type }
     */
    async getFilters(type = 'movie') {
        const cacheKey = `filters:${type}`;
        return this.cache.getOrSet(cacheKey, async () => {
            const res = await this.http.postJSON(`${this.baseUrl}/api/posts/filters`, {
                type,
            }, { headers: this._apiHeaders() });
            return res.data;
        }, 3600000); // Cache 1h
    }

    /**
     * Get the HTML of a post detail page (movie/series page with links)
     * The post detail pages use Livewire to render links table server-side
     */
    async getPostPage(slug, type, season = null, episode = null) {
        // Build URL path: /peliculas/slug or /series/slug or /series/slug/SxE
        const typePath = type === 'movie' ? 'peliculas' : 'series';
        let path = `/${typePath}/${slug}`;

        if (season != null && episode != null) {
            path += `/${season}x${episode}`;
        }

        const cacheKey = `page:${path}`;
        return this.cache.getOrSet(cacheKey, async () => {
            const res = await this.http.get(`${this.baseUrl}${path}`, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml',
                    'Referer': this.baseUrl,
                },
            });

            if (res.status !== 200) {
                throw new Error(`Post page ${path} returned ${res.status}`);
            }

            // Refresh CSRF from page
            this.http.extractCsrfToken(res.body);

            return res.body;
        }, 600000); // Cache 10 min
    }

    /**
     * Resolve a video link URL to get the actual embed/stream URL.
     * The /t/TOKEN URLs redirect to the actual streaming embed (e.g., streamwish, filemoon).
     * May require Turnstile captcha verification first.
     */
    async resolveLink(linkUrl, linkId) {
        try {
            // First, try to follow the /t/TOKEN URL directly (may work for authenticated users)
            const fullUrl = linkUrl.startsWith('http') ? linkUrl : `${this.baseUrl}${linkUrl}`;
            const res = await this.http.get(fullUrl, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer': this.baseUrl,
                },
                maxRedirects: 10,
            });

            if (res.status !== 200) {
                logger.debug(`Link resolve returned ${res.status} for ${linkId || linkUrl}`);
                return null;
            }

            // Check if response is JSON with embed data: {"e":"<iframe src=\"...\">"}
            if (res.body.startsWith('{') && res.body.includes('"e"')) {
                try {
                    const data = JSON.parse(res.body);
                    if (data.e) {
                        const srcMatch = data.e.match(/src=["']?([^"'\s>]+)/);
                        if (srcMatch) {
                            return { embedUrl: srcMatch[1].replace(/\\\//g, '/') };
                        }
                    }
                    if (data.captcha_required) {
                        return { captchaRequired: true, linkUrl: fullUrl, linkId };
                    }
                } catch {}
            }

            // Check if the final URL (after redirects) is an external embed
            if (res.url && res.url !== fullUrl && !res.url.includes('enlace.ly') && !res.url.includes('series.ly')) {
                return { embedUrl: res.url };
            }

            // Parse the response HTML for an iframe embed src
            const iframeMatch = res.body.match(/<iframe[^>]+src=["']([^"']+)["']/i);
            if (iframeMatch) {
                return { embedUrl: iframeMatch[1] };
            }

            // Check if it's a captcha page (contains Turnstile)
            if (res.body.includes('turnstile') || res.body.includes('cf-turnstile') || res.body.includes('captcha')) {
                logger.debug(`Link ${linkId || linkUrl} requires captcha`);
                return { captchaRequired: true, linkUrl: fullUrl, linkId };
            }

            // Maybe it's a page with a direct video source
            const sourceMatch = res.body.match(/(?:file|source|src)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8|mkv)[^"']*?)["']/i);
            if (sourceMatch) {
                return { url: sourceMatch[1] };
            }

            // Return body for further analysis
            return { html: res.body };
        } catch (err) {
            logger.debug(`Link resolve error: ${err.message}`);
            return null;
        }
    }

    /**
     * Verify a link via Turnstile captcha and get the actual embed URL.
     * This uses the verifyUrl endpoint with a Turnstile token.
     */
    async verifyAndResolveLink(linkUrl, turnstileToken) {
        try {
            const res = await this.http.postJSON(`${this.baseUrl}/link-captcha/verify`, {
                token: turnstileToken,
                url: linkUrl,
            }, {
                headers: this._apiHeaders(),
            });

            if (res.data?.url) {
                return { embedUrl: res.data.url };
            }
            return res.data;
        } catch (err) {
            logger.debug(`Link captcha verify error: ${err.message}`);
            return null;
        }
    }

    /**
     * Get home collections
     * POST /api/home/collections
     */
    async getCollections(page = 1) {
        const cacheKey = `collections:${page}`;
        return this.cache.getOrSet(cacheKey, async () => {
            const res = await this.http.postJSON(`${this.baseUrl}/api/home/collections`, {
                page,
            }, { headers: this._apiHeaders() });
            return res.data;
        }, 600000);
    }
}

module.exports = { SerieslyApi };
