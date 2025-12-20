/**
 * Netlify Function: Optimized chunked crawl with caching
 *
 * Features:
 * - Netlify Blobs caching for Wikipedia results
 * - Pre-computed celebrity database for instant lookups
 * - Birthdate registry for persistent high-confidence results
 * - Misses registry for tracking lookup failures (duds)
 * - Fuzzy name matching and deduplication
 * - Retry with exponential backoff
 * - Confidence scoring for birth dates
 * - Smart dynamic batching
 * - Incremental crawl support
 * - Rate limiting for Wikipedia API
 *
 * Phases:
 * - markets: Fetch markets and extract people (returns list to look up)
 * - lookup: Look up batch of people on Wikipedia (with caching)
 * - cache-status: Check cache status for names
 * - misses: List entities where birthdate lookup failed (duds)
 */

import {
  getCachedResult,
  setCachedResult,
  getCelebrityData,
  normalizeName,
  findSimilarPerson,
  withRetry,
  extractBirthDateWithConfidence,
  calculateBatchSize,
  deduplicatePeople
} from './lib/utils.js';
import { createLogger } from './lib/logger.js';
import { validateConfig } from './lib/config.js';
import { withWikipediaRateLimit, getWikipediaLimiter } from './lib/rate-limiter.js';
import {
  getFromRegistry,
  addToRegistry,
  getRegistryStats,
  resetRegistryStats,
  getRegistrySize,
  qualifiesForRegistry
} from './lib/registry-client.js';
import {
  checkMissesRegistry,
  addToMissesRegistry,
  listMisses,
  getMissesStats,
  getMissesRequestStats,
  resetMissesStats,
  detectEntityType
} from './lib/misses-registry.js';

// Validate configuration on startup
validateConfig();

