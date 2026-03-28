# Stremio Web Sources

Addon modular de Stremio que gestiona múltiples fuentes de vídeo bajo un mismo servidor. Sistema pluggable donde cada fuente (source) comparte infraestructura común: HTTP client con cookies, caché, resolución de dominios proxy, y parsing.

## Arquitectura

```
src/
├── index.js                    # Servidor Express + rutas Stremio
├── core/
│   ├── base-source.js          # Clase base para todos los sources
│   ├── source-manager.js       # Orquestador multi-source
│   ├── manifest.js             # Generador de manifest combinado
│   ├── http-client.js          # HTTP client con cookies, CSRF, redirects
│   ├── cache.js                # Caché en memoria con TTL
│   ├── domain-resolver.js      # Resolución de dominios proxy (enlaces.ly)
│   └── logger.js               # Logger
└── sources/
    └── seriesly/               # Source: Series.ly
        ├── index.js            # Entry point del source
        ├── auth.js             # Autenticación (login con CSRF)
        ├── api.js              # Cliente API (search, catalog, filters)
        └── parser.js           # Parser HTML/JSON → formato Stremio
```

## Cómo funciona

1. **Resolución de dominio**: Al iniciar, el `DomainResolver` genera un subdominio proxy usando el algoritmo de [enlaces.ly](https://enlaces.ly) (hash BIP39 de la IP del servidor) y verifica disponibilidad contra los mirrors (`enlace.ly`, `xokas.org`).

2. **Autenticación**: Si se configuran credenciales, el source se autentica via POST al formulario de login con CSRF token, manteniendo la sesión via cookies.

3. **API**: Todas las llamadas al API de series.ly son POST con JSON body y requieren CSRF token + cookies de sesión:
   - `/api/search/posts` — Búsqueda
   - `/api/posts/list` — Listado con filtros (tipo, género, calidad, idioma, año)
   - `/api/home/posts/batch` — Contenido home
   - `/api/posts/filters` — Filtros disponibles

4. **Streams**: Los enlaces de vídeo se extraen del HTML de la página de detalle (renderizado por Livewire) y se resuelven individualmente.

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con credenciales de Series.ly
npm start
```

El addon estará en `http://localhost:7000/manifest.json` — se puede instalar en Stremio.

## Credenciales

Se necesita una cuenta de Series.ly. Configura en `.env`:

```
SERIESLY_EMAIL=tu@email.com
SERIESLY_PASSWORD=tupassword
```

## Añadir nuevas fuentes

Crear un nuevo directorio en `src/sources/` con un módulo que extienda `BaseSource`:

```js
const { BaseSource } = require('../../core/base-source');

class MiSource extends BaseSource {
    constructor() {
        super({
            id: 'mi-source',
            name: 'Mi Source',
            types: ['movie', 'series'],
            idPrefixes: ['ms:'],
            catalogs: [{ id: 'mi-catalog', type: 'movie', name: 'Mi Catálogo' }],
        });
    }

    async init() { /* setup */ }
    async getCatalog(type, catalogId, extra) { return []; }
    async getMeta(type, id) { return null; }
    async getStreams(type, id) { return []; }
}

module.exports = MiSource;
```

Luego registrarlo en `src/index.js`:

```js
const MiSource = require('./sources/mi-source');
sourceManager.register(new MiSource());
```

## Notas técnicas

- Las peticiones HTTP usan el módulo nativo `https`/`http` (sin dependencias extra tipo axios) para minimizar peso
- El parser usa Cheerio para el HTML estático; no se usa Playwright/Puppeteer en runtime
- Playwright solo se usa como dev dependency para los scripts de análisis en `scripts/`
- La caché en memoria tiene TTL configurable por tipo de dato
- El sistema de cookies del HttpClient gestiona automáticamente sesiones multi-dominio
