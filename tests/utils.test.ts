/**
 * Unit tests for utils module
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  normalizeName,
  nameSimilarity,
  extractBirthDateWithConfidence,
  calculateBatchSize,
  getCelebrityData,
  findSimilarPerson,
  deduplicatePeople
} from '../netlify/functions/lib/utils.js';
import type { Person } from '../netlify/functions/lib/types.js';

describe('normalizeName', () => {
  it('should lowercase names', () => {
    assert.strictEqual(normalizeName('Donald Trump'), 'donald trump');
  });

  it('should trim whitespace', () => {
    assert.strictEqual(normalizeName('  Joe Biden  '), 'joe biden');
  });

  it('should normalize apostrophes', () => {
    assert.strictEqual(normalizeName("O'Brien"), "o'brien");
    assert.strictEqual(normalizeName("O\u2019Brien"), "o'brien");
  });

  it('should normalize multiple spaces', () => {
    assert.strictEqual(normalizeName('John   Doe'), 'john doe');
  });
});

describe('nameSimilarity', () => {
  it('should return 100 for exact matches', () => {
    assert.strictEqual(nameSimilarity('Donald Trump', 'Donald Trump'), 100);
  });

  it('should return 100 for case-insensitive matches', () => {
    assert.strictEqual(nameSimilarity('donald trump', 'DONALD TRUMP'), 100);
  });

  it('should return high score for substring matches', () => {
    const score = nameSimilarity('Trump', 'Donald Trump');
    assert.ok(score >= 70, `Expected >= 70, got ${score}`);
  });

  it('should return score based on word overlap', () => {
    const score = nameSimilarity('Donald John Trump', 'Donald Trump');
    assert.ok(score >= 50, `Expected >= 50, got ${score}`);
  });

  it('should return 0 for completely different names', () => {
    const score = nameSimilarity('John Smith', 'Jane Doe');
    assert.ok(score < 50, `Expected < 50, got ${score}`);
  });
});

describe('extractBirthDateWithConfidence', () => {
  it('should extract from {{birth date and age}} template', () => {
    const wikitext = '{{birth date and age|1946|6|14}}';
    const result = extractBirthDateWithConfidence(wikitext);

    assert.ok(result !== null);
    assert.strictEqual(result?.raw, '1946-06-14');
    assert.strictEqual(result?.confidence, 100);
    assert.strictEqual(result?.source, 'infobox');
  });

  it('should extract from "born Month DD, YYYY" format', () => {
    const wikitext = '(born June 14, 1946)';
    const result = extractBirthDateWithConfidence(wikitext);

    assert.ok(result !== null);
    assert.strictEqual(result?.raw, '1946-06-14');
    assert.strictEqual(result?.confidence, 80);
    assert.strictEqual(result?.source, 'text');
  });

  it('should extract from "born DD Month YYYY" format', () => {
    const wikitext = 'born 14 June 1946';
    const result = extractBirthDateWithConfidence(wikitext);

    assert.ok(result !== null);
    assert.strictEqual(result?.raw, '1946-06-14');
    assert.strictEqual(result?.confidence, 80);
  });

  it('should extract year only from {{birth year and age}}', () => {
    const wikitext = '{{birth year and age|1983}}';
    const result = extractBirthDateWithConfidence(wikitext);

    assert.ok(result !== null);
    assert.strictEqual(result?.raw, '1983');
    assert.strictEqual(result?.confidence, 60);
  });

  it('should extract year from "born in YYYY"', () => {
    const wikitext = 'born in 1985';
    const result = extractBirthDateWithConfidence(wikitext);

    assert.ok(result !== null);
    assert.strictEqual(result?.raw, '1985');
    assert.strictEqual(result?.confidence, 50);
  });

  it('should return null for no birth date', () => {
    const wikitext = 'This is some random text without a birth date.';
    const result = extractBirthDateWithConfidence(wikitext);

    assert.strictEqual(result, null);
  });
});

describe('calculateBatchSize', () => {
  it('should return base batch size for low cache ratio', () => {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    const cached = new Set(['alice']); // 20% cached

    const size = calculateBatchSize(names, cached, 5, 15);
    assert.strictEqual(size, 5);
  });

  it('should return larger batch size for medium cache ratio', () => {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    const cached = new Set(['alice', 'bob', 'charlie']); // 60% cached

    const size = calculateBatchSize(names, cached, 5, 15);
    assert.strictEqual(size, 10);
  });

  it('should return max batch size for high cache ratio', () => {
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    const cached = new Set(['alice', 'bob', 'charlie', 'david']); // 80% cached

    const size = calculateBatchSize(names, cached, 5, 15);
    assert.strictEqual(size, 15);
  });
});

describe('getCelebrityData', () => {
  it('should return data for known celebrities', () => {
    const result = getCelebrityData('Donald Trump');

    assert.ok(result !== null);
    assert.strictEqual(result?.found, true);
    assert.strictEqual(result?.birthDateRaw, '1946-06-14');
    assert.strictEqual(result?.source, 'celebrity-db');
  });

  it('should return data with normalized name', () => {
    const result = getCelebrityData('DONALD TRUMP');

    assert.ok(result !== null);
    assert.strictEqual(result?.found, true);
  });

  it('should return null for unknown people', () => {
    const result = getCelebrityData('Random Unknown Person');

    assert.strictEqual(result, null);
  });

  it('should fuzzy match partial names', () => {
    const result = getCelebrityData('Trump');

    // Should match "Donald Trump" via surname match
    assert.ok(result !== null);
    assert.strictEqual(result?.source, 'celebrity-db');
  });
});

describe('findSimilarPerson', () => {
  const testPeople: Person[] = [
    { name: 'Donald Trump', nameKey: 'donald trump', markets: [] },
    { name: 'Joe Biden', nameKey: 'joe biden', markets: [] },
    { name: 'Barack Obama', nameKey: 'barack obama', markets: [] }
  ];

  it('should find exact matches', () => {
    const result = findSimilarPerson('Donald Trump', testPeople);

    assert.ok(result !== null);
    assert.strictEqual(result?.person.name, 'Donald Trump');
    assert.strictEqual(result?.similarity, 100);
  });

  it('should find case-insensitive matches', () => {
    const result = findSimilarPerson('donald trump', testPeople);

    assert.ok(result !== null);
    assert.strictEqual(result?.person.name, 'Donald Trump');
  });

  it('should return null when no match found', () => {
    const result = findSimilarPerson('Random Person', testPeople);

    assert.strictEqual(result, null);
  });

  it('should respect threshold parameter', () => {
    const result = findSimilarPerson('Trump', testPeople, 90);

    // With 90% threshold, partial match shouldn't work
    assert.strictEqual(result, null);
  });
});

describe('deduplicatePeople', () => {
  it('should deduplicate exact duplicates', () => {
    const people: Person[] = [
      { name: 'Donald Trump', nameKey: 'donald trump', markets: [{ title: 'Market 1', slug: 'm1', eventTitle: null, conditionId: '', volume: 0, endDate: null, probability: null, source: 'outcome' }] },
      { name: 'Donald Trump', nameKey: 'donald trump', markets: [{ title: 'Market 2', slug: 'm2', eventTitle: null, conditionId: '', volume: 0, endDate: null, probability: null, source: 'outcome' }] }
    ];

    const result = deduplicatePeople(people);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].markets.length, 2);
  });

  it('should prefer longer names when deduplicating', () => {
    const people: Person[] = [
      { name: 'Trump', nameKey: 'trump', markets: [] },
      { name: 'Donald Trump', nameKey: 'donald trump', markets: [] }
    ];

    const result = deduplicatePeople(people, 50);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'Donald Trump');
  });

  it('should keep distinct people separate', () => {
    const people: Person[] = [
      { name: 'Donald Trump', nameKey: 'donald trump', markets: [] },
      { name: 'Joe Biden', nameKey: 'joe biden', markets: [] }
    ];

    const result = deduplicatePeople(people);

    assert.strictEqual(result.length, 2);
  });
});