export default async (request, context) => {
  const logger = createLogger('crawl');

  // Reset stats for this request
  resetRegistryStats();
  resetMissesStats();

  // Legacy log function for backwards compatibility with response format
  const log = (level, message, data = null) => {
    const logFn = level === 'ERROR' ? logger.error :
                  level === 'WARN' ? logger.warn :
                  level === 'DEBUG' ? logger.debug : logger.info;
    logFn.call(logger, message, data);
  };

  const url = new URL(request.url);
  const phase = url.searchParams.get('phase') || 'full';
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const topN = parseInt(url.searchParams.get('top')) || 4;
  const incrementalSince = url.searchParams.get('since'); // ISO date for incremental crawls
  const category = url.searchParams.get('category') || ''; // Category filter (e.g., politics, sports, crypto)
  const sortBy = url.searchParams.get('sort') || ''; // Sort order (liquidity, volume, startDate, endDate, competitive)
  const timeWindow = url.searchParams.get('time') || 'weekly'; // For leaderboard: today, weekly, monthly, all

  try {
    // Phase: Check cache status for names (helps frontend optimize batching)
    if (phase === 'cache-status') {
      const namesParam = url.searchParams.get('names');
      if (!namesParam) {
        return jsonResponse({ success: false, error: 'Missing names parameter' }, 400);
      }

      const names = JSON.parse(namesParam);
      const cacheStatus = await Promise.all(
        names.map(async (name) => {
          // Check celebrity DB first
          const celebData = getCelebrityData(name);
          if (celebData) {
            return { name, cached: true, source: 'celebrity-db' };
          }

          // Check birthdate registry (persistent, high-confidence)
          const registryData = await getFromRegistry(name);
          if (registryData) {
            return { name, cached: true, source: 'registry' };
          }

          // Check Blobs cache (30-day TTL)
          const cached = await getCachedResult(name);
          if (cached) {
            return { name, cached: true, source: 'blob-cache' };
          }

          return { name, cached: false };
        })
      );

      const cachedCount = cacheStatus.filter(s => s.cached).length;
      const registryCount = cacheStatus.filter(s => s.source === 'registry').length;
      log('INFO', 'Cache status checked', { total: names.length, cached: cachedCount, fromRegistry: registryCount });

      return jsonResponse({
        success: true,
        phase: 'cache-status',
        cacheStatus,
        summary: {
          total: names.length,
          cached: cachedCount,
          uncached: names.length - cachedCount,
          fromRegistry: registryCount
        },
        registryStats: getRegistryStats(),
        logs: logger.getLogs()
      });
    }

    // Phase: List misses (duds) - entities where we couldn't find birthdates
    if (phase === 'misses') {
      const reasonFilter = url.searchParams.get('reason');
      const entityTypeFilter = url.searchParams.get('entityType');
      const unresolvedOnly = url.searchParams.get('unresolvedOnly') === 'true';
      const missesLimit = parseInt(url.searchParams.get('limit')) || 100;

      log('INFO', 'Fetching misses list', { reasonFilter, entityTypeFilter, unresolvedOnly, limit: missesLimit });

      const [misses, stats] = await Promise.all([
        listMisses({
          limit: missesLimit,
          reason: reasonFilter || undefined,
          entityType: entityTypeFilter || undefined,
          unresolvedOnly
        }),
        getMissesStats()
      ]);

      log('INFO', 'Misses fetched', { count: misses.length, totalInRegistry: stats.totalMisses });

      return jsonResponse({
        success: true,
        phase: 'misses',
        misses,
        stats,
        logs: logger.getLogs()
      });
    }

    // Phase: Event lookup by URL/slug
    if (phase === 'event') {
      const eventSlug = url.searchParams.get('slug');
      if (!eventSlug) {
        return jsonResponse({ success: false, error: 'Missing slug parameter' }, 400);
      }

      log('INFO', 'Event lookup by slug', { slug: eventSlug });

      try {
        // Fetch the specific event from Polymarket API
        const eventUrl = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`;
        const eventResponse = await fetch(eventUrl, {
          headers: { 'User-Agent': 'PolyCheck/1.2' }
        });

        if (!eventResponse.ok) {
          throw new Error(`Polymarket API error: ${eventResponse.status}`);
        }

        const events = await eventResponse.json();

        if (!events || events.length === 0) {
          return jsonResponse({
            success: false,
            error: 'Event not found',
            slug: eventSlug,
            logs: logger.getLogs()
          }, 404);
        }

        const event = events[0];
        log('INFO', 'Event found', {
          title: event.title || event.question,
          marketsCount: event.markets?.length || 0
        });

        // Extract people from all markets in this event
        let peopleList = [];
        const markets = [];

        if (event.markets && Array.isArray(event.markets)) {
          for (const market of event.markets) {
            market._eventSlug = event.slug;
            market._eventTitle = event.title || event.question || null;

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
        }

        // Deduplicate people
        peopleList = deduplicatePeople(peopleList, 75);

        log('INFO', 'People extracted from event', {
          marketsWithPeople: markets.length,
          uniquePeople: peopleList.length
        });

        // Look up all people immediately (since this is a focused lookup)
        const results = await Promise.all(
          peopleList.map(async (person) => {
            const result = await lookupPersonOptimized(person.name, log);
            return {
              name: person.name,
              nameKey: person.nameKey,
              markets: person.markets,
              ...result
            };
          })
        );

        // Build final results matching the expected format
        const finalResults = [];
        for (const person of results) {
          for (const market of person.markets) {
            finalResults.push({
              marketTitle: market.title,
              marketSlug: market.slug,
              eventTitle: market.eventTitle,
              marketConditionId: market.conditionId,
              marketVolume: market.volume,
              marketEndDate: market.endDate,
              personName: person.name,
              probability: market.probability,
              nameSource: market.source,
              found: person.found,
              status: person.status,
              birthDate: person.birthDate,
              birthDateRaw: person.birthDateRaw,
              confidence: person.confidence,
              wikipediaUrl: person.wikipediaUrl,
              source: person.source
            });
          }
        }

        const stats = {
          totalMarkets: markets.length,
          totalPeople: finalResults.length,
          uniquePeople: peopleList.length,
          birthDatesFound: finalResults.filter(r => r.birthDate).length,
          wikipediaNotFound: finalResults.filter(r => !r.found).length,
          birthDateMissing: finalResults.filter(r => r.found && !r.birthDate).length
        };

        log('INFO', 'Event lookup completed', stats);

        return jsonResponse({
          success: true,
          phase: 'event',
          event: {
            title: event.title || event.question,
            slug: event.slug,
            description: event.description,
            startDate: event.startDate,
            endDate: event.endDate
          },
          stats,
          results: finalResults,
          registryStats: getRegistryStats(),
          logs: logger.getLogs()
        });

      } catch (error) {
        log('ERROR', 'Event lookup failed', { error: error.message });
        return jsonResponse({
          success: false,
          error: error.message,
          slug: eventSlug,
          logs: logger.getLogs()
        }, 500);
      }
    }

    // Phase 1: Fetch markets and extract people
    if (phase === 'markets') {
      log('INFO', 'Phase 1: Fetching markets', { limit, topN, incrementalSince, category: category || 'all', sort: sortBy || 'default' });
      const { markets, people, lastFetchTime } = await fetchMarketsAndPeople(limit, topN, log, incrementalSince, category, sortBy);

      // Pre-check cache status for smart batching hints
      const cachedNames = new Set();
      let registryHits = 0;

      for (const person of people) {
        const celebData = getCelebrityData(person.name);
        if (celebData) {
          cachedNames.add(person.nameKey);
          continue;
        }

        // Check registry (persistent)
        const registryData = await getFromRegistry(person.name);
        if (registryData) {
          cachedNames.add(person.nameKey);
          registryHits++;
          continue;
        }

        // Check cache (TTL-based)
        const cached = await getCachedResult(person.name);
        if (cached) {
          cachedNames.add(person.nameKey);
        }
      }

      // Get registry size for stats
      const registrySize = await getRegistrySize();

      log('INFO', 'Cache pre-check complete', {
        totalPeople: people.length,
        cachedCount: cachedNames.size,
        registryHits,
        uncachedCount: people.length - cachedNames.size
      });

      return jsonResponse({
        success: true,
        phase: 'markets',
        category: category || 'all',
        markets,
        people,
        cacheHints: {
          cachedCount: cachedNames.size,
          uncachedCount: people.length - cachedNames.size,
          registryHits,
          suggestedBatchSize: calculateBatchSize(
            people.map(p => p.name),
            cachedNames
          )
        },
        registry: {
          size: registrySize,
          stats: getRegistryStats()
        },
        lastFetchTime,
        logs: logger.getLogs()
      });
    }

    // Phase 2: Look up a batch of people on Wikipedia (with caching)
    if (phase === 'lookup') {
      const namesParam = url.searchParams.get('names');
      if (!namesParam) {
        return jsonResponse({ success: false, error: 'Missing names parameter' }, 400);
      }

      const names = JSON.parse(namesParam);
      log('INFO', 'Phase 2: Looking up people', { count: names.length });

      const results = await Promise.all(
        names.map(async (name) => {
          const result = await lookupPersonOptimized(name, log);
          return { name, ...result };
        })
      );

      // Summary stats
      const cacheHits = results.filter(r => r.source === 'celebrity-db' || r.source === 'cache').length;
      const registryHits = results.filter(r => r.source === 'registry').length;
      const missesSkipped = results.filter(r => r.source === 'misses-registry').length;
      const wikiFetches = results.filter(r => r.source === 'wikipedia').length;
      const found = results.filter(r => r.found).length;

      log('INFO', 'Lookup batch complete', {
        total: results.length,
        cacheHits,
        registryHits,
        missesSkipped,
        wikiFetches,
        found
      });

      return jsonResponse({
        success: true,
        phase: 'lookup',
        results,
        stats: { cacheHits, registryHits, missesSkipped, wikiFetches, found },
        registryStats: getRegistryStats(),
        missesStats: getMissesRequestStats(),
        logs: logger.getLogs()
      });
    }

    // Phase: Leaderboard - fetch top traders from Polymarket leaderboard
    if (phase === 'leaderboard') {
      log('INFO', 'Fetching leaderboard', { category, timeWindow, limit });

      try {
        const leaderboardUrl = `https://polymarket.com/leaderboard/${category}/${timeWindow}/profit`;
        log('DEBUG', 'Leaderboard URL', { url: leaderboardUrl });

        // Polymarket uses a GraphQL API for leaderboard data
        // We'll fetch from their public API endpoint
        const apiUrl = `https://clob.polymarket.com/leaderboard?window=${timeWindow}&limit=${limit}`;

        const response = await fetch(apiUrl, {
          headers: {
            'User-Agent': 'PolyCheck/1.1',
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          log('WARN', 'Leaderboard API failed, trying alternative', { status: response.status });

          // Alternative: use the gamma API's traders endpoint if available
          return jsonResponse({
            success: false,
            error: `Leaderboard API returned ${response.status}. This feature requires access to Polymarket's leaderboard data.`,
            phase: 'leaderboard',
            logs: logger.getLogs()
          }, 500);
        }

        const leaderboardData = await response.json();
        log('INFO', 'Leaderboard data fetched', { count: leaderboardData?.length || 0 });

        // Extract trader names from leaderboard
        const people = (leaderboardData || []).slice(0, limit).map((trader, idx) => ({
          name: trader.name || trader.username || `Trader ${trader.address?.slice(0, 8)}`,
          nameKey: (trader.name || trader.username || '').toLowerCase(),
          rank: idx + 1,
          profit: trader.profit || trader.pnl || 0,
          volume: trader.volume || 0,
          address: trader.address
        })).filter(p => p.name && !p.name.startsWith('Trader 0x'));

        // Pre-check cache status for smart batching hints
        const cachedNames = new Set();
        for (const person of people) {
          const celebData = getCelebrityData(person.name);
          if (celebData) {
            cachedNames.add(person.nameKey);
          }
        }

        const cachedCount = cachedNames.size;
        const uncachedCount = people.length - cachedCount;

        return jsonResponse({
          success: true,
          phase: 'leaderboard',
          people,
          category,
          timeWindow,
          cacheHints: {
            cachedCount,
            uncachedCount,
            suggestedBatchSize: uncachedCount > 10 ? 3 : 5
          },
          logs: logger.getLogs()
        });

      } catch (error) {
        log('ERROR', 'Leaderboard fetch failed', { error: error.message });
        return jsonResponse({
          success: false,
          error: `Failed to fetch leaderboard: ${error.message}`,
          phase: 'leaderboard',
          logs: logger.getLogs()
        }, 500);
      }
    }

    // Phase: Search - search Polymarket for markets matching a query
    if (phase === 'search') {
      const query = url.searchParams.get('q') || url.searchParams.get('query');
      if (!query) {
        return jsonResponse({ success: false, error: 'Missing query parameter' }, 400);
      }

      log('INFO', 'Searching Polymarket', { query, topN });

      try {
        // Search both events and markets endpoints with the query
        const allMarkets = [];

        // Search events
        const eventsUrl = `https://gamma-api.polymarket.com/events?limit=50&active=true&closed=false&q=${encodeURIComponent(query)}`;
        log('DEBUG', 'Searching events', { url: eventsUrl });

        try {
          const eventsResponse = await fetch(eventsUrl, {
            headers: { 'User-Agent': 'PolyCheck/1.2' }
          });

          if (eventsResponse.ok) {
            const events = await eventsResponse.json();
            log('INFO', 'Events search results', { count: events.length });

            for (const event of events) {
              if (event.markets && Array.isArray(event.markets)) {
                for (const market of event.markets) {
                  market._source = 'events-search';
                  market._eventSlug = event.slug;
                  market._eventTitle = event.title || event.question || null;
                  allMarkets.push(market);
                }
              }
            }
          }
        } catch (e) {
          log('WARN', 'Events search failed', { error: e.message });
        }

        // Search markets directly
        const marketsUrl = `https://gamma-api.polymarket.com/markets?limit=50&active=true&closed=false&q=${encodeURIComponent(query)}`;
        log('DEBUG', 'Searching markets', { url: marketsUrl });

        try {
          const marketsResponse = await fetch(marketsUrl, {
            headers: { 'User-Agent': 'PolyCheck/1.2' }
          });

          if (marketsResponse.ok) {
            const markets = await marketsResponse.json();
            log('INFO', 'Markets search results', { count: markets.length });

            // Dedupe by slug
            const existingSlugs = new Set(allMarkets.map(m => m.slug));
            for (const market of markets) {
              if (!existingSlugs.has(market.slug)) {
                market._source = 'markets-search';
                allMarkets.push(market);
              }
            }
          }
        } catch (e) {
          log('WARN', 'Markets search failed', { error: e.message });
        }

        log('INFO', 'Total search results', { count: allMarkets.length });

        if (allMarkets.length === 0) {
          return jsonResponse({
            success: true,
            phase: 'search',
            query,
            markets: [],
            people: [],
            cacheHints: { cachedCount: 0, uncachedCount: 0, suggestedBatchSize: 5 },
            logs: logger.getLogs()
          });
        }

        // Extract people from markets
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

        // Final fuzzy deduplication
        peopleList = deduplicatePeople(peopleList, 75);

        log('INFO', 'People extracted from search', {
          marketsWithPeople: markets.length,
          uniquePeople: peopleList.length
        });

        // Pre-check cache status for smart batching hints
        const cachedNames = new Set();
        for (const person of peopleList) {
          const celebData = getCelebrityData(person.name);
          if (celebData) {
            cachedNames.add(person.nameKey);
            continue;
          }

          const registryData = await getFromRegistry(person.name);
          if (registryData) {
            cachedNames.add(person.nameKey);
            continue;
          }

          const cached = await getCachedResult(person.name);
          if (cached) {
            cachedNames.add(person.nameKey);
          }
        }

        return jsonResponse({
          success: true,
          phase: 'search',
          query,
          markets,
          people: peopleList,
          cacheHints: {
            cachedCount: cachedNames.size,
            uncachedCount: peopleList.length - cachedNames.size,
            suggestedBatchSize: calculateBatchSize(
              peopleList.map(p => p.name),
              cachedNames
            )
          },
          logs: logger.getLogs()
        });

      } catch (error) {
        log('ERROR', 'Search failed', { error: error.message });
        return jsonResponse({
          success: false,
          error: `Search failed: ${error.message}`,
          phase: 'search',
          logs: logger.getLogs()
        }, 500);
      }
    }

    // Full mode (legacy) - for backwards compatibility
    log('INFO', 'Full crawl mode', { limit, topN, category: category || 'all', sort: sortBy || 'default' });
    const { markets, people } = await fetchMarketsAndPeople(limit, topN, log, null, category, sortBy);

    // Limit lookups to avoid timeout
    const maxLookups = 15;
    const namesToLookup = people.slice(0, maxLookups);

    log('INFO', 'Starting Wikipedia lookups', {
      total: people.length,
      looking_up: namesToLookup.length
    });

    // Parallel Wikipedia lookups with caching
    const wikiResults = new Map();
    const batchSize = 5;

    for (let i = 0; i < namesToLookup.length; i += batchSize) {
      const batch = namesToLookup.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (person) => {
          const result = await lookupPersonOptimized(person.name, log);
          return { ...person, ...result };
        })
      );

      for (const result of batchResults) {
        wikiResults.set(result.nameKey, result);
      }
    }

    // Build final results
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
          ...(wikiResult || { found: false, status: 'Skipped (limit reached)' })
        });
      }
    }

    const stats = {
      totalMarkets: markets.length,
      totalPeople: results.length,
      uniquePeople: people.length,
      lookedUp: wikiResults.size,
      birthDatesFound: results.filter(r => r.birthDate).length,
      wikipediaNotFound: results.filter(r => !r.found).length,
      birthDateMissing: results.filter(r => r.found && !r.birthDate).length
    };

    log('INFO', 'Crawl completed', stats);

    return jsonResponse({
      success: true,
      phase: 'full',
      stats,
      results,
      logs: logger.getLogs(),
      crawledAt: new Date().toISOString()
    });

  } catch (error) {
    log('ERROR', 'Crawl failed', { error: error.message, stack: error.stack });

    return jsonResponse({
      success: false,
      error: error.message,
      logs: logger.getLogs()
    }, 500);
  }
};

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Optimized person lookup with caching layers
 * 1. Check celebrity database (instant)
 * 2. Check birthdate registry (persistent, high-confidence)
 * 3. Check Netlify Blobs cache (30-day TTL)
 * 4. Check misses registry (skip known failures in cooldown)
 * 5. Fetch from Wikipedia with retry
 * 6. Cache the result + add to registry if high-confidence
 * 7. Add to misses registry if no birthdate found
 */
