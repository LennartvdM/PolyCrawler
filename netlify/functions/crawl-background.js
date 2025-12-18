/**
 * Netlify Background Function: Full crawl with 15-minute timeout
 *
 * This function handles complete crawls without time pressure.
 * Results are stored in Netlify Blobs for later retrieval.
 *
 * Usage:
 * 1. POST /api/crawl-background to start a crawl (returns job ID immediately)
 * 2. GET /api/crawl-background?jobId=xxx to check status/get results
 */

import { getStore } from '@netlify/blobs';
import {
  getCachedResult,
  setCachedResult,
  getCelebrityData,
  normalizeName,
  findSimilarPerson,
  withRetry,
  extractBirthDateWithConfidence,
  deduplicatePeople
} from './lib/utils.js';

const JOBS_STORE = 'crawl-jobs';

export default async (request, context) => {
  const store = getStore(JOBS_STORE);

  // GET: Check job status
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');

    if (!jobId) {
      // List recent jobs
      const jobs = await listRecentJobs(store);
      return jsonResponse({ success: true, jobs });
    }

    const job = await store.get(jobId, { type: 'json' });
    if (!job) {
      return jsonResponse({ success: false, error: 'Job not found' }, 404);
    }

    return jsonResponse({ success: true, job });
  }

  // POST: Start new background crawl
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const limit = body.limit || 100;
    const topN = body.top || 10;

    const jobId = `crawl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Store initial job status
    await store.setJSON(jobId, {
      id: jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      config: { limit, topN },
      progress: { phase: 'starting', percent: 0 }
    });

    // Start background processing (async, returns immediately)
    runFullCrawl(jobId, limit, topN, store).catch(async (error) => {
      await store.setJSON(jobId, {
        id: jobId,
        status: 'failed',
        error: error.message,
        failedAt: new Date().toISOString()
      });
    });

    return jsonResponse({
      success: true,
      jobId,
      message: 'Background crawl started. Poll for status using GET /api/crawl-background?jobId=' + jobId
    }, 202);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
};

/**
 * Run the full crawl in the background
 */
async function runFullCrawl(jobId, limit, topN, store) {
  const updateProgress = async (phase, percent, details = {}) => {
    const current = await store.get(jobId, { type: 'json' });
    await store.setJSON(jobId, {
      ...current,
      progress: { phase, percent, ...details },
      updatedAt: new Date().toISOString()
    });
  };

  try {
    // Phase 1: Fetch markets
    await updateProgress('fetching-markets', 5);
    const { markets, people, lastFetchTime } = await fetchMarketsAndPeople(limit, topN);
    await updateProgress('markets-fetched', 20, {
      marketsCount: markets.length,
      peopleCount: people.length
    });

    // Phase 2: Look up all people (no batching limits!)
    const wikiResults = new Map();
    const total = people.length;

    for (let i = 0; i < people.length; i++) {
      const person = people[i];
      const result = await lookupPersonOptimized(person.name);
      wikiResults.set(person.nameKey, result);

      // Update progress every 5 lookups
      if (i % 5 === 0 || i === total - 1) {
        const percent = 20 + Math.round((i / total) * 70);
        await updateProgress('looking-up', percent, {
          completed: i + 1,
          total,
          lastLookedUp: person.name
        });
      }

      // Small delay to be nice to Wikipedia
      if (i < total - 1) {
        await sleep(100);
      }
    }

    // Phase 3: Build results
    await updateProgress('building-results', 95);
    const results = [];

    for (const person of people) {
      const wikiResult = wikiResults.get(person.nameKey);
      for (const market of person.markets) {
        results.push({
          marketTitle: market.title,
          marketSlug: market.slug,
          eventTitle: market.eventTitle,
          marketConditionId: market.conditionId,
          marketVolume: market.volume,
          marketEndDate: market.endDate,
          personName: person.name,
          probability: market.probability,
          nameSource: market.source,
          ...(wikiResult || { found: false, status: 'Error' })
        });
      }
    }

    // Calculate stats
    const stats = {
      totalMarkets: markets.length,
      totalPeople: results.length,
      uniquePeople: people.length,
      birthDatesFound: results.filter(r => r.birthDate).length,
      wikipediaNotFound: results.filter(r => !r.found).length,
      birthDateMissing: results.filter(r => r.found && !r.birthDate).length,
      cacheHits: [...wikiResults.values()].filter(r => r.source === 'celebrity-db' || r.source === 'cache').length,
      wikiFetches: [...wikiResults.values()].filter(r => r.source === 'wikipedia').length
    };

    // Store completed job
    await store.setJSON(jobId, {
      id: jobId,
      status: 'completed',
      startedAt: (await store.get(jobId, { type: 'json' })).startedAt,
      completedAt: new Date().toISOString(),
      config: { limit, topN },
      stats,
      results,
      lastFetchTime
    });

  } catch (error) {
    await store.setJSON(jobId, {
      id: jobId,
      status: 'failed',
      error: error.message,
      stack: error.stack,
      failedAt: new Date().toISOString()
    });
  }
}

/**
 * List recent jobs (last 10)
 */
async function listRecentJobs(store) {
  try {
    const { blobs } = await store.list();
    const jobs = [];

    for (const blob of blobs.slice(0, 10)) {
      const job = await store.get(blob.key, { type: 'json' });
      if (job) {
        // Don't include full results in list
        jobs.push({
          id: job.id,
          status: job.status,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          progress: job.progress,
          stats: job.stats
        });
      }
    }

    return jobs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  } catch {
    return [];
  }
}

// ============ Shared functions (same as crawl.js) ============

async function lookupPersonOptimized(name) {
  const celebData = getCelebrityData(name);
  if (celebData) return celebData;

  const cached = await getCachedResult(name);
  if (cached) return cached;

  const result = await fetchFromWikipediaWithRetry(name);
  if (result) {
    await setCachedResult(name, result);
  }

  return result;
}

async function fetchFromWikipediaWithRetry(name) {
  return withRetry(
    () => fetchFromWikipedia(name),
    {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 10000
    }
  ).catch(error => ({
    found: false,
    status: `Error: ${error.message}`,
    source: 'wikipedia-error'
  }));
}

async function fetchFromWikipedia(name) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=5&format=json&origin=*`;

  const searchResponse = await fetch(searchUrl, {
    headers: { 'User-Agent': 'PolyCheck/1.1 (Horoscope research)' }
  });

  if (!searchResponse.ok) {
    throw new Error(`Wikipedia search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();
  const results = searchData.query?.search || [];

  if (results.length === 0) {
    return { found: false, status: 'Wikipedia page not found', source: 'wikipedia' };
  }

  const nameLower = name.toLowerCase();
  let title = results[0].title;
  for (const result of results) {
    if (result.title.toLowerCase().includes(nameLower)) {
      title = result.title;
      break;
    }
  }

  const contentUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*`;

  const contentResponse = await fetch(contentUrl, {
    headers: { 'User-Agent': 'PolyCheck/1.1 (Horoscope research)' }
  });

  if (!contentResponse.ok) {
    throw new Error('Wikipedia content fetch failed');
  }

  const contentData = await contentResponse.json();
  const pages = contentData.query?.pages || {};

  let wikitext = null;
  for (const pageId in pages) {
    if (pageId !== '-1') {
      wikitext = pages[pageId].revisions?.[0]?.slots?.main?.['*'];
      break;
    }
  }

  if (!wikitext) {
    return { found: false, status: 'Wikipedia page not found', source: 'wikipedia' };
  }

  const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const birthInfo = extractBirthDateWithConfidence(wikitext);

  if (birthInfo) {
    return {
      found: true,
      wikipediaUrl,
      birthDate: birthInfo.formatted,
      birthDateRaw: birthInfo.raw,
      confidence: birthInfo.confidence,
      status: 'Found',
      source: 'wikipedia'
    };
  }

  return {
    found: true,
    wikipediaUrl,
    birthDate: null,
    birthDateRaw: null,
    confidence: 0,
    status: 'Birth date not found on Wikipedia',
    source: 'wikipedia'
  };
}

async function fetchMarketsAndPeople(limit, topN) {
  const allMarkets = [];
  const lastFetchTime = new Date().toISOString();

  // Fetch events
  try {
    const eventsUrl = `https://gamma-api.polymarket.com/events?limit=${limit}&active=true&closed=false`;
    const eventsResponse = await fetch(eventsUrl, {
      headers: { 'User-Agent': 'PolyCheck/1.1' }
    });

    if (eventsResponse.ok) {
      const events = await eventsResponse.json();
      for (const event of events) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const market of event.markets) {
            market._source = 'events';
            market._eventSlug = event.slug;
            market._eventTitle = event.title || event.question || null;
            allMarkets.push(market);
          }
        }
      }
    }
  } catch { /* continue */ }

  // Fetch markets
  const apiUrl = `https://gamma-api.polymarket.com/markets?limit=${Math.max(limit, 100)}&active=true&closed=false`;
  const marketResponse = await fetch(apiUrl, {
    headers: { 'User-Agent': 'PolyCheck/1.1' }
  });

  if (!marketResponse.ok) {
    throw new Error(`Polymarket API error: ${marketResponse.status}`);
  }

  const rawMarkets = await marketResponse.json();
  const existingSlugs = new Set(allMarkets.map(m => m.slug));

  for (const market of rawMarkets) {
    if (!existingSlugs.has(market.slug)) {
      market._source = 'markets';
      allMarkets.push(market);
    }
  }

  // Extract people
  const markets = [];
  let peopleList = [];

  for (const market of allMarkets) {
    const processed = extractPeopleFromMarket(market, topN);
    if (processed.people.length > 0) {
      markets.push(processed);

      for (const person of processed.people) {
        const match = findSimilarPerson(person.name, peopleList, 75);

        if (!match) {
          peopleList.push({
            name: person.name,
            nameKey: normalizeName(person.name),
            markets: [{
              title: processed.title,
              slug: processed.slug,
              eventTitle: processed.eventTitle,
              conditionId: processed.conditionId,
              volume: processed.volume,
              endDate: processed.endDate,
              probability: person.probability,
              source: person.source
            }]
          });
        } else {
          if (person.name.length > match.person.name.length) {
            match.person.name = person.name;
            match.person.nameKey = normalizeName(person.name);
          }
          match.person.markets.push({
            title: processed.title,
            slug: processed.slug,
            eventTitle: processed.eventTitle,
            conditionId: processed.conditionId,
            volume: processed.volume,
            endDate: processed.endDate,
            probability: person.probability,
            source: person.source
          });
        }
      }
    }
  }

  peopleList = deduplicatePeople(peopleList, 75);
  return { markets, people: peopleList, lastFetchTime };
}

