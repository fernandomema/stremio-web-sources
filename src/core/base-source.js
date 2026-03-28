/**
 * Base class for all content sources.
 * Each source provides catalogs, metadata, and streams from a specific website.
 */
class BaseSource {
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description || '';
        this.enabled = config.enabled !== false;
        this.requiresAuth = config.requiresAuth || false;

        // What this source provides
        this.types = config.types || []; // ['movie', 'series']
        this.catalogs = config.catalogs || [];
        this.idPrefixes = config.idPrefixes || []; // e.g., ['sly:']
    }

    /**
     * Initialize the source (login, fetch config, etc.)
     */
    async init() {
        // Override in subclass
    }

    /**
     * Check if this source handles a given catalog
     */
    handlesCatalog(type, catalogId) {
        return this.enabled && this.catalogs.some(c => c.id === catalogId && c.type === type);
    }

    /**
     * Check if this source handles a given content ID
     */
    handlesId(id) {
        if (!this.enabled) return false;
        if (this.idPrefixes.length === 0) return false;
        return this.idPrefixes.some(prefix => id.startsWith(prefix));
    }

    /**
     * Get catalog items
     * @returns {Array} Array of Stremio meta objects
     */
    async getCatalog(type, catalogId, extra) {
        return [];
    }

    /**
     * Get detailed metadata for a content item
     * @returns {Object|null} Stremio meta object
     */
    async getMeta(type, id) {
        return null;
    }

    /**
     * Get streams for a content item
     * @returns {Array} Array of Stremio stream objects
     */
    async getStreams(type, id) {
        return [];
    }

    /**
     * Get subtitles for a content item
     * @returns {Array} Array of Stremio subtitle objects
     */
    async getSubtitles(type, id) {
        return [];
    }

    /**
     * Cleanup resources
     */
    async destroy() {
        // Override in subclass
    }
}

module.exports = { BaseSource };