async function lookupPersonOptimized(name, log, marketTitle = null) {
  // Layer 1: Celebrity database (instant, no API call)
  const celebData = getCelebrityData(name);
  if (celebData) {
    log('INFO', `Celebrity DB hit: ${name}`, { source: 'celebrity-db' });
    return celebData;
  }

  // Layer 2: Birthdate registry (persistent, high-confidence only)
  const registryData = await getFromRegistry(name);
  if (registryData) {
    log('INFO', `Registry hit: ${name}`, { source: 'registry' });
    return registryData;
  }

  // Layer 3: Netlify Blobs cache (30-day TTL)
  const cached = await getCachedResult(name);
  if (cached) {
    log('INFO', `Cache hit: ${name}`, { source: 'cache' });

    // Promote to registry if it qualifies (high confidence)
    if (qualifiesForRegistry(cached)) {
      await addToRegistry(name, cached, 'cache');
    }

    return cached;
  }

  // Layer 4: Check misses registry (skip known failures in cooldown)
  const missEntry = await checkMissesRegistry(name);
  if (missEntry) {
    log('INFO', `Misses registry hit (cooldown): ${name}`, {
      reason: missEntry.reason,
      seenCount: missEntry.seenCount
    });
    // Return a result indicating this is a known miss
    return {
      found: false,
      status: `Known miss: ${missEntry.reason}`,
      source: 'misses-registry',
      missReason: missEntry.reason,
      entityType: missEntry.entityType,
      seenCount: missEntry.seenCount
    };
  }

  // Layer 5: Wikipedia API with retry
  log('INFO', `Wikipedia fetch: ${name}`);
  const result = await fetchFromWikipediaWithRetry(name, log);

  // Cache the result (even negative results to avoid repeated lookups)
  if (result) {
    await setCachedResult(name, result);

    // Add to persistent registry if high-confidence birthdate found
    if (qualifiesForRegistry(result)) {
      const added = await addToRegistry(name, result, 'wikipedia');
      if (added) {
        log('INFO', `Added to registry: ${name}`, { confidence: result.confidence });
      }
    } else {
      // No good birthdate found - add to misses registry
      let missReason = 'not-found';
      if (result.found && !result.birthDate) {
        missReason = 'no-birthdate';
      } else if (result.found && result.birthDate && (result.confidence ?? 0) < 80) {
        missReason = 'low-confidence';
      }

      // Detect if this might not be a person
      const entityDetection = detectEntityType(name);

      await addToMissesRegistry(name, missReason, {
        wikipediaUrl: result.wikipediaUrl,
        marketTitle: marketTitle,
        entityType: entityDetection.confidence > 50 ? entityDetection.type : undefined
      });

      log('INFO', `Added to misses registry: ${name}`, {
        reason: missReason,
        entityType: entityDetection.type,
        entityConfidence: entityDetection.confidence
      });
    }
  }

  return result;
}