function extractPeopleFromMarket(market, topN) {
  const title = market.question || market.title || 'Unknown';
  const slug = market._eventSlug || market.slug || '';
  const eventTitle = market._eventTitle || null;
  const conditionId = market.conditionId || market.condition_id || '';
  const volume = parseFloat(market.volume || 0);
  const endDate = market.endDate || market.end_date_iso || null;

  const people = [];
  const outcomeNames = extractFromOutcomes(market, topN);

  for (const { name, probability } of outcomeNames) {
    if (!isDuplicatePerson(name, people)) {
      people.push({ name, probability, source: 'outcome' });
    }
  }

  const titleNames = extractNamesFromText(title);
  for (const name of titleNames) {
    if (!isDuplicatePerson(name, people)) {
      people.push({ name, probability: null, source: 'title' });
    }
  }

  return { title, slug, eventTitle, conditionId, volume, endDate, people };
}

function isDuplicatePerson(newName, existingPeople) {
  const newLower = newName.toLowerCase().trim();
  const newParts = newLower.split(/\s+/);

  for (const person of existingPeople) {
    const existingLower = person.name.toLowerCase().trim();
    const existingParts = existingLower.split(/\s+/);

    if (newLower === existingLower) return true;

    if (newParts.length === 1) {
      if (existingParts[existingParts.length - 1] === newParts[0]) return true;
      if (existingParts.includes(newParts[0])) return true;
    }

    if (existingParts.length === 1) {
      if (newParts[newParts.length - 1] === existingParts[0]) return true;
      if (newParts.includes(existingParts[0])) return true;
    }

    if (newLower.includes(existingLower) || existingLower.includes(newLower)) {
      return true;
    }
  }

  return false;
}

