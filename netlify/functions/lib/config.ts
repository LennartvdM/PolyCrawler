/**
 * Configuration and environment variable validation for PolyCrawler
 */

import { createLogger } from './logger.js';
import type { AppConfig, ConfigSchemaItem } from './types.js';

const logger = createLogger('config');

/**
 * Environment variable configuration schema
 */
const CONFIG_SCHEMA: Record<string, ConfigSchemaItem> = {
  GOOGLE_CREDENTIALS_PATH: {
    required: false,
    description: 'Path to Google service account credentials JSON',
    default: null
  },
  GOOGLE_SHEET_ID: {
    required: false,
    description: 'Google Sheet ID for output',
    default: null
  },
  WORKSHEET_NAME: {
    required: false,
    description: 'Worksheet name within the Google Sheet',
    default: 'Polymarket Contenders'
  },
  LOG_LEVEL: {
    required: false,
    description: 'Logging level (DEBUG, INFO, WARN, ERROR)',
    default: 'INFO',
    validate: (value: string) => ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(value?.toUpperCase()),
    transform: (value: string) => value?.toUpperCase()
  },
  WIKI_RATE_LIMIT_PER_SECOND: {
    required: false,
    description: 'Maximum Wikipedia API requests per second',
    default: 5,
    validate: (value: string) => !isNaN(parseInt(value)) && parseInt(value) > 0,
    transform: (value: string) => parseInt(value)
  },
  CACHE_TTL_DAYS: {
    required: false,
    description: 'Days to cache Wikipedia results',
    default: 30,
    validate: (value: string) => !isNaN(parseInt(value)) && parseInt(value) > 0,
    transform: (value: string) => parseInt(value)
  },
  MAX_BATCH_SIZE: {
    required: false,
    description: 'Maximum batch size for Wikipedia lookups',
    default: 15,
    validate: (value: string) => !isNaN(parseInt(value)) && parseInt(value) > 0,
    transform: (value: string) => parseInt(value)
  }
};

/**
 * Validated and transformed configuration values
 */
let configCache: AppConfig | null = null;

interface ValidateConfigOptions {
  exitOnError?: boolean;
}

/**
 * Validate all environment variables and return configuration object
 */
export function validateConfig(options: ValidateConfigOptions = {}): AppConfig {
  const { exitOnError = false } = options;

  if (configCache) {
    return configCache;
  }

  const config: Record<string, string | number | null> = {};
  const errors: string[] = [];

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const rawValue = process.env[key];
    let value: string | number | null = rawValue ?? schema.default;

    // Check required fields
    if (schema.required && !rawValue) {
      errors.push(`Missing required environment variable: ${key} - ${schema.description}`);
      continue;
    }

    // Validate if validator exists and value is provided
    if (rawValue && schema.validate && !schema.validate(rawValue)) {
      errors.push(`Invalid value for ${key}: "${rawValue}" - ${schema.description}`);
      continue;
    }

    // Transform if transformer exists
    if (value !== null && typeof value === 'string' && schema.transform) {
      value = schema.transform(value);
    }

    config[key] = value;

    // Log if using default for optional but useful configs
    if (!rawValue && schema.default !== null) {
      logger.debug(`Using default for ${key}`, { default: schema.default });
    }
  }

  // Report errors
  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(error);
    }
    if (exitOnError) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  configCache = config as unknown as AppConfig;
  logger.info('Configuration loaded', {
    logLevel: config.LOG_LEVEL,
    rateLimit: config.WIKI_RATE_LIMIT_PER_SECOND,
    cacheTTL: config.CACHE_TTL_DAYS
  });

  return configCache;
}

/**
 * Get a specific configuration value
 */
export function getConfig<K extends keyof AppConfig>(key: K): AppConfig[K] {
  const config = validateConfig();
  return config[key];
}

/**
 * Check if Google Sheets integration is configured
 */
export function isGoogleSheetsConfigured(): boolean {
  const config = validateConfig();
  return !!(config.GOOGLE_CREDENTIALS_PATH && config.GOOGLE_SHEET_ID);
}

/**
 * Get all configuration (for debugging)
 */
export function getAllConfig(): AppConfig {
  return validateConfig();
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache(): void {
  configCache = null;
}
