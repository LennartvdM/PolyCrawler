/**
 * Shared utilities for PolyCrawler
 * - Netlify Blobs caching
 * - Celebrity database lookup
 * - Fuzzy name matching
 * - Retry with exponential backoff
 * - Confidence scoring
 */

import { getStore } from '@netlify/blobs';
import celebrities from '../data/celebrities.json' with { type: 'json' };

// Cache settings
const CACHE_STORE_NAME = 'wiki-cache';
const CACHE_TTL_DAYS = 30; // Cache birth dates for 30 days

/**
 * Get a cached Wikipedia result from Netlify Blobs
 */
export async function getCachedResult(name) {
  try {
    const store = getStore(CACHE_STORE_NAME);
    const key = normalizeName(name);
    const cached = await store.get(key, { type: 'json' });

    if (cached) {
      // Check if cache is still valid
      const cachedAt = new Date(cached.cachedAt);
      const now = new Date();
      const daysSinceCached = (now - cachedAt) / (1000 * 60 * 60 * 24);

      if (daysSinceCached < CACHE_TTL_DAYS) {
        return { ...cached, source: 'cache' };
      }
    }
    return null;
  } catch (error) {
    // Blobs might not be available in local dev
    console.warn('Cache read failed:', error.message);
    return null;
  }
}

/**
 * Store a Wikipedia result in Netlify Blobs cache
 */
export async function setCachedResult(name, result) {
  try {
    const store = getStore(CACHE_STORE_NAME);
    const key = normalizeName(name);
    await store.setJSON(key, {
      ...result,
      cachedAt: new Date().toISOString()
    });
    return true;
  } catch (error) {
    console.warn('Cache write failed:', error.message);
    return false;
  }
}

/**
 * Look up a name in the pre-computed celebrity database
 */
export function getCelebrityData(name) {
  const normalized = normalizeName(name);
  const celeb = celebrities.celebrities[normalized];

  if (celeb) {
    return {
      found: true,
      birthDate: celeb.birthDate,
      birthDateRaw: celeb.birthDateRaw,
      wikipediaUrl: celeb.wikipediaUrl,
      confidence: celeb.confidence,
      status: 'Found',
      source: 'celebrity-db'
    };
  }

  // Try fuzzy match against celebrity names
  const match = fuzzyMatchCelebrity(normalized);
  if (match) {
    const matchedCeleb = celebrities.celebrities[match];
    return {
      found: true,
      birthDate: matchedCeleb.birthDate,
      birthDateRaw: matchedCeleb.birthDateRaw,
      wikipediaUrl: matchedCeleb.wikipediaUrl,
      confidence: matchedCeleb.confidence,
      status: 'Found',
      source: 'celebrity-db',
      matchedAs: match
    };
  }

  return null;
}

/**
 * Fuzzy match against celebrity database
 */
function fuzzyMatchCelebrity(name) {
  const nameParts = name.split(/\s+/);

  for (const celebName of Object.keys(celebrities.celebrities)) {
    const celebParts = celebName.split(/\s+/);

    // Single name matches surname
    if (nameParts.length === 1) {
      if (celebParts[celebParts.length - 1] === nameParts[0]) {
        return celebName;
      }
    }

    // Check if input contains celebrity name or vice versa
    if (name.includes(celebName) || celebName.includes(name)) {
      return celebName;
    }

    // Check if last names match and first initial matches
    if (nameParts.length >= 2 && celebParts.length >= 2) {
      const nameLastName = nameParts[nameParts.length - 1];
      const celebLastName = celebParts[celebParts.length - 1];

      if (nameLastName === celebLastName) {
        // Check first initial
        if (nameParts[0][0] === celebParts[0][0]) {
          return celebName;
        }
      }
    }
  }

  return null;
}

/**
 * Normalize a name for consistent lookups
 */
export function normalizeName(name) {
  return name.toLowerCase().trim()
    .replace(/['']/g, "'")  // Normalize apostrophes
    .replace(/\s+/g, ' ');  // Normalize whitespace
}

/**
 * Calculate similarity score between two names (0-100)
 * Uses a combination of techniques: exact match, substring, word overlap
 */
export function nameSimilarity(name1, name2) {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);

  // Exact match
  if (n1 === n2) return 100;

  // One contains the other
  if (n1.includes(n2) || n2.includes(n1)) {
    const shorter = n1.length < n2.length ? n1 : n2;
    const longer = n1.length >= n2.length ? n1 : n2;
    return Math.round((shorter.length / longer.length) * 90);
  }

  // Word overlap
  const words1 = new Set(n1.split(/\s+/));
  const words2 = new Set(n2.split(/\s+/));
  const intersection = [...words1].filter(w => words2.has(w));
  const union = new Set([...words1, ...words2]);

  if (intersection.length > 0) {
    // Jaccard similarity scaled to 0-80
    return Math.round((intersection.length / union.size) * 80);
  }

  // Levenshtein-based similarity for short names
  if (n1.length < 20 && n2.length < 20) {
    const distance = levenshteinDistance(n1, n2);
    const maxLen = Math.max(n1.length, n2.length);
    const similarity = Math.round((1 - distance / maxLen) * 70);
    return Math.max(0, similarity);
  }

  return 0;
}

