/**
 * Structured logging utility for PolyCrawler
 * Provides consistent log formatting with levels and metadata
 */

// Log levels with numeric values for filtering
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Current log level (can be set via environment variable)
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * Create a logger instance with optional context
 * @param {string} context - Logger context (e.g., 'crawl', 'wikipedia', 'cache')
 * @returns {Logger} Logger instance
 */
export function createLogger(context = 'app') {
  const logs = [];

  const formatMessage = (level, message, data) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      ...(data && { data })
    };
    return entry;
  };

  const shouldLog = (level) => LOG_LEVELS[level] >= currentLevel;

  const logger = {
    /**
     * Log debug message (verbose, for development)
     */
    debug(message, data = null) {
      if (shouldLog('DEBUG')) {
        const entry = formatMessage('DEBUG', message, data);
        logs.push(entry);
        console.debug(`[DEBUG][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    /**
     * Log info message (standard operational info)
     */
    info(message, data = null) {
      if (shouldLog('INFO')) {
        const entry = formatMessage('INFO', message, data);
        logs.push(entry);
        console.log(`[INFO][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    /**
     * Log warning message (potential issues)
     */
    warn(message, data = null) {
      if (shouldLog('WARN')) {
        const entry = formatMessage('WARN', message, data);
        logs.push(entry);
        console.warn(`[WARN][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    /**
     * Log error message (failures)
     */
    error(message, data = null) {
      if (shouldLog('ERROR')) {
        const entry = formatMessage('ERROR', message, data);
        logs.push(entry);
        console.error(`[ERROR][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    /**
     * Get all collected logs
     */
    getLogs() {
      return [...logs];
    },

    /**
     * Clear collected logs
     */
    clearLogs() {
      logs.length = 0;
      return this;
    },

    /**
     * Create a child logger with extended context
     */
    child(subContext) {
      return createLogger(`${context}:${subContext}`);
    },

    /**
     * Log with timing measurement
     */
    async timed(label, fn) {
      const start = Date.now();
      this.debug(`Starting: ${label}`);
      try {
        const result = await fn();
        const duration = Date.now() - start;
        this.info(`Completed: ${label}`, { durationMs: duration });
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        this.error(`Failed: ${label}`, { durationMs: duration, error: error.message });
        throw error;
      }
    }
  };

  return logger;
}

/**
 * Default application logger
 */
export const logger = createLogger('app');

/**
 * Get available log levels
 */
export function getLogLevels() {
  return Object.keys(LOG_LEVELS);
}

/**
 * Get current log level name
 */
export function getCurrentLogLevel() {
  return Object.entries(LOG_LEVELS).find(([_, val]) => val === currentLevel)?.[0] ?? 'INFO';
}
