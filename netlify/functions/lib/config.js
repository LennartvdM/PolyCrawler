/**
 * Configuration and environment variable validation for PolyCrawler
 */

import { createLogger } from './logger.js';

const logger = createLogger('config');

/**
 * Environment variable configuration schema
 */
const CONFIG_SCHEMA = {
  // Optional: Google Sheets integration
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

  // Optional: Logging configuration
  LOG_LEVEL: {
    required: false,
    description: 'Logging level (DEBUG, INFO, WARN, ERROR)',
    default: 'INFO',
    validate: (value) => ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(value?.toUpperCase()),
    transform: (value) => value?.toUpperCase()
  },

  // Optional: Rate limiting configuration
  WIKI_RATE_LIMIT_PER_SECOND: {
    required: false,
    description: 'Maximum Wikipedia API requests per second',
    default: '5',
    validate: (value) => !isNaN(parseInt(value)) && parseInt(value) > 0,
    transform: (value) => parseInt(value)
  },

  // Optional: Cache configuration
  CACHE_TTL_DAYS: {
    required: false,
    description: 'Days to cache Wikipedia results',
    default: '30',
    validate: (value) => !isNaN(parseInt(value)) && parseInt(value) > 0,
    transform: (value) => parseInt(value)
  },

  // Optional: Batch configuration
  MAX_BATCH_SIZE: {
    required: false,
    description: 'Maximum batch size for Wikipedia lookups',
    default: '15',
    validate: (value) => !isNaN(parseInt(value)) && parseInt(value) > 0,
    transform: (value) => parseInt(value)
  }
};

/**
 * Validated and transformed configuration values
 */
let configCache = null;

/**
 * Validate all environment variables and return configuration object
 * @param {Object} options - Options
 * @param {boolean} options.exitOnError - Whether to throw on validation error (default: false)
 * @returns {Object} Validated configuration
 */
export function validateConfig(options = {}) {
  const { exitOnError = false } = options;

  if (configCache) {
    return configCache;
  }

  const config = {};
  const errors = [];
  const warnings = [];

  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const rawValue = process.env[key];
    let value = rawValue ?? schema.default;

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
    if (value && schema.transform) {
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

  // Report warnings
  for (const warning of warnings) {
    logger.warn(warning);
  }

  configCache = config;
  logger.info('Configuration loaded', {
    logLevel: config.LOG_LEVEL,
    rateLimit: config.WIKI_RATE_LIMIT_PER_SECOND,
    cacheTTL: config.CACHE_TTL_DAYS
  });

  return config;
}

/**
 * Get a specific configuration value
 * @param {string} key - Configuration key
 * @returns {any} Configuration value
 */
export function getConfig(key) {
  const config = validateConfig();
  return config[key];
}

/**
 * Check if Google Sheets integration is configured
 * @returns {boolean}
 */
export function isGoogleSheetsConfigured() {
  const config = validateConfig();
  return !!(config.GOOGLE_CREDENTIALS_PATH && config.GOOGLE_SHEET_ID);
}

/**
 * Get all configuration (for debugging)
 * @returns {Object}
 */
export function getAllConfig() {
  return validateConfig();
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache() {
  configCache = null;
}
