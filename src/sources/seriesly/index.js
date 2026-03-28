const crypto = require('crypto');
const { BaseSource } = require('../../core/base-source');
const { HttpClient } = require('../../core/http-client');
const { DomainResolver } = require('../../core/domain-resolver');
const { Cache } = require('../../core/cache');
const { logger } = require('../../core/logger');
const { SerieslyParser } = require('./parser');
const { SerieslyAuth } = require('./auth');
const { SerieslyApi } = require('./api');

const ID_PREFIX = 'sly:';
const SESSION_TTL = 3600000 * 12; // 12 hours
const MAX_SESSIONS = 50;

class SerieslySource extends BaseSource {
    constructor() {
        super({
            id: 'seriesly',
            name: 'Series.ly',
            description: 'Series, películas y anime de Series.ly',
            types: ['movie', 'series'],
            requiresAuth: true,
            idPrefixes: [ID_PREFIX],
            catalogs: [
                {
                    id: 'seriesly-movies',
                    type: 'movie',
                    name: 'Series.ly - Películas',
                    extra: [
                        { name: 'search', isRequired: false },
                        { name: 'genre', isRequired: false, options: [] },
                        { name: 'skip', isRequired: false },
                    ],
                },
                {
                    id: 'seriesly-series',
                    type: 'series',
                    name: 'Series.ly - Series',
                    extra: [
                        { name: 'search', isRequired: false },
                        { name: 'genre', isRequired: false, options: [] },
                        { name: 'skip', isRequired: false },
                    ],
                },
                {
                    id: 'seriesly-anime',
                    type: 'series',
                    name: 'Series.ly - Anime',
                    extra: [
                        { name: 'search', isRequired: false },
                        { name: 'genre', isRequired: false, options: [] },
                        { name: 'skip', isRequired: false },
                    ],
                },
            ],
        });

        this.resolver = new DomainResolver();
        this.cache = new Cache(1800000); // 30 min - shared cache for content
        this.parser = new SerieslyParser(ID_PREFIX);
        this.baseUrl = null;

        // Per-user session management: hash → { http, auth, api, lastUsed }
        this._sessions = new Map();
    }

    async init() {
        // Resolve proxy domain (shared, no auth needed)
        await this.resolver.init();
        this.baseUrl = this.resolver.getBaseUrl();

        if (!this.baseUrl) {
            throw new Error('Could not resolve series.ly domain');
        }

        logger.info(`Series.ly base URL: ${this.baseUrl}`);

        // Try to load filter options with a temporary unauthenticated request
        // (filters may work without auth, otherwise they'll load on first user session)
        await this._loadFilterOptions();
    }

    /**
     * Get or create an authenticated session for a user config.
     * Returns { http, auth, api } or null if no credentials.
     */
    async _getSession(userConfig) {
        const creds = userConfig?.seriesly;
        if (!creds?.email || !creds?.password) return null;

        const hash = crypto.createHash('sha256')
            .update(creds.email + ':' + creds.password)
            .digest('hex').slice(0, 16);

        let session = this._sessions.get(hash);

        // Return existing valid session
        if (session && session.auth.isLoggedIn()) {
            session.lastUsed = Date.now();
            return session;
        }

        // Evict oldest sessions if at capacity
        if (this._sessions.size >= MAX_SESSIONS) {
            this._evictOldestSession();
        }

        // Create new session with its own HttpClient (own cookies/csrf)
        const http = new HttpClient();
        const auth = new SerieslyAuth(http, this.baseUrl);
        const api = new SerieslyApi(http, this.baseUrl, this.cache);

        const success = await auth.login(creds.email, creds.password);
        if (!success) {
            logger.warn(`Series.ly: login failed for user ${hash}`);
            return null;
        }

        logger.info(`Series.ly: new session for user ${hash}`);
        session = { http, auth, api, lastUsed: Date.now() };
        this._sessions.set(hash, session);
        return session;
    }

    _evictOldestSession() {
        let oldest = null;
        let oldestTime = Infinity;
        for (const [hash, session] of this._sessions) {
            if (session.lastUsed < oldestTime) {
                oldestTime = session.lastUsed;
                oldest = hash;
            }
        }
        if (oldest) {
            this._sessions.delete(oldest);
            logger.debug(`Evicted session ${oldest}`);
        }
    }

