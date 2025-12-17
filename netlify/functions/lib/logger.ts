/**
 * Structured logging utility for PolyCrawler
 * Provides consistent log formatting with levels and metadata
 */

import type { LogEntry } from './types.js';

// Log levels with numeric values for filtering
const LOG_LEVELS: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// Current log level (can be set via environment variable)
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase() ?? 'INFO'] ?? LOG_LEVELS.INFO;

export interface Logger {
  debug(message: string, data?: unknown): Logger;
  info(message: string, data?: unknown): Logger;
  warn(message: string, data?: unknown): Logger;
  error(message: string, data?: unknown): Logger;
  getLogs(): LogEntry[];
  clearLogs(): Logger;
  child(subContext: string): Logger;
  timed<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a logger instance with optional context
 */
export function createLogger(context: string = 'app'): Logger {
  const logs: LogEntry[] = [];

  const formatMessage = (level: LogLevel, message: string, data?: unknown): LogEntry => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      ...(data !== undefined && { data })
    };
    return entry;
  };

  const shouldLog = (level: LogLevel): boolean => LOG_LEVELS[level] >= currentLevel;

  const logger: Logger = {
    debug(message: string, data?: unknown): Logger {
      if (shouldLog('DEBUG')) {
        const entry = formatMessage('DEBUG', message, data);
        logs.push(entry);
        console.debug(`[DEBUG][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    info(message: string, data?: unknown): Logger {
      if (shouldLog('INFO')) {
        const entry = formatMessage('INFO', message, data);
        logs.push(entry);
        console.log(`[INFO][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    warn(message: string, data?: unknown): Logger {
      if (shouldLog('WARN')) {
        const entry = formatMessage('WARN', message, data);
        logs.push(entry);
        console.warn(`[WARN][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    error(message: string, data?: unknown): Logger {
      if (shouldLog('ERROR')) {
        const entry = formatMessage('ERROR', message, data);
        logs.push(entry);
        console.error(`[ERROR][${context}] ${message}`, data ?? '');
      }
      return this;
    },

    getLogs(): LogEntry[] {
      return [...logs];
    },

    clearLogs(): Logger {
      logs.length = 0;
      return this;
    },

    child(subContext: string): Logger {
      return createLogger(`${context}:${subContext}`);
    },

    async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const start = Date.now();
      this.debug(`Starting: ${label}`);
      try {
        const result = await fn();
        const duration = Date.now() - start;
        this.info(`Completed: ${label}`, { durationMs: duration });
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        this.error(`Failed: ${label}`, { durationMs: duration, error: (error as Error).message });
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
export function getLogLevels(): string[] {
  return Object.keys(LOG_LEVELS);
}

/**
 * Get current log level name
 */
export function getCurrentLogLevel(): string {
  const entry = Object.entries(LOG_LEVELS).find(([_, val]) => val === currentLevel);
  return entry?.[0] ?? 'INFO';
}
