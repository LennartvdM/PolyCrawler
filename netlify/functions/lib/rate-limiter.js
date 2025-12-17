/**
 * Rate limiter for API requests
 * Implements token bucket algorithm with queue for Wikipedia API calls
 */

import { createLogger } from './logger.js';
import { getConfig } from './config.js';

const logger = createLogger('rate-limiter');

/**
 * Token bucket rate limiter with request queue
 */
class RateLimiter {
  constructor(options = {}) {
    const {
      maxRequestsPerSecond = getConfig('WIKI_RATE_LIMIT_PER_SECOND') || 5,
      maxQueueSize = 100,
      name = 'default'
    } = options;

    this.name = name;
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond; // tokens per second
    this.lastRefill = Date.now();
    this.maxQueueSize = maxQueueSize;
    this.queue = [];
    this.processing = false;

    logger.debug(`RateLimiter created: ${name}`, {
      maxRequestsPerSecond,
      maxQueueSize
    });
  }

  /**
   * Refill tokens based on elapsed time
   */
  refillTokens() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Try to acquire a token immediately
   * @returns {boolean} Whether a token was acquired
   */
  tryAcquire() {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Calculate wait time until a token is available
   * @returns {number} Milliseconds to wait
   */
  getWaitTime() {
    this.refillTokens();

    if (this.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - this.tokens;
    const waitSeconds = tokensNeeded / this.refillRate;
    return Math.ceil(waitSeconds * 1000);
  }

  /**
   * Execute a function with rate limiting
   * @param {Function} fn - Async function to execute
   * @returns {Promise<any>} Result of the function
   */
  async execute(fn) {
    return new Promise((resolve, reject) => {
      const task = { fn, resolve, reject, addedAt: Date.now() };

      if (this.queue.length >= this.maxQueueSize) {
        logger.warn(`Rate limiter queue full: ${this.name}`, {
          queueSize: this.queue.length
        });
        reject(new Error(`Rate limiter queue full (max ${this.maxQueueSize})`));
        return;
      }

      this.queue.push(task);
      logger.debug(`Task queued: ${this.name}`, { queueSize: this.queue.length });

      this.processQueue();
    });
  }

  /**
   * Process the queue
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const waitTime = this.getWaitTime();

      if (waitTime > 0) {
        logger.debug(`Rate limit wait: ${this.name}`, { waitMs: waitTime });
        await this.sleep(waitTime);
      }

      if (this.tryAcquire()) {
        const task = this.queue.shift();
        const queueTime = Date.now() - task.addedAt;

        logger.debug(`Executing task: ${this.name}`, { queueTimeMs: queueTime });

        try {
          const result = await task.fn();
          task.resolve(result);
        } catch (error) {
          task.reject(error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue size
   */
  getQueueSize() {
    return this.queue.length;
  }

  /**
   * Get current token count
   */
  getAvailableTokens() {
    this.refillTokens();
    return Math.floor(this.tokens);
  }

  /**
   * Get rate limiter stats
   */
  getStats() {
    this.refillTokens();
    return {
      name: this.name,
      tokens: Math.floor(this.tokens),
      maxTokens: this.maxTokens,
      queueSize: this.queue.length,
      maxQueueSize: this.maxQueueSize
    };
  }
}

// Singleton instances for different APIs
let wikipediaLimiter = null;
let polymarketLimiter = null;

/**
 * Get the Wikipedia rate limiter instance
 * @returns {RateLimiter}
 */
export function getWikipediaLimiter() {
  if (!wikipediaLimiter) {
    wikipediaLimiter = new RateLimiter({
      name: 'wikipedia',
      maxRequestsPerSecond: getConfig('WIKI_RATE_LIMIT_PER_SECOND') || 5,
      maxQueueSize: 100
    });
  }
  return wikipediaLimiter;
}

/**
 * Get the Polymarket rate limiter instance
 * @returns {RateLimiter}
 */
export function getPolymarketLimiter() {
  if (!polymarketLimiter) {
    polymarketLimiter = new RateLimiter({
      name: 'polymarket',
      maxRequestsPerSecond: 10, // Polymarket is more permissive
      maxQueueSize: 50
    });
  }
  return polymarketLimiter;
}

/**
 * Execute a Wikipedia API call with rate limiting
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>}
 */
export async function withWikipediaRateLimit(fn) {
  return getWikipediaLimiter().execute(fn);
}

/**
 * Execute a Polymarket API call with rate limiting
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>}
 */
export async function withPolymarketRateLimit(fn) {
  return getPolymarketLimiter().execute(fn);
}

/**
 * Reset rate limiters (useful for testing)
 */
export function resetRateLimiters() {
  wikipediaLimiter = null;
  polymarketLimiter = null;
}

export { RateLimiter };