    async getCatalog(type, catalogId, extra = {}, userConfig) {
        const session = await this._getSession(userConfig);
        if (!session) {
            logger.warn('Series.ly: no valid session, cannot fetch catalog');
            return [];
        }

        try {
            // Search mode
            if (extra.search) {
                const page = Math.floor((parseInt(extra.skip) || 0) / 24) + 1;
                const results = await session.api.search(extra.search, page);
                return this.parser.parseSearchResults(results, type);
            }

            // Determine the content type for API
            const apiType = this._catalogToApiType(catalogId);
            const page = Math.floor((parseInt(extra.skip) || 0) / 24) + 1;

            const filters = {};
            if (extra.genre) filters.g = [extra.genre];

            const results = await session.api.getPostsList(apiType, page, filters);
            return this.parser.parseCatalogResults(results, type);
        } catch (err) {
            logger.error(`Series.ly catalog error [${catalogId}]:`, err.message);
            return [];
        }
    }

    async getMeta(type, id, userConfig) {
        if (!id.startsWith(ID_PREFIX)) return null;
        const session = await this._getSession(userConfig);
        if (!session) return null;

        const slug = id.replace(ID_PREFIX, '');

        try {
            return await this.cache.getOrSet(`meta:${id}`, async () => {
                const html = await session.api.getPostPage(slug, type);
                return this.parser.parsePostDetail(html, id, type);
            }, 3600000); // Cache 1h
        } catch (err) {
            logger.error(`Series.ly meta error [${id}]:`, err.message);
            return null;
        }
    }

    async getStreams(type, id, userConfig) {
        if (!id.startsWith(ID_PREFIX)) return [];
        const session = await this._getSession(userConfig);
        if (!session) return [];

        try {
            // For series, id format is sly:slug:season:episode
            const parts = id.replace(ID_PREFIX, '').split(':');
            const slug = parts[0];
            const season = parts[1] || null;
            const episode = parts[2] || null;

            const html = await session.api.getPostPage(slug, type, season, episode);
            const links = this.parser.parseLinks(html);
            logger.info(`Series.ly: found ${links.length} links for ${id}`);

            if (links.length === 0) return [];

            // Resolve links via browser (Turnstile captcha requires browser)
            const typePath = type === 'movie' ? 'peliculas' : 'series';
            let detailUrl = `${this.baseUrl}/${typePath}/${slug}`;
            if (season && episode) detailUrl += `/${season}x${episode}`;

            const resolved = await session.auth.resolveLinksViaBrowser(detailUrl, links, 10);

            const streams = resolved.map(r => {
                const link = links.find(l => l.linkId === r.linkId);
                return {
                    name: 'Series.ly',
                    title: link ? this.parser._buildStreamTitle(link) : 'Series.ly',
                    externalUrl: r.embedUrl,
                };
            }).filter(s => s.externalUrl);

            logger.info(`Series.ly: resolved ${streams.length} streams for ${id}`);
            return streams;
        } catch (err) {
            logger.error(`Series.ly stream error [${id}]:`, err.message);
            return [];
        }
    }

    _catalogToApiType(catalogId) {
        const map = {
            'seriesly-movies': 'movie',
            'seriesly-series': 'serie',
            'seriesly-anime': 'anime',
        };
        return map[catalogId] || 'movie';
    }

    async _loadFilterOptions() {
        try {
            // Use a temporary unauthenticated API client for loading filters
            const tmpHttp = new HttpClient();
            const tmpApi = new SerieslyApi(tmpHttp, this.baseUrl, this.cache);
            for (const type of ['movie', 'serie']) {
                const filters = await tmpApi.getFilters(type);
                if (filters?.genres) {
                    const catalogId = type === 'movie' ? 'seriesly-movies' : 'seriesly-series';
                    const catalog = this.catalogs.find(c => c.id === catalogId);
                    if (catalog) {
                        const genreExtra = catalog.extra.find(e => e.name === 'genre');
                        if (genreExtra) {
                            genreExtra.options = filters.genres.map(g => g.name || g);
                        }
                    }
                }
            }
        } catch (err) {
            logger.warn('Could not load filter options:', err.message);
        }
    }

    async destroy() {
        this.cache.clear();
    }
}

module.exports = SerieslySource;