/**
 * Fetch from Wikipedia with retry, rate limiting, and exponential backoff
 */
async function fetchFromWikipediaWithRetry(name, log) {
  return withRetry(
    // Wrap the fetch in rate limiting
    () => withWikipediaRateLimit(() => fetchFromWikipedia(name)),
    {
      maxRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 3000,
      shouldRetry: (error) => {
        // Retry on network errors and 5xx errors, but not rate limit errors
        if (error.message.includes('Rate limiter queue full')) {
          return false;
        }
        return error.message.includes('fetch') ||
               error.message.includes('500') ||
               error.message.includes('502') ||
               error.message.includes('503');
      },
      onRetry: (attempt, delay, error) => {
        log('WARN', `Retry ${attempt} for ${name}`, { delay, error: error.message });
      }
    }
  ).catch(error => {
    log('ERROR', `Wikipedia fetch failed for ${name}`, { error: error.message });
    return {
      found: false,
      status: `Error: ${error.message}`,
      source: 'wikipedia-error'
    };
  });
}

/**
 * Fetch person data from Wikipedia
 */
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
    return {
      found: false,
      status: 'Wikipedia page not found',
      source: 'wikipedia'
    };
  }

  // Find best match
  const nameLower = name.toLowerCase();
  let title = results[0].title;
  for (const result of results) {
    if (result.title.toLowerCase().includes(nameLower)) {
      title = result.title;
      break;
    }
  }

  // Get page content
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
    return {
      found: false,
      status: 'Wikipedia page not found',
      source: 'wikipedia'
    };
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
  } else {
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
}

