/**
 * Unit tests for logger module
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createLogger, getLogLevels, getCurrentLogLevel } from '../netlify/functions/lib/logger.js';

describe('createLogger', () => {
  it('should create a logger with default context', () => {
    const logger = createLogger();
    assert.ok(logger);
    assert.ok(typeof logger.info === 'function');
    assert.ok(typeof logger.debug === 'function');
    assert.ok(typeof logger.warn === 'function');
    assert.ok(typeof logger.error === 'function');
  });

  it('should create a logger with custom context', () => {
    const logger = createLogger('test-context');
    logger.info('Test message');

    const logs = logger.getLogs();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].context, 'test-context');
  });
});

describe('logger methods', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger('test');
  });

  it('should log info messages', () => {
    logger.info('Test info message');

    const logs = logger.getLogs();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].level, 'INFO');
    assert.strictEqual(logs[0].message, 'Test info message');
  });

  it('should log with data', () => {
    logger.info('Test message', { key: 'value' });

    const logs = logger.getLogs();
    assert.strictEqual(logs.length, 1);
    assert.deepStrictEqual(logs[0].data, { key: 'value' });
  });

  it('should log warnings', () => {
    logger.warn('Test warning');

    const logs = logger.getLogs();
    assert.strictEqual(logs[0].level, 'WARN');
  });

  it('should log errors', () => {
    logger.error('Test error');

    const logs = logger.getLogs();
    assert.strictEqual(logs[0].level, 'ERROR');
  });

  it('should chain log calls', () => {
    logger.info('Message 1').info('Message 2').warn('Warning');

    const logs = logger.getLogs();
    assert.strictEqual(logs.length, 3);
  });

  it('should include timestamp in logs', () => {
    logger.info('Test');

    const logs = logger.getLogs();
    assert.ok(logs[0].timestamp);
    assert.ok(new Date(logs[0].timestamp).getTime() > 0);
  });
});

describe('logger.getLogs', () => {
  it('should return copy of logs array', () => {
    const logger = createLogger('test');
    logger.info('Test');

    const logs1 = logger.getLogs();
    const logs2 = logger.getLogs();

    assert.notStrictEqual(logs1, logs2);
    assert.deepStrictEqual(logs1, logs2);
  });
});

describe('logger.clearLogs', () => {
  it('should clear all logs', () => {
    const logger = createLogger('test');
    logger.info('Test 1');
    logger.info('Test 2');

    assert.strictEqual(logger.getLogs().length, 2);

    logger.clearLogs();

    assert.strictEqual(logger.getLogs().length, 0);
  });

  it('should return logger for chaining', () => {
    const logger = createLogger('test');
    const result = logger.clearLogs();

    assert.strictEqual(result, logger);
  });
});

describe('logger.child', () => {
  it('should create child logger with extended context', () => {
    const parent = createLogger('parent');
    const child = parent.child('child');

    child.info('Test');

    const logs = child.getLogs();
    assert.strictEqual(logs[0].context, 'parent:child');
  });

  it('should have independent log storage', () => {
    const parent = createLogger('parent');
    const child = parent.child('child');

    parent.info('Parent message');
    child.info('Child message');

    assert.strictEqual(parent.getLogs().length, 1);
    assert.strictEqual(child.getLogs().length, 1);
  });
});

describe('logger.timed', () => {
  it('should log timing for successful operations', async () => {
    const logger = createLogger('test');

    const result = await logger.timed('Test operation', async () => {
      return 'success';
    });

    assert.strictEqual(result, 'success');

    const logs = logger.getLogs();
    // Should have debug "Starting" and info "Completed"
    assert.ok(logs.length >= 1);
    assert.ok(logs.some(l => l.message.includes('Completed')));
  });

  it('should log timing for failed operations', async () => {
    const logger = createLogger('test');

    await assert.rejects(async () => {
      await logger.timed('Failing operation', async () => {
        throw new Error('Test error');
      });
    });

    const logs = logger.getLogs();
    assert.ok(logs.some(l => l.level === 'ERROR'));
  });

  it('should include duration in completed logs', async () => {
    const logger = createLogger('test');

    await logger.timed('Timed op', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return true;
    });

    const logs = logger.getLogs();
    const completedLog = logs.find(l => l.message.includes('Completed'));

    assert.ok(completedLog);
    assert.ok((completedLog?.data as { durationMs: number })?.durationMs >= 10);
  });
});

describe('getLogLevels', () => {
  it('should return array of log levels', () => {
    const levels = getLogLevels();

    assert.ok(Array.isArray(levels));
    assert.ok(levels.includes('DEBUG'));
    assert.ok(levels.includes('INFO'));
    assert.ok(levels.includes('WARN'));
    assert.ok(levels.includes('ERROR'));
  });
});

describe('getCurrentLogLevel', () => {
  it('should return current log level', () => {
    const level = getCurrentLogLevel();

    assert.ok(['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level));
  });
});
