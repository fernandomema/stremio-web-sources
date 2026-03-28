const { logger } = require('./logger');

/**
 * Manages all registered content sources.
 * Routes Stremio requests to the appropriate source(s).
 */
class SourceManager {
    constructor() {
        this.sources = [];
    }

    register(source) {
        this.sources.push(source);
        logger.info(`Registered source: ${source.name} (${source.id})`);
    }

    getSources() {
        return this.sources;
    }

    getEnabledSources() {
        return this.sources.filter(s => s.enabled);
    }

    async initAll() {
        for (const source of this.sources) {
            try {
                await source.init();
                logger.info(`Initialized: ${source.name}`);
            } catch (err) {
                logger.error(`Failed to init ${source.name}:`, err.message);
                source.enabled = false;
            }
        }
    }

    async handleCatalog(type, catalogId, extra, userConfig) {
        const results = [];
        for (const source of this.getEnabledSources()) {
            if (source.handlesCatalog(type, catalogId)) {
                try {
                    const items = await source.getCatalog(type, catalogId, extra, userConfig);
                    results.push(...items);
                } catch (err) {
                    logger.error(`Catalog error [${source.name}]:`, err.message);
                }
            }
        }
        return results;
    }

    async handleMeta(type, id, userConfig) {
        for (const source of this.getEnabledSources()) {
            if (source.handlesId(id)) {
                try {
                    const meta = await source.getMeta(type, id, userConfig);
                    if (meta) return meta;
                } catch (err) {
                    logger.error(`Meta error [${source.name}]:`, err.message);
                }
            }
        }
        return null;
    }

    async handleStream(type, id, userConfig) {
        const results = [];
        for (const source of this.getEnabledSources()) {
            if (source.handlesId(id)) {
                try {
                    const streams = await source.getStreams(type, id, userConfig);
                    results.push(...streams);
                } catch (err) {
                    logger.error(`Stream error [${source.name}]:`, err.message);
                }
            }
        }
        return results;
    }

    async handleSubtitles(type, id, userConfig) {
        const results = [];
        for (const source of this.getEnabledSources()) {
            if (source.handlesId(id)) {
                try {
                    const subs = await source.getSubtitles(type, id, userConfig);
                    results.push(...subs);
                } catch (err) {
                    logger.error(`Subtitles error [${source.name}]:`, err.message);
                }
            }
        }
        return results;
    }

    async destroyAll() {
        for (const source of this.sources) {
            try {
                await source.destroy();
            } catch (err) {
                logger.error(`Destroy error [${source.name}]:`, err.message);
            }
        }
    }
}

module.exports = { SourceManager };
