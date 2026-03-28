const PREFIX = '[WebSources]';

const logger = {
    info: (...args) => console.log(PREFIX, new Date().toISOString().substring(11, 19), '|', ...args),
    error: (...args) => console.error(PREFIX, new Date().toISOString().substring(11, 19), 'ERROR |', ...args),
    warn: (...args) => console.warn(PREFIX, new Date().toISOString().substring(11, 19), 'WARN |', ...args),
    debug: (...args) => {
        if (process.env.DEBUG) console.log(PREFIX, new Date().toISOString().substring(11, 19), 'DEBUG |', ...args);
    },
};

module.exports = { logger };
