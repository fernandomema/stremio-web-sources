const cheerio = require('cheerio');
const { logger } = require('../../core/logger');

/**
 * Parses series.ly HTML and API responses into Stremio-compatible formats.
 */
class SerieslyParser {
    constructor(idPrefix) {
        this.idPrefix = idPrefix;
    }

    /**
     * Parse search API response into Stremio meta objects
     */
    parseSearchResults(data, requestedType) {
        if (!data?.posts) return [];

        return data.posts
            .filter(post => this._matchesType(post, requestedType))
            .map(post => this._postToMeta(post));
    }

    /**
     * Parse catalog list API response into Stremio meta objects
     */
    parseCatalogResults(data, requestedType) {
        if (!data?.posts) return [];

        return data.posts.map(post => this._postToMeta(post, requestedType));
    }

    /**
     * Parse a post detail HTML page into a Stremio meta object
     */
    parsePostDetail(html, id, type) {
        const $ = cheerio.load(html);

        const meta = {
            id,
            type,
            name: '',
            poster: '',
            background: '',
            description: '',
            genres: [],
            year: null,
        };

        // Title - h3 with uppercase font-bold (desktop title) or <title>
        meta.name = $('h3.font-bold').first().text().trim() ||
                    $('title').text().replace(/\s*\|.*$/, '').trim();

        // Poster - <img class="media-img"> with TMDB/weserv URL
        $('img.media-img').each((_, el) => {
            const src = $(el).attr('src') || '';
            if (src.includes('tmdb.org') || src.includes('weserv.nl')) {
                if (!meta.poster) meta.poster = src;
            }
        });

        // Background - from the div with background-image style containing TMDB w1280
        const bgMatch = html.match(/url\(([^)]*tmdb\.org\/t\/p\/w1280[^)]+)\)/);
        if (bgMatch) {
            meta.background = bgMatch[1].replace(/&amp;/g, '&');
        }
        if (!meta.background) meta.background = meta.poster;

        // Description - paragraph after the "Sinopsis" h5 heading
        $('h5').each((_, el) => {
            if ($(el).text().trim().toLowerCase() === 'sinopsis') {
                meta.description = $(el).parent().find('p').first().text().trim();
            }
        });

        // Year - from div[title="Año de estreno"] span
        const yearEl = $('div[title="Año de estreno"] span').first().text().trim();
        if (yearEl) {
            const year = parseInt(yearEl);
            if (year >= 1900 && year <= 2099) meta.year = year;
        }

        // Genres - links with ?g= query param
        $('a[href*="?g="]').each((_, el) => {
            const genre = $(el).text().trim();
            if (genre && !meta.genres.includes(genre)) {
                meta.genres.push(genre);
            }
        });

        // Rating - percentage text like "82.2%"
        const ratingMatch = html.match(/(\d+\.\d+)%\s*<\/h4>/);
        if (ratingMatch) {
            meta.imdbRating = (parseFloat(ratingMatch[1]) / 10).toFixed(1);
        }

        // Tagline - italic paragraph
        const tagline = $('p.italic.text-gray-500, p.italic.dark\\:text-gray-400').first().text().trim();
        if (tagline) meta.description = tagline + '\n\n' + meta.description;

        // For series: parse seasons and episodes
        if (type === 'series') {
            meta.videos = this._parseEpisodes($, id, html);
        }

        return meta;
    }

    /**
     * Parse video links from a post detail page.
     * Links are in <tr> rows with data-* attributes and playLink() Alpine handlers.
     */
    parseLinks(html) {
        const $ = cheerio.load(html);
        const links = [];

        // Data rows have data-server attribute (header rows don't)
        $('tr[data-server]').each((_, row) => {
            const $row = $(row);
            const link = {
                url: '',
                linkId: '',
                quality: $row.attr('data-quality-name') || '',
                language: $row.attr('data-language') || '',
                server: $row.attr('data-server') || '',
                user: $row.attr('data-user') || '',
            };

            // Extract play URL and link ID from x-on:click="playLink('URL', 'ID', '')"
            const playButton = $row.find('a[x-on\\:click*="playLink"]');
            const clickAttr = playButton.attr('x-on:click') || '';
            const playMatch = clickAttr.match(/playLink\('([^']+)',\s*'(\d+)'/);
            if (playMatch) {
                link.url = playMatch[1];
                link.linkId = playMatch[2];
            }

            if (link.url) {
                links.push(link);
            }
        });

        return links;
    }

    /**
     * Convert a video link to a Stremio stream object
     */
    linkToStream(link, resolved) {
        const stream = {
            name: `Series.ly`,
            title: this._buildStreamTitle(link),
        };

        if (resolved?.embedUrl) {
            stream.externalUrl = resolved.embedUrl;
        } else if (resolved?.url) {
            stream.url = resolved.url;
        } else if (resolved?.html) {
            // Try to extract iframe/video src from HTML
            const iframeMatch = resolved.html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
            if (iframeMatch) {
                stream.externalUrl = iframeMatch[1];
            }
            const sourceMatch = resolved.html.match(/(?:file|source|src)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8|mkv)[^"']*?)["']/i);
            if (sourceMatch) {
                stream.url = sourceMatch[1];
            }
        }

        return stream.url || stream.externalUrl ? stream : null;
    }

    /**
     * Convert an API post object to Stremio meta format
     */
    _postToMeta(post, overrideType = null) {
        const type = overrideType || this._apiTypeToStremio(post.type);
        const id = `${this.idPrefix}${post.slug || post.id}`;

        const meta = {
            id,
            type,
            name: post.title || '',
            poster: post.poster || '',
            posterShape: 'poster',
            background: post.cover || post.poster || '',
            description: post.description || '',
            genres: Array.isArray(post.genres) ? post.genres.map(g => g.name || g) : [],
            imdbRating: post.vote_average ? String(post.vote_average) : undefined,
        };

        // Year from item_date
        if (post.item_date) {
            const year = parseInt(post.item_date);
            if (year >= 1900 && year <= 2030) meta.year = year;
        }

        // Trailer
        if (post.trailer) {
            meta.trailers = [{ source: post.trailer, type: 'Trailer' }];
        }

        return meta;
    }

    /**
     * Parse episodes from a series detail page.
     * Episodes are Livewire components with links in format /{slug}/{S}x{E}
     */
    _parseEpisodes($, baseId, html) {
        const videos = [];
        const slug = baseId.replace(this.idPrefix, '');
        const seen = new Set();

        // Find episode links with pattern /{slug}/{season}x{episode}
        const pattern = new RegExp(`/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d+)x(\\d+)`, 'g');
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const season = parseInt(match[1]);
            const episode = parseInt(match[2]);
            const key = `${season}:${episode}`;
            if (seen.has(key)) continue;
            seen.add(key);

            // Find the episode title from an <a> containing this link
            let title = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            const linkEl = $(`a[href*="/${slug}/${season}x${episode}"]`).filter((_, el) => {
                // Get links with meaningful title text (not "Ver ahora" etc.)
                const t = $(el).text().trim();
                return t && t.length > 3 && !t.includes('Ver ahora') && !t.includes('Ver online');
            }).first();
            if (linkEl.length) {
                title = linkEl.text().trim();
            }

            videos.push({
                id: `${this.idPrefix}${slug}:${season}:${episode}`,
                title,
                season,
                episode,
                released: new Date().toISOString(),
            });
        }

        // Sort by season then episode
        videos.sort((a, b) => a.season - b.season || a.episode - b.episode);

        return videos;
    }

    _buildStreamTitle(link) {
        const parts = [];
        if (link.quality) parts.push(`📺 ${link.quality}`);
        if (link.language) parts.push(`🗣️ ${link.language}`);
        if (link.server) parts.push(`🖥️ ${link.server}`);
        if (link.user) parts.push(`👤 ${link.user}`);
        return parts.join(' | ') || 'Series.ly';
    }

    _matchesType(post, requestedType) {
        const postType = this._apiTypeToStremio(post.type);
        return postType === requestedType;
    }

    _apiTypeToStremio(apiType) {
        const map = {
            'movie': 'movie',
            'serie': 'series',
            'anime': 'series',
        };
        return map[apiType] || 'movie';
    }
}

module.exports = { SerieslyParser };