function extractFromOutcomes(market, topN) {
  let outcomes = [];

  if (market.tokens && market.tokens.length > 0) {
    for (const token of market.tokens) {
      outcomes.push({
        name: token.outcome || '',
        probability: parseFloat(token.price || 0) * 100
      });
    }
  } else if (market.outcomes) {
    let outcomeNames = market.outcomes;
    let prices = market.outcomePrices || [];

    if (typeof outcomeNames === 'string') {
      try { outcomeNames = JSON.parse(outcomeNames); } catch { outcomeNames = []; }
    }
    if (typeof prices === 'string') {
      try { prices = JSON.parse(prices); } catch { prices = []; }
    }

    for (let i = 0; i < outcomeNames.length; i++) {
      outcomes.push({
        name: outcomeNames[i],
        probability: parseFloat(prices[i] || 0) * 100
      });
    }
  }

  const validOutcomes = [];
  for (const outcome of outcomes) {
    const parsedName = parsePersonFromOutcome(outcome.name);
    if (parsedName && isPersonName(parsedName)) {
      validOutcomes.push({ name: parsedName, probability: outcome.probability });
    }
  }

  return validOutcomes;
}

function parsePersonFromOutcome(outcomeStr) {
  if (!outcomeStr) return null;
  let name = outcomeStr;

  if (name.includes(' - ')) {
    name = name.split(' - ')[0].trim();
  }
  name = name.replace(/\s*\([^)]*\)\s*/g, '').trim();

  if (name.includes(', ')) {
    const parts = name.split(', ');
    if (parts[0].split(/\s+/).length >= 2) {
      name = parts[0].trim();
    }
  }

  return name || null;
}

