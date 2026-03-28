const express = require('express');
const crypto = require('crypto');
const { SourceManager } = require('./core/source-manager');
const { createManifest } = require('./core/manifest');
const { logger } = require('./core/logger');

// Import sources
const SerieslySource = require('./sources/seriesly');

const PORT = process.env.PORT || 7000;
const app = express();

// --- Source Manager ---
const sourceManager = new SourceManager();

// Register sources
sourceManager.register(new SerieslySource());

// --- Helpers ---

/**
 * Decode userConfig from URL segment.
 * Format: base64url-encoded JSON, e.g. {"seriesly":{"email":"...","password":"..."}}
 */
function decodeUserConfig(encoded) {
    if (!encoded) return null;
    try {
        const json = Buffer.from(encoded, 'base64url').toString('utf-8');
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function encodeUserConfig(config) {
    return Buffer.from(JSON.stringify(config)).toString('base64url');
}

/**
 * Hash a userConfig for use as session cache key (never log credentials).
 */
function configHash(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

// Parse extra params from Stremio URL format
function parseExtra(extraStr) {
    if (!extraStr) return {};
    const extra = {};
    const parts = extraStr.replace('.json', '').split('&');
    for (const part of parts) {
        const [key, ...rest] = part.split('=');
        extra[key] = decodeURIComponent(rest.join('='));
    }
    return extra;
}

// --- Stremio Addon Protocol ---

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const path = req.path.replace(/eyJ[A-Za-z0-9_-]+/, '{config}');
        logger.info(`${req.method} ${path} → ${res.statusCode} (${ms}ms)`);
    });
    next();
});

app.use(express.json());

// --- Routes: both /:userConfig/resource and /resource (unauthenticated) ---

// Manifest
app.get('/:userConfig/manifest.json', handleManifest);
app.get('/manifest.json', handleManifest);

function handleManifest(req, res) {
    const userConfig = decodeUserConfig(req.params.userConfig);
    const manifest = createManifest(sourceManager.getSources());
    // If user has config, set configurationRequired: false
    if (userConfig) {
        manifest.behaviorHints.configurationRequired = false;
    }
    res.json(manifest);
}

// Catalog
app.get('/:userConfig/catalog/:type/:id.json', handleCatalog);
app.get('/:userConfig/catalog/:type/:id/:extra.json', handleCatalog);
app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/:extra.json', handleCatalog);

async function handleCatalog(req, res) {
    try {
        const { type, id, extra } = req.params;
        const userConfig = decodeUserConfig(req.params.userConfig);
        const parsedExtra = parseExtra(extra);
        const results = await sourceManager.handleCatalog(type, id, parsedExtra, userConfig);
        res.json({ metas: results });
    } catch (err) {
        logger.error('Catalog error:', err);
        res.json({ metas: [] });
    }
}

// Meta
app.get('/:userConfig/meta/:type/:id.json', handleMeta);
app.get('/meta/:type/:id.json', handleMeta);

async function handleMeta(req, res) {
    try {
        const { type, id } = req.params;
        const userConfig = decodeUserConfig(req.params.userConfig);
        logger.info(`META request: type=${type} id=${id} hasConfig=${!!userConfig}`);
        const result = await sourceManager.handleMeta(type, id, userConfig);
        logger.info(`META result: ${result ? result.name : 'null'}`);
        res.json({ meta: result || null });
    } catch (err) {
        logger.error('Meta error:', err);
        res.json({ meta: null });
    }
}

// Stream
app.get('/:userConfig/stream/:type/:id.json', handleStream);
app.get('/stream/:type/:id.json', handleStream);

async function handleStream(req, res) {
    try {
        const { type, id } = req.params;
        const userConfig = decodeUserConfig(req.params.userConfig);
        logger.info(`STREAM request: type=${type} id=${id} hasConfig=${!!userConfig}`);
        const results = await sourceManager.handleStream(type, id, userConfig);
        logger.info(`STREAM result: ${results.length} streams`);
        res.json({ streams: results });
    } catch (err) {
        logger.error('Stream error:', err);
        res.json({ streams: [] });
    }
}

// Subtitles
app.get('/:userConfig/subtitles/:type/:id.json', handleSubtitles);
app.get('/subtitles/:type/:id.json', handleSubtitles);

async function handleSubtitles(req, res) {
    try {
        const { type, id } = req.params;
        const userConfig = decodeUserConfig(req.params.userConfig);
        const results = await sourceManager.handleSubtitles(type, id, userConfig);
        res.json({ subtitles: results });
    } catch (err) {
        res.json({ subtitles: [] });
    }
}