/**
 * Levenshtein distance between two strings
 */
function levenshteinDistance(s1, s2) {
  const m = s1.length;
  const n = s2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Find existing person in list using fuzzy matching
 * Returns the person if similarity >= threshold
 */
export function findSimilarPerson(name, peopleList, threshold = 70) {
  const normalized = normalizeName(name);

  for (const person of peopleList) {
    const similarity = nameSimilarity(normalized, person.nameKey);
    if (similarity >= threshold) {
      return { person, similarity };
    }
  }

  return null;
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    shouldRetry = (error) => true,
    onRetry = () => {}
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      onRetry(attempt + 1, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate confidence score for a birth date extraction
 * 100 = full date from infobox
 * 80 = full date from text pattern
 * 60 = year only
 * 0 = not found
 */
export function calculateConfidence(birthInfo, source) {
  if (!birthInfo) return 0;

  // Check if we have full date (YYYY-MM-DD)
  const hasFullDate = birthInfo.raw && /^\d{4}-\d{2}-\d{2}$/.test(birthInfo.raw);

  if (hasFullDate) {
    // Infobox patterns are most reliable
    if (source === 'infobox') return 100;
    // Text patterns are slightly less reliable
    if (source === 'text') return 80;
    return 90;
  }

  // Year only
  if (birthInfo.raw && /^\d{4}$/.test(birthInfo.raw)) {
    return 60;
  }

  return 50; // Partial info
}

/**
 * Extract birth date with confidence scoring
 */
export function extractBirthDateWithConfidence(wikitext) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  // Pattern 1: {{birth date and age|YYYY|MM|DD}} - Most reliable
  let match = wikitext.match(/\{\{[Bb]irth date(?: and age)?\|(\d{4})\|(\d{1,2})\|(\d{1,2})/);
  if (match) {
    const [_, year, month, day] = match;
    return {
      formatted: `${months[parseInt(month) - 1]} ${parseInt(day)}, ${year}`,
      raw: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      confidence: 100,
      source: 'infobox'
    };
  }

  // Pattern 2: birth_date = {{birth date and age|...}}
  match = wikitext.match(/birth_date\s*=\s*\{\{[^|]+\|(\d{4})\|(\d{1,2})\|(\d{1,2})/i);
  if (match) {
    const [_, year, month, day] = match;
    return {
      formatted: `${months[parseInt(month) - 1]} ${parseInt(day)}, ${year}`,
      raw: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      confidence: 100,
      source: 'infobox'
    };
  }

  // Pattern 3: "born January 22, 1962"
  match = wikitext.match(/\(?\s*born\s+([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const [_, monthName, day, year] = match;
    const monthIndex = months.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
    if (monthIndex !== -1) {
      return {
        formatted: `${monthName} ${parseInt(day)}, ${year}`,
        raw: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`,
        confidence: 80,
        source: 'text'
      };
    }
  }

  // Pattern 4: "born 22 January 1962"
  match = wikitext.match(/born\s+(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/);
  if (match) {
    const [_, day, monthName, year] = match;
    const monthIndex = months.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
    if (monthIndex !== -1) {
      return {
        formatted: `${monthName} ${parseInt(day)}, ${year}`,
        raw: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`,
        confidence: 80,
        source: 'text'
      };
    }
  }

  // Pattern 5: {{birth year and age|YYYY}}
  match = wikitext.match(/\{\{[Bb]irth year(?: and age)?\|(\d{4})/);
  if (match) {
    return {
      formatted: `${match[1]} (year only)`,
      raw: match[1],
      confidence: 60,
      source: 'infobox-year'
    };
  }

  // Pattern 6: "born in YYYY" or "born circa YYYY"
  match = wikitext.match(/born\s+(?:in\s+|circa\s+|c\.\s*)?(\d{4})/i);
  if (match) {
    return {
      formatted: `${match[1]} (year only)`,
      raw: match[1],
      confidence: 50,
      source: 'text-year'
    };
  }

  return null;
}

/**
 * Smart batch sizing based on cache hits
 * Returns larger batches when many names are cached
 */
export function calculateBatchSize(names, cachedNames, baseBatchSize = 5, maxBatchSize = 15) {
  const cachedCount = names.filter(n => cachedNames.has(normalizeName(n))).length;
  const cacheRatio = cachedCount / names.length;

  // If most names are cached, we can handle larger batches
  if (cacheRatio >= 0.8) return maxBatchSize;
  if (cacheRatio >= 0.5) return Math.min(baseBatchSize * 2, maxBatchSize);
  return baseBatchSize;
}

/**
 * Deduplicate people list with fuzzy matching
 * Keeps the most complete name for each person
 */
export function deduplicatePeople(peopleList, threshold = 70) {
  const deduped = [];

  for (const person of peopleList) {
    const match = findSimilarPerson(person.name, deduped, threshold);

    if (match) {
      // Prefer the longer/more complete name
      if (person.name.length > match.person.name.length) {
        match.person.name = person.name;
        match.person.nameKey = normalizeName(person.name);
      }
      // Merge markets
      match.person.markets = [...match.person.markets, ...person.markets];
    } else {
      deduped.push({
        name: person.name,
        nameKey: normalizeName(person.name),
        markets: [...person.markets]
      });
    }
  }

  return deduped;
}
