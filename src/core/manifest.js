/**
 * Builds combined Stremio manifest from all registered sources.
 */
function createManifest(sources) {
    const enabledSources = sources.filter(s => s.enabled);

    // Merge types from all sources
    const types = [...new Set(enabledSources.flatMap(s => s.types))];

    // Merge catalogs from all sources
    const catalogs = enabledSources.flatMap(s => s.catalogs);

    // Merge idPrefixes from all sources
    const idPrefixes = [...new Set(enabledSources.flatMap(s => s.idPrefixes))];

    // Resources - always provide catalog, meta, stream
    const resources = ['catalog', 'meta', 'stream'];

    return {
        id: 'community.stremio.web-sources',
        version: '1.0.0',
        name: 'Web Sources',
        description: `Multi-source addon (${enabledSources.map(s => s.name).join(', ')})`,
        logo: 'https://www.stremio.com/website/stremio-logo-small.png',
        resources,
        types,
        catalogs,
        idPrefixes,
        behaviorHints: {
            configurable: true,
            configurationRequired: false,
        },
    };
}

module.exports = { createManifest };