function extractNamesFromText(text) {
  const names = [];
  const knownFigures = [
    'Trump', 'Biden', 'Obama', 'Putin', 'Xi Jinping', 'Zelensky', 'Macron',
    'Musk', 'Bezos', 'Zuckerberg', 'Altman', 'Taylor Swift', 'Beyoncé'
  ];

  for (const figure of knownFigures) {
    const regex = new RegExp(`\\b${escapeRegex(figure)}\\b`, 'i');
    if (regex.test(text)) names.push(figure);
  }

  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    if (isLikelyPersonName(match[1])) names.push(match[1]);
  }

  const seen = new Set();
  return names.filter(name => {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPersonName(name) {
  const nonPersonTerms = new Set([
    'yes', 'no', 'other', 'none', 'neither', 'both', 'will',
    'before', 'after', 'over', 'under', 'between',
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ]);

  const nameLower = name.toLowerCase().trim();
  if (nonPersonTerms.has(nameLower)) return false;
  if (/^[\d,.\s%$€£]+$/.test(name)) return false;
  if (/^\d/.test(name)) return false;

  const parts = name.split(/\s+/);
  if (parts.length < 2) {
    const knownSingleNames = ['trump', 'biden', 'putin', 'musk', 'bezos', 'zelensky', 'macron', 'ye', 'drake'];
    return knownSingleNames.includes(nameLower);
  }

  return true;
}

function isLikelyPersonName(name) {
  const nonPersonPhrases = [
    'united states', 'united kingdom', 'new york', 'los angeles',
    'wall street', 'white house', 'supreme court'
  ];

  const lower = name.toLowerCase();
  if (lower.startsWith('will ') || lower.startsWith('when ')) return false;

  for (const phrase of nonPersonPhrases) {
    if (lower.includes(phrase)) return false;
  }

  return name.split(/\s+/).length <= 4;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const config = {
  path: "/api/crawl-background",
  type: "background"  // 15-minute timeout instead of 10 seconds
};