/**
 * Polymarket category slug mapping
 * Maps user-friendly category names to Polymarket API tag slugs
 */
const CATEGORY_SLUGS = {
  // Main Topics
  'politics': 'politics',
  'sports': 'sports',
  'crypto': 'crypto',
  'tech': 'tech',
  'ai': 'ai',
  'pop-culture': 'pop-culture',
  // Regions
  'middle-east': 'middle-east',
  'world': 'world',
  'geopolitics': 'geopolitics',
  // Finance
  'finance': 'finance',
  'economy': 'economy',
  'earnings': 'earnings',
  // Other
  'elections': 'elections',
  'culture': 'culture',
  'mentions': 'mentions',
  'live-crypto': 'live-crypto'
};

/**
 * Sort options mapping
 * Maps frontend sort values to Polymarket API parameters
 */
const SORT_OPTIONS = {
  'liquidity': { order: 'liquidity', ascending: false },
  'volume': { order: 'volume24hr', ascending: false },
  'startDate': { order: 'startDate', ascending: false },
  'endDate': { order: 'endDate', ascending: true },
  'competitive': { order: 'competitive', ascending: false }
};

/**
 * Fetch markets and extract unique people
 */
async function fetchMarketsAndPeople(limit, topN, log, sinceDateStr = null, category = '', sortBy = '') {
  const allMarkets = [];
  const lastFetchTime = new Date().toISOString();

  // Build category filter parameter
  const categorySlug = category ? CATEGORY_SLUGS[category.toLowerCase()] : '';
  const tagParam = categorySlug ? `&tag_slug=${categorySlug}` : '';

  // Build sort parameter
  const sortOption = sortBy ? SORT_OPTIONS[sortBy.toLowerCase()] : null;
  const orderParam = sortOption ? `&order=${sortOption.order}&ascending=${sortOption.ascending}` : '';

  // Fetch from events endpoint
  log('INFO', 'Fetching events from Polymarket API', { category: categorySlug || 'all', sort: sortBy || 'default' });
  try {
    const eventsUrl = `https://gamma-api.polymarket.com/events?limit=${limit}&active=true&closed=false${tagParam}${orderParam}`;
    const eventsResponse = await fetch(eventsUrl, {
      headers: { 'User-Agent': 'PolyCheck/1.1' }
    });

    if (eventsResponse.ok) {
      const events = await eventsResponse.json();
      log('INFO', 'Events fetched', { count: events.length });

      for (const event of events) {
        // Incremental filter: skip events older than since date
        if (sinceDateStr && event.startDate) {
          const eventDate = new Date(event.startDate);
          const sinceDate = new Date(sinceDateStr);
          if (eventDate < sinceDate) continue;
        }

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
  } catch (e) {
    log('WARN', 'Events fetch failed', { error: e.message });
  }

  // Fetch from markets endpoint
  log('INFO', 'Fetching markets from Polymarket API', { category: categorySlug || 'all', sort: sortBy || 'default' });
  const apiUrl = `https://gamma-api.polymarket.com/markets?limit=${Math.max(limit, 100)}&active=true&closed=false${tagParam}${orderParam}`;

  const marketResponse = await fetch(apiUrl, {
    headers: { 'User-Agent': 'PolyCheck/1.1' }
  });

  if (!marketResponse.ok) {
    throw new Error(`Polymarket API error: ${marketResponse.status}`);
  }

  const rawMarkets = await marketResponse.json();
  log('INFO', 'Markets fetched', { count: rawMarkets.length });

  // Dedupe by slug
  const existingSlugs = new Set(allMarkets.map(m => m.slug));
  for (const market of rawMarkets) {
    if (!existingSlugs.has(market.slug)) {
      // Incremental filter
      if (sinceDateStr && market.startDate) {
        const marketDate = new Date(market.startDate);
        const sinceDate = new Date(sinceDateStr);
        if (marketDate < sinceDate) continue;
      }

      market._source = 'markets';
      allMarkets.push(market);
    }
  }

  log('INFO', 'Total unique markets', { count: allMarkets.length });

  // Extract people from markets
  const markets = [];
  let peopleList = [];

  for (const market of allMarkets) {
    const processed = extractPeopleFromMarket(market, topN);
    if (processed.people.length > 0) {
      markets.push(processed);

      for (const person of processed.people) {
        // Use fuzzy matching for better deduplication
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
          // Prefer the longer/fuller name
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

  // Final fuzzy deduplication pass
  peopleList = deduplicatePeople(peopleList, 75);

  log('INFO', 'People extracted', {
    marketsWithPeople: markets.length,
    uniquePeople: peopleList.length
  });

  return { markets, people: peopleList, lastFetchTime };
}

/**
 * Extract people from a market - both from title AND outcomes
 */
function extractPeopleFromMarket(market, topN) {
  const title = market.question || market.title || 'Unknown';
  const slug = market._eventSlug || market.slug || '';
  const eventTitle = market._eventTitle || null;
  const conditionId = market.conditionId || market.condition_id || '';
  const volume = parseFloat(market.volume || 0);
  const endDate = market.endDate || market.end_date_iso || null;

  const people = [];

  // Extract from outcomes FIRST (these are authoritative)
  const outcomeNames = extractFromOutcomes(market, topN);
  for (const { name, probability } of outcomeNames) {
    if (!isDuplicatePerson(name, people)) {
      people.push({ name, probability, source: 'outcome' });
    }
  }

  // Extract from title - but skip if already covered
  const titleNames = extractNamesFromText(title);
  for (const name of titleNames) {
    if (!isDuplicatePerson(name, people)) {
      people.push({ name, probability: null, source: 'title' });
    }
  }

  return { title, slug, eventTitle, conditionId, volume, endDate, people };
}

/**
 * Check if a name is a duplicate using fuzzy matching
 */
function isDuplicatePerson(newName, existingPeople) {
  const newLower = newName.toLowerCase().trim();
  const newParts = newLower.split(/\s+/);

  for (const person of existingPeople) {
    const existingLower = person.name.toLowerCase().trim();
    const existingParts = existingLower.split(/\s+/);

    // Exact match
    if (newLower === existingLower) return true;

    // Single word surname match
    if (newParts.length === 1) {
      if (existingParts[existingParts.length - 1] === newParts[0]) return true;
      if (existingParts.includes(newParts[0])) return true;
    }

    if (existingParts.length === 1) {
      if (newParts[newParts.length - 1] === existingParts[0]) return true;
      if (newParts.includes(existingParts[0])) return true;
    }

    // Substring match
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

  // Extract valid person names
  const validOutcomes = [];
  for (const outcome of outcomes) {
    const parsedName = parsePersonFromOutcome(outcome.name);
    if (parsedName && isPersonName(parsedName)) {
      validOutcomes.push({
        name: parsedName,
        probability: outcome.probability
      });
    }
  }

  return validOutcomes;
}

function parsePersonFromOutcome(outcomeStr) {
  if (!outcomeStr) return null;

  let name = outcomeStr;

  // Remove company/title after dash
  if (name.includes(' - ')) {
    name = name.split(' - ')[0].trim();
  }

  // Remove parentheticals
  name = name.replace(/\s*\([^)]*\)\s*/g, '').trim();

  // Remove title after comma
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
    'Trump', 'Biden', 'Obama', 'Putin', 'Xi Jinping', 'Zelensky', 'Macron', 'Scholz',
    'Netanyahu', 'Khamenei', 'Kim Jong Un', 'Modi', 'Erdogan', 'Lula', 'Milei',
    'Musk', 'Bezos', 'Zuckerberg', 'Altman', 'SBF', 'CZ',
    'Taylor Swift', 'Beyoncé', 'Drake', 'Kanye', 'Ye',
    'MrBeast', 'PewDiePie', 'Joe Rogan', 'Tucker Carlson', 'Elon Musk',
    'DeSantis', 'Newsom', 'Haley', 'Ramaswamy', 'RFK Jr', 'Vivek',
    'Pelosi', 'McConnell', 'Schumer', 'AOC', 'MTG',
    'Pope Francis', 'King Charles', 'Prince Harry', 'Meghan Markle',
    'Andrew Tate', 'Jordan Peterson', 'Ben Shapiro',
    'Donald Trump', 'Joe Biden', 'Barack Obama', 'Vladimir Putin',
    'Volodymyr Zelensky', 'Emmanuel Macron', 'Olaf Scholz',
    'Benjamin Netanyahu', 'Ali Khamenei', 'Narendra Modi',
    'Recep Erdogan', 'Javier Milei', 'Ron DeSantis', 'Gavin Newsom',
    'Nikki Haley', 'Nancy Pelosi', 'Mitch McConnell', 'Chuck Schumer',
    'Sam Altman', 'Sam Bankman-Fried', 'Changpeng Zhao'
  ];

  for (const figure of knownFigures) {
    const regex = new RegExp(`\\b${escapeRegex(figure)}\\b`, 'i');
    if (regex.test(text)) {
      names.push(figure);
    }
  }

  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    if (isLikelyPersonName(match[1])) {
      names.push(match[1]);
    }
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
    'july', 'august', 'september', 'october', 'november', 'december',
    'q1', 'q2', 'q3', 'q4', 'higher', 'lower', 'same'
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
    'united states', 'united kingdom', 'united nations', 'european union',
    'north korea', 'south korea', 'new york', 'los angeles', 'san francisco',
    'wall street', 'silicon valley', 'white house', 'supreme court',
    'federal reserve', 'world war', 'middle east', 'hong kong',
    'super bowl', 'world cup', 'champions league', 'grand prix'
  ];

  const lower = name.toLowerCase();

  if (lower.startsWith('will ') || lower.startsWith('when ') ||
      lower.startsWith('what ') || lower.startsWith('how ') ||
      lower.startsWith('who ') || lower.startsWith('which ')) {
    return false;
  }

  for (const phrase of nonPersonPhrases) {
    if (lower.includes(phrase)) return false;
  }

  return name.split(/\s+/).length <= 4;
}

export const config = {
  path: "/api/crawl"
};
