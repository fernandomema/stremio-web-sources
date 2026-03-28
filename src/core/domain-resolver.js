/**
 * Domain resolver for series.ly
 * Handles proxy domain resolution via enlaces.ly mirror system.
 * Uses the same subdomain generation algorithm as enlaces.ly (BIP39-based, IP-hashed).
 */
const { HttpClient } = require('./http-client');
const { Cache } = require('./cache');
const { logger } = require('./logger');

// Mirror configurations
const MIRRORS = [
    { id: 'enlace', domain: 'enlace.ly', priority: 1 },
    { id: 'xokas', domain: 'xokas.org', priority: 2 },
];

// Fallback BIP39 words (subset) - full list loaded from enlaces.ly
const FALLBACK_WORDS = [
    'activo', 'agua', 'aire', 'alto', 'amor', 'arte', 'azul', 'bien',
    'buscar', 'campo', 'carro', 'cielo', 'costa', 'deber', 'dicho',
];

class DomainResolver {
    constructor() {
        this.http = new HttpClient();
        this.cache = new Cache(3600000 * 6); // 6 hours
        this.bip39Words = [...FALLBACK_WORDS];
        this.resolvedDomain = null;
    }

    /**
     * Initialize: load BIP39 words and resolve working domain
     */
    async init() {
        await this._loadWords();
        await this.resolve();
    }

    /**
     * Get the current working base URL for series.ly
     */
    getBaseUrl() {
        return this.resolvedDomain ? `https://${this.resolvedDomain}` : null;
    }

    /**
     * Resolve a working proxy domain
     */
    async resolve() {
        const cached = this.cache.get('resolved_domain');
        if (cached) {
            this.resolvedDomain = cached;
            return cached;
        }

        // Get our IP for subdomain generation
        const ip = await this._getIP();
        if (!ip) {
            logger.warn('Could not determine IP, using fallback subdomain');
        }

        const subdomain = ip ? this._generateSubdomain(ip) : 'buscar-ly';

        // Try each mirror
        for (const mirror of MIRRORS.sort((a, b) => a.priority - b.priority)) {
            const fullDomain = `${subdomain}.${mirror.domain}`;
            logger.debug(`Trying domain: ${fullDomain}`);

            const available = await this._checkDomain(fullDomain);
            if (available) {
                this.resolvedDomain = fullDomain;
                this.cache.set('resolved_domain', fullDomain);
                logger.info(`Resolved domain: ${fullDomain}`);
                return fullDomain;
            }
        }

        // Fallback: try direct series.ly
        const directAvailable = await this._checkDomain('series.ly');
        if (directAvailable) {
            this.resolvedDomain = 'series.ly';
            this.cache.set('resolved_domain', 'series.ly');
            logger.info('Using direct series.ly');
            return 'series.ly';
        }

        logger.error('No working domain found');
        return null;
    }

    /**
     * Generate IP-based subdomain (same algorithm as enlaces.ly)
     */
    _generateSubdomain(ip) {
        let hash = 0;
        for (let i = 0; i < ip.length; i++) {
            hash = ((hash << 5) - hash) + ip.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        hash = Math.abs(hash);

        const word = this.bip39Words[hash % this.bip39Words.length];
        return `${word}-ly`;
    }

    /**
     * Check if a domain is accessible via Cloudflare trace
     */
    async _checkDomain(domain) {
        try {
            const res = await this.http.get(`https://${domain}/cdn-cgi/trace`);
            return res.status === 200 &&
                res.body.includes('fl=') &&
                res.body.includes('ip=') &&
                res.body.includes('colo=');
        } catch {
            return false;
        }
    }

    /**
     * Get server's public IP via Cloudflare
     */
    async _getIP() {
        try {
            const res = await this.http.get('https://cloudflare.com/cdn-cgi/trace');
            const match = res.body.match(/ip=([^\n]+)/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    /**
     * Load BIP39 word list from enlaces.ly
     */
    async _loadWords() {
        try {
            const res = await this.http.getJSON('https://enlaces.ly/data/words.json');
            if (res.data?.words?.length > 0) {
                this.bip39Words = res.data.words;
                logger.info(`Loaded ${this.bip39Words.length} BIP39 words`);
            }
        } catch (err) {
            logger.warn('Could not load BIP39 words, using fallback:', err.message);
        }
    }
}

module.exports = { DomainResolver, MIRRORS };