// --- Configuration page ---
app.get('/configure', (req, res) => {
    const sources = sourceManager.getSources();
    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || 'http';

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stremio Web Sources - Configurar</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; max-width: 600px; margin: 40px auto; padding: 20px; }
    h1 { color: #e94560; margin-bottom: 5px; }
    h1 span { font-size: 14px; color: #888; font-weight: normal; }
    .subtitle { color: #888; margin-bottom: 25px; }
    .section { background: #16213e; padding: 20px; margin: 15px 0; border-radius: 8px; }
    .section h2 { margin: 0 0 15px; font-size: 16px; color: #e94560; }
    label { display: block; margin: 10px 0 4px; font-size: 14px; color: #aaa; }
    input[type=email], input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #333; border-radius: 6px; background: #0f3460; color: #eee; font-size: 14px; }
    input:focus { outline: none; border-color: #e94560; }
    .btn { display: inline-block; padding: 12px 24px; margin-top: 15px; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; text-decoration: none; }
    .btn-primary { background: #e94560; color: #fff; }
    .btn-primary:hover { background: #d63851; }
    .btn-install { background: #8338ec; color: #fff; }
    .btn-install:hover { background: #7029d6; }
    .result { display: none; margin-top: 15px; }
    .result.visible { display: block; }
    .url-box { background: #0a0f1e; padding: 12px; border-radius: 6px; word-break: break-all; font-family: monospace; font-size: 13px; color: #2ecc71; margin: 10px 0; }
    .source-badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 12px; margin-left: 8px; }
    .active { background: #2ecc71; color: #fff; }
    .info { font-size: 13px; color: #888; margin-top: 8px; }
    .btns { display: flex; gap: 10px; flex-wrap: wrap; }
</style>
</head><body>
<h1>Stremio Web Sources</h1>
<p class="subtitle">Addon modular con multiples fuentes de contenido</p>

${sources.map(s => `
<div class="section">
    <h2>${s.name} <span class="source-badge active">Disponible</span></h2>
    <p style="margin:0 0 10px;font-size:14px;color:#ccc">${s.description || ''}</p>
    ${s.requiresAuth ? `
    <label for="${s.id}-email">Email</label>
    <input type="email" id="${s.id}-email" placeholder="tu@email.com" autocomplete="email">
    <label for="${s.id}-pass">Contraseña</label>
    <input type="password" id="${s.id}-pass" placeholder="Tu contraseña" autocomplete="current-password">
    ` : ''}
</div>
`).join('')}

<button class="btn btn-primary" onclick="generateUrl()">Generar URL de instalación</button>

<div class="result" id="result">
    <div class="section">
        <h2>Tu URL personalizada</h2>
        <div class="url-box" id="addon-url"></div>
        <div class="btns">
            <button class="btn btn-primary" onclick="copyUrl()">Copiar URL</button>
            <a class="btn btn-install" id="stremio-link" href="#">Instalar en Stremio</a>
        </div>
        <p class="info">Copia la URL del manifest o haz clic en "Instalar en Stremio" para añadirlo directamente.</p>
    </div>
</div>

<script>
function generateUrl() {
    var config = {};
    var sources = ${JSON.stringify(sources.filter(s => s.requiresAuth).map(s => s.id))};
    for (var i = 0; i < sources.length; i++) {
        var sid = sources[i];
        var emailEl = document.getElementById(sid + '-email');
        var passEl = document.getElementById(sid + '-pass');
        if (emailEl && passEl && emailEl.value && passEl.value) {
            config[sid] = { email: emailEl.value, password: passEl.value };
        }
    }
    if (Object.keys(config).length === 0) {
        alert('Introduce al menos las credenciales de una fuente');
        return;
    }
    var encoded = btoa(JSON.stringify(config))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    var base = '${protocol}://${host}';
    var url = base + '/' + encoded + '/manifest.json';
    document.getElementById('addon-url').textContent = url;
    document.getElementById('stremio-link').href = 'stremio://' + '${host}' + '/' + encoded + '/manifest.json';
    document.getElementById('result').classList.add('visible');
}
function copyUrl() {
    var url = document.getElementById('addon-url').textContent;
    navigator.clipboard.writeText(url).then(function() {
        alert('URL copiada al portapapeles');
    });
}
</script>
</body></html>`);
});

// --- Start ---
async function start() {
    logger.info('Initializing sources...');
    await sourceManager.initAll();

    app.listen(PORT, () => {
        logger.info(`Server running at http://localhost:${PORT}`);
        logger.info(`Configure: http://localhost:${PORT}/configure`);
        logger.info(`Sources: ${sourceManager.getSources().map(s => s.name).join(', ')}`);
    });
}

start().catch(err => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
