/**
 * Rate limiter for API requests
 * Implements token bucket algorithm with queue for Wikipedia API calls
 */

import { createLogger } from './logger.js';
import { getConfig } from './config.js';
import type { RateLimiterTask, RateLimiterStats } from './types.js';

const logger = createLogger('rate-limiter');

interface RateLimiterOptions {
  maxRequestsPerSecond?: number;
  maxQueueSize?: number;
  name?: string;
}

/**
 * Token bucket rate limiter with request queue
 */
export class RateLimiter {
  private name: string;
  private maxTokens: number;
  private tokens: number;
  private refillRate: number;
  private lastRefill: number;
  private maxQueueSize: number;
  private queue: RateLimiterTask<unknown>[];
  private processing: boolean;

  constructor(options: RateLimiterOptions = {}) {
    const {
      maxRequestsPerSecond = getConfig('WIKI_RATE_LIMIT_PER_SECOND') || 5,
      maxQueueSize = 100,
      name = 'default'
    } = options;

    this.name = name;
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond;
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
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Try to acquire a token immediately
   */
  private tryAcquire(): boolean {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Calculate wait time until a token is available
   */
  private getWaitTime(): number {
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
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: RateLimiterTask<T> = { fn, resolve, reject, addedAt: Date.now() };

      if (this.queue.length >= this.maxQueueSize) {
        logger.warn(`Rate limiter queue full: ${this.name}`, {
          queueSize: this.queue.length
        });
        reject(new Error(`Rate limiter queue full (max ${this.maxQueueSize})`));
        return;
      }

      this.queue.push(task as RateLimiterTask<unknown>);
      logger.debug(`Task queued: ${this.name}`, { queueSize: this.queue.length });

      this.processQueue();
    });
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
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
        const task = this.queue.shift()!;
        const queueTime = Date.now() - task.addedAt;

        logger.debug(`Executing task: ${this.name}`, { queueTimeMs: queueTime });

        try {
          const result = await task.fn();
          task.resolve(result);
        } catch (error) {
          task.reject(error as Error);
        }
      }
    }

    this.processing = false;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get current token count
   */
  getAvailableTokens(): number {
    this.refillTokens();
    return Math.floor(this.tokens);
  }

  /**
   * Get rate limiter stats
   */
  getStats(): RateLimiterStats {
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
let wikipediaLimiter: RateLimiter | null = null;
let polymarketLimiter: RateLimiter | null = null;

/**
 * Get the Wikipedia rate limiter instance
 */
export function getWikipediaLimiter(): RateLimiter {
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
 */
export function getPolymarketLimiter(): RateLimiter {
  if (!polymarketLimiter) {
    polymarketLimiter = new RateLimiter({
      name: 'polymarket',
      maxRequestsPerSecond: 10,
      maxQueueSize: 50
    });
  }
  return polymarketLimiter;
}

/**
 * Execute a Wikipedia API call with rate limiting
 */
export async function withWikipediaRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  return getWikipediaLimiter().execute(fn);
}

/**
 * Execute a Polymarket API call with rate limiting
 */
export async function withPolymarketRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  return getPolymarketLimiter().execute(fn);
}

/**
 * Reset rate limiters (useful for testing)
 */
export function resetRateLimiters(): void {
  wikipediaLimiter = null;
  polymarketLimiter = null;
}
