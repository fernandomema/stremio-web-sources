/**
 * Simple in-memory cache with TTL support.
 * Shared across sources to cache API responses, metadata, etc.
 */
class Cache {
    constructor(defaultTTL = 3600000) { // 1 hour default
        this.store = new Map();
        this.defaultTTL = defaultTTL;
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expires) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key, value, ttl) {
        this.store.set(key, {
            value,
            expires: Date.now() + (ttl || this.defaultTTL),
        });
    }

    has(key) {
        return this.get(key) !== null;
    }

    delete(key) {
        this.store.delete(key);
    }

    clear() {
        this.store.clear();
    }

    /**
     * Get or compute a value. If cached, return cached; otherwise compute and cache.
     */
    async getOrSet(key, computeFn, ttl) {
        const cached = this.get(key);
        if (cached !== null) return cached;

        const value = await computeFn();
        this.set(key, value, ttl);
        return value;
    }

    /**
     * Remove expired entries
     */
    prune() {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.expires) {
                this.store.delete(key);
            }
        }
    }

    get size() {
        return this.store.size;
    }
}

module.exports = { Cache };
