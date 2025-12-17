/**
 * Unit tests for rate-limiter module
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { RateLimiter, resetRateLimiters } from '../netlify/functions/lib/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    resetRateLimiters();
  });

  it('should create with default options', () => {
    const limiter = new RateLimiter();

    assert.ok(limiter);
    assert.strictEqual(limiter.getQueueSize(), 0);
  });

  it('should create with custom options', () => {
    const limiter = new RateLimiter({
      maxRequestsPerSecond: 10,
      maxQueueSize: 50,
      name: 'test-limiter'
    });

    const stats = limiter.getStats();
    assert.strictEqual(stats.name, 'test-limiter');
    assert.strictEqual(stats.maxTokens, 10);
    assert.strictEqual(stats.maxQueueSize, 50);
  });
});

describe('RateLimiter.execute', () => {
  it('should execute function immediately when tokens available', async () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 10 });
    let executed = false;

    await limiter.execute(async () => {
      executed = true;
      return 'result';
    });

    assert.strictEqual(executed, true);
  });

  it('should return function result', async () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 10 });

    const result = await limiter.execute(async () => {
      return { value: 42 };
    });

    assert.deepStrictEqual(result, { value: 42 });
  });

  it('should propagate errors', async () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 10 });

    await assert.rejects(async () => {
      await limiter.execute(async () => {
        throw new Error('Test error');
      });
    }, /Test error/);
  });

  it('should reject when queue is full', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerSecond: 1,
      maxQueueSize: 2
    });

    // Fill up the queue with slow tasks
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(
        limiter.execute(async () => {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return i;
        }).catch(e => e)
      );
    }

    // Some should be rejected
    const results = await Promise.all(tasks);
    const errors = results.filter(r => r instanceof Error);

    assert.ok(errors.length > 0, 'Expected some tasks to be rejected');
  });
});

describe('RateLimiter.getStats', () => {
  it('should return current stats', () => {
    const limiter = new RateLimiter({
      name: 'test',
      maxRequestsPerSecond: 5,
      maxQueueSize: 10
    });

    const stats = limiter.getStats();

    assert.strictEqual(stats.name, 'test');
    assert.strictEqual(stats.maxTokens, 5);
    assert.strictEqual(stats.maxQueueSize, 10);
    assert.ok(stats.tokens >= 0);
    assert.strictEqual(stats.queueSize, 0);
  });
});

describe('RateLimiter.getQueueSize', () => {
  it('should return 0 for empty queue', () => {
    const limiter = new RateLimiter();

    assert.strictEqual(limiter.getQueueSize(), 0);
  });
});

describe('RateLimiter.getAvailableTokens', () => {
  it('should return available tokens', () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 5 });

    const tokens = limiter.getAvailableTokens();

    assert.ok(tokens >= 0);
    assert.ok(tokens <= 5);
  });
});

describe('Rate limiting behavior', () => {
  it('should enforce rate limit', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerSecond: 5,
      maxQueueSize: 20
    });

    const startTime = Date.now();
    const executionTimes: number[] = [];

    // Execute 10 tasks (should take ~1-2 seconds with 5/sec limit)
    const tasks = Array.from({ length: 10 }, (_, i) =>
      limiter.execute(async () => {
        executionTimes.push(Date.now() - startTime);
        return i;
      })
    );

    await Promise.all(tasks);

    // Check that later executions were delayed
    const lastTime = executionTimes[executionTimes.length - 1];
    assert.ok(lastTime >= 500, `Expected delay, got ${lastTime}ms`);
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 10 });

    // Use all tokens
    for (let i = 0; i < 10; i++) {
      await limiter.execute(async () => i);
    }

    // Wait for tokens to refill
    await new Promise(resolve => setTimeout(resolve, 500));

    // Should have ~5 tokens now (10/sec * 0.5sec)
    const tokens = limiter.getAvailableTokens();
    assert.ok(tokens >= 4, `Expected >= 4 tokens, got ${tokens}`);
  });
});
