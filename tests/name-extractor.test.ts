/**
 * Unit tests for name-extractor module
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  extractNamesFromText,
  parsePersonFromOutcome,
  isPersonName,
  expandShortName,
  getKnownFigures
} from '../netlify/functions/lib/name-extractor.js';

describe('extractNamesFromText', () => {
  it('should extract known political figures', () => {
    const text = 'Will Donald Trump win the 2024 election against Joe Biden?';
    const names = extractNamesFromText(text);

    assert.ok(names.includes('Donald Trump'));
    assert.ok(names.includes('Joe Biden'));
  });

  it('should extract tech leaders', () => {
    const text = 'Elon Musk vs Mark Zuckerberg cage match prediction';
    const names = extractNamesFromText(text);

    assert.ok(names.includes('Elon Musk'));
    assert.ok(names.includes('Mark Zuckerberg'));
  });

  it('should extract entertainment figures', () => {
    const text = 'Will Taylor Swift announce a new tour?';
    const names = extractNamesFromText(text);

    assert.ok(names.includes('Taylor Swift'));
  });

  it('should not include non-person terms', () => {
    const text = 'Yes or No, will this happen in January?';
    const names = extractNamesFromText(text);

    assert.ok(!names.some(n => n.toLowerCase() === 'yes'));
    assert.ok(!names.some(n => n.toLowerCase() === 'no'));
    assert.ok(!names.some(n => n.toLowerCase() === 'january'));
  });

  it('should not extract location names', () => {
    const text = 'What will happen in New York and United States?';
    const names = extractNamesFromText(text);

    assert.ok(!names.some(n => n.toLowerCase().includes('new york')));
    assert.ok(!names.some(n => n.toLowerCase().includes('united states')));
  });

  it('should deduplicate names', () => {
    const text = 'Donald Trump said Trump will win, according to Donald Trump';
    const names = extractNamesFromText(text);

    const trumpCount = names.filter(n => n.toLowerCase().includes('trump')).length;
    assert.strictEqual(trumpCount, 1);
  });
});

describe('parsePersonFromOutcome', () => {
  it('should extract name from simple outcome', () => {
    const result = parsePersonFromOutcome('Donald Trump');
    assert.strictEqual(result, 'Donald Trump');
  });

  it('should remove company/title after dash', () => {
    const result = parsePersonFromOutcome('Elon Musk - Tesla CEO');
    assert.strictEqual(result, 'Elon Musk');
  });

  it('should remove parentheticals', () => {
    const result = parsePersonFromOutcome('Joe Biden (D)');
    assert.strictEqual(result, 'Joe Biden');
  });

  it('should remove title after comma', () => {
    const result = parsePersonFromOutcome('Tim Cook, Apple CEO');
    assert.strictEqual(result, 'Tim Cook');
  });

  it('should return null for non-person outcomes', () => {
    const result = parsePersonFromOutcome('Yes');
    assert.strictEqual(result, null);
  });

  it('should return null for empty input', () => {
    const result = parsePersonFromOutcome('');
    assert.strictEqual(result, null);
  });

  it('should return null for numeric outcomes', () => {
    const result = parsePersonFromOutcome('$100,000');
    assert.strictEqual(result, null);
  });
});

describe('isPersonName', () => {
  it('should return true for full names', () => {
    assert.strictEqual(isPersonName('John Smith'), true);
    assert.strictEqual(isPersonName('Jane Doe'), true);
  });

  it('should return true for known single names', () => {
    assert.strictEqual(isPersonName('Trump'), true);
    assert.strictEqual(isPersonName('Biden'), true);
  });

  it('should return false for non-person terms', () => {
    assert.strictEqual(isPersonName('Yes'), false);
    assert.strictEqual(isPersonName('No'), false);
    assert.strictEqual(isPersonName('January'), false);
  });

  it('should return false for numbers', () => {
    assert.strictEqual(isPersonName('100'), false);
    assert.strictEqual(isPersonName('$50,000'), false);
  });

  it('should return false for question starts', () => {
    assert.strictEqual(isPersonName('Will Smith'), true); // Actually a person
    // But these patterns should fail:
    assert.strictEqual(isPersonName('Will the market'), false);
  });
});

describe('expandShortName', () => {
  it('should expand known abbreviations', () => {
    assert.strictEqual(expandShortName('aoc'), 'Alexandria Ocasio-Cortez');
    assert.strictEqual(expandShortName('rfk'), 'Robert F Kennedy Jr');
    assert.strictEqual(expandShortName('sbf'), 'Sam Bankman-Fried');
  });

  it('should expand single names', () => {
    assert.strictEqual(expandShortName('musk'), 'Elon Musk');
    assert.strictEqual(expandShortName('trump'), 'Donald Trump');
  });

  it('should return null for unknown names', () => {
    assert.strictEqual(expandShortName('xyz'), null);
    assert.strictEqual(expandShortName('unknown'), null);
  });

  it('should be case-insensitive', () => {
    assert.strictEqual(expandShortName('AOC'), 'Alexandria Ocasio-Cortez');
    assert.strictEqual(expandShortName('TRUMP'), 'Donald Trump');
  });
});

describe('getKnownFigures', () => {
  it('should return array of known figures', () => {
    const figures = getKnownFigures();

    assert.ok(Array.isArray(figures));
    assert.ok(figures.length > 50);
  });

  it('should include major political figures', () => {
    const figures = getKnownFigures();

    assert.ok(figures.includes('Donald Trump'));
    assert.ok(figures.includes('Joe Biden'));
    assert.ok(figures.includes('Vladimir Putin'));
  });

  it('should include tech leaders', () => {
    const figures = getKnownFigures();

    assert.ok(figures.includes('Elon Musk'));
    assert.ok(figures.includes('Sam Altman'));
    assert.ok(figures.includes('Mark Zuckerberg'));
  });
});
