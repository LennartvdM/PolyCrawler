/**
 * Netlify Function: Full crawl - fetch markets and lookup all Wikipedia birth dates
 * Returns detailed logs for debugging
 */

export default async (request, context) => {
  const logs = [];
  const log = (level, message, data = null) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };
    logs.push(entry);
    console.log(`[${level}] ${message}`, data || '');
  };

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const topN = parseInt(url.searchParams.get('top')) || 4;

  log('INFO', 'Crawl started', { limit, topN });

  try {
    // Fetch markets from multiple sources to find person-based markets
    const allMarkets = [];

    // Strategy 1: Fetch from events endpoint (grouped markets often have person contenders)
    log('INFO', 'Fetching events from Polymarket API');
    try {
      const eventsUrl = `https://gamma-api.polymarket.com/events?limit=${limit}&active=true&closed=false`;
      const eventsResponse = await fetch(eventsUrl, {
        headers: { 'User-Agent': 'PolyCrawler/1.0' }
      });

      if (eventsResponse.ok) {
        const events = await eventsResponse.json();
        log('INFO', 'Events fetched', { count: events.length });

        // Extract markets from events
        for (const event of events) {
          if (event.markets && Array.isArray(event.markets)) {
            for (const market of event.markets) {
              market._source = 'events';
              allMarkets.push(market);
            }
          }
        }
        log('INFO', 'Markets extracted from events', { count: allMarkets.length });
      }
    } catch (e) {
      log('WARN', 'Events fetch failed, continuing with markets endpoint', { error: e.message });
    }

    // Strategy 2: Fetch regular markets endpoint with higher limit
    log('INFO', 'Fetching markets from Polymarket API');
    const apiUrl = `https://gamma-api.polymarket.com/markets?limit=${Math.max(limit, 200)}&active=true&closed=false`;

    const marketResponse = await fetch(apiUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0' }
    });

    log('INFO', 'Polymarket API response received', {
      status: marketResponse.status,
      statusText: marketResponse.statusText
    });

    if (!marketResponse.ok) {
      const errorText = await marketResponse.text();
      log('ERROR', 'Polymarket API error', { status: marketResponse.status, body: errorText.substring(0, 500) });
      throw new Error(`Polymarket API error: ${marketResponse.status} - ${errorText.substring(0, 200)}`);
    }

    const rawMarkets = await marketResponse.json();
    log('INFO', 'Markets fetched successfully', { totalMarkets: rawMarkets.length });

    // Add to allMarkets (avoiding duplicates by slug)
    const existingSlugs = new Set(allMarkets.map(m => m.slug));
    for (const market of rawMarkets) {
      if (!existingSlugs.has(market.slug)) {
        market._source = 'markets';
        allMarkets.push(market);
      }
    }

    log('INFO', 'Total unique markets to process', { count: allMarkets.length });

    // Pre-filter: Only consider markets with >2 outcomes (multi-option = likely person-based)
    const multiOptionMarkets = allMarkets.filter(market => {
      let outcomeCount = 0;

      if (market.tokens && Array.isArray(market.tokens)) {
        outcomeCount = market.tokens.length;
      } else if (market.outcomes) {
        let outcomes = market.outcomes;
        if (typeof outcomes === 'string') {
          try { outcomes = JSON.parse(outcomes); } catch { outcomes = []; }
        }
        outcomeCount = Array.isArray(outcomes) ? outcomes.length : 0;
      }

      return outcomeCount > 2;
    });

    log('INFO', 'Multi-option markets (>2 outcomes)', {
      count: multiOptionMarkets.length,
      examples: multiOptionMarkets.slice(0, 5).map(m => ({
        question: m.question || m.title,
        outcomeCount: m.tokens?.length || (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes || '[]').length : m.outcomes?.length)
      }))
    });

    // Process markets
    const markets = [];
    const skippedMarkets = [];

    for (const market of multiOptionMarkets) {
      const processed = extractContenders(market, topN, log);
      if (processed.contenders.length > 0) {
        markets.push(processed);
        log('DEBUG', 'Found market with person contenders', {
          title: processed.title.substring(0, 60),
          contenders: processed.contenders.map(c => c.name)
        });
      } else {
        skippedMarkets.push({
          title: market.question || market.title || 'Unknown',
          reason: processed.skipReason || 'No person contenders found'
        });
      }
    }

    log('INFO', 'Markets processed', {
      marketsWithContenders: markets.length,
      skippedMarkets: skippedMarkets.length,
      skippedExamples: skippedMarkets.slice(0, 5)
    });

    if (markets.length === 0) {
      log('WARN', 'No markets with person contenders found', {
        totalRawMarkets: allMarkets.length,
        multiOptionMarkets: multiOptionMarkets.length,
        skippedReasons: skippedMarkets.slice(0, 10)
      });
    }

    // Step 2: Look up each contender on Wikipedia
    const results = [];
    let wikiLookupCount = 0;
    const totalContenders = markets.reduce((sum, m) => sum + m.contenders.length, 0);

    log('INFO', 'Starting Wikipedia lookups', { totalContenders });

    for (const market of markets) {
      for (const contender of market.contenders) {
        wikiLookupCount++;
        log('DEBUG', `Looking up contender ${wikiLookupCount}/${totalContenders}`, {
          name: contender.name,
          market: market.title.substring(0, 50)
        });

        const wikiResult = await lookupPerson(contender.name, log);

        results.push({
          marketTitle: market.title,
          marketSlug: market.slug,
          marketVolume: market.volume,
          marketEndDate: market.endDate,
          personName: contender.name,
          probability: contender.probability,
          ...wikiResult
        });
      }
    }

    // Calculate stats
    const stats = {
      totalMarkets: markets.length,
      totalContenders: results.length,
      birthDatesFound: results.filter(r => r.birthDate).length,
      wikipediaNotFound: results.filter(r => !r.found).length,
      birthDateMissing: results.filter(r => r.found && !r.birthDate).length
    };

    log('INFO', 'Crawl completed successfully', stats);

    return new Response(JSON.stringify({
      success: true,
      stats,
      results,
      logs,
      crawledAt: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log('ERROR', 'Crawl failed', { error: error.message, stack: error.stack });

    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      logs
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function extractContenders(market, topN, log) {
  const title = market.question || market.title || 'Unknown';
  const slug = market.slug || '';
  const volume = parseFloat(market.volume || 0);
  const endDate = market.endDate || market.end_date_iso || null;

  let outcomes = [];
  let skipReason = null;

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
  } else {
    skipReason = 'No tokens or outcomes in market data';
  }

  if (outcomes.length === 0) {
    skipReason = skipReason || 'Empty outcomes array';
    return { title, slug, volume, endDate, contenders: [], skipReason };
  }

  outcomes.sort((a, b) => b.probability - a.probability);
  const topOutcomes = outcomes.slice(0, topN);

  const contenders = [];
  const rejectedOutcomes = [];

  for (const o of topOutcomes) {
    if (!o.name) {
      rejectedOutcomes.push({ name: '(empty)', reason: 'Empty name' });
      continue;
    }

    const nameCheck = checkPersonName(o.name);
    if (nameCheck.isValid) {
      contenders.push({ name: o.name, probability: o.probability });
    } else {
      rejectedOutcomes.push({ name: o.name, reason: nameCheck.reason });
    }
  }

  if (contenders.length === 0 && rejectedOutcomes.length > 0) {
    skipReason = `All outcomes rejected: ${rejectedOutcomes.map(r => `"${r.name}" (${r.reason})`).join(', ')}`;
  }

  return { title, slug, volume, endDate, contenders, skipReason, rejectedOutcomes };
}

function checkPersonName(name) {
  const nonPersonTerms = new Set([
    'yes', 'no', 'other', 'none', 'neither', 'both',
    'before', 'after', 'over', 'under', 'between',
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ]);

  const nameLower = name.toLowerCase().trim();

  if (nonPersonTerms.has(nameLower)) {
    return { isValid: false, reason: 'Common non-person term' };
  }

  if (/^[\d,.\s]+$/.test(name)) {
    return { isValid: false, reason: 'Numeric value' };
  }

  const parts = name.split(/\s+/);
  if (parts.length < 2) {
    return { isValid: false, reason: 'Single word (needs first + last name)' };
  }

  if (/^\d/.test(parts[0])) {
    return { isValid: false, reason: 'Starts with number' };
  }

  return { isValid: true };
}

function looksLikePersonName(name) {
  return checkPersonName(name).isValid;
}

async function lookupPerson(name, log) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=5&format=json&origin=*`;

    const searchResponse = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0 (horoscope research)' }
    });

    if (!searchResponse.ok) {
      log('WARN', 'Wikipedia search failed', { name, status: searchResponse.status });
      return { found: false, status: `Wikipedia search failed: ${searchResponse.status}` };
    }

    const searchData = await searchResponse.json();
    const results = searchData.query?.search || [];

    if (results.length === 0) {
      log('DEBUG', 'No Wikipedia results', { name });
      return { found: false, status: 'Wikipedia page not found' };
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

    log('DEBUG', 'Wikipedia page found', { name, pageTitle: title });

    // Get content
    const contentUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*`;

    const contentResponse = await fetch(contentUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0 (horoscope research)' }
    });

    if (!contentResponse.ok) {
      log('WARN', 'Wikipedia content fetch failed', { name, title, status: contentResponse.status });
      return { found: false, status: 'Wikipedia fetch failed' };
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
      return { found: false, status: 'Wikipedia page not found' };
    }

    const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const birthInfo = extractBirthDate(wikitext);

    if (birthInfo) {
      log('DEBUG', 'Birth date found', { name, birthDate: birthInfo.formatted });
      return {
        found: true,
        wikipediaUrl,
        birthDate: birthInfo.formatted,
        birthDateRaw: birthInfo.raw,
        zodiacSign: getZodiacSign(birthInfo.raw),
        status: 'Found'
      };
    } else {
      log('DEBUG', 'Wikipedia found but no birth date', { name, wikipediaUrl });
      return {
        found: true,
        wikipediaUrl,
        birthDate: null,
        birthDateRaw: null,
        zodiacSign: null,
        status: 'Birth date not found on Wikipedia'
      };
    }
  } catch (error) {
    log('ERROR', 'Wikipedia lookup error', { name, error: error.message });
    return { found: false, status: `Error: ${error.message}` };
  }
}

function extractBirthDate(wikitext) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  let match = wikitext.match(/\{\{[Bb]irth date(?: and age)?\|(\d{4})\|(\d{1,2})\|(\d{1,2})/);
  if (match) {
    const [_, year, month, day] = match;
    return {
      formatted: `${months[parseInt(month) - 1]} ${parseInt(day)}, ${year}`,
      raw: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    };
  }

  match = wikitext.match(/birth_date\s*=\s*\{\{[^|]+\|(\d{4})\|(\d{1,2})\|(\d{1,2})/i);
  if (match) {
    const [_, year, month, day] = match;
    return {
      formatted: `${months[parseInt(month) - 1]} ${parseInt(day)}, ${year}`,
      raw: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    };
  }

  match = wikitext.match(/\(?\s*born\s+([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const [_, monthName, day, year] = match;
    const monthIndex = months.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
    if (monthIndex !== -1) {
      return {
        formatted: `${monthName} ${parseInt(day)}, ${year}`,
        raw: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
      };
    }
  }

  match = wikitext.match(/born\s+(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/);
  if (match) {
    const [_, day, monthName, year] = match;
    const monthIndex = months.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
    if (monthIndex !== -1) {
      return {
        formatted: `${monthName} ${parseInt(day)}, ${year}`,
        raw: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
      };
    }
  }

  match = wikitext.match(/\{\{[Bb]irth year(?: and age)?\|(\d{4})/);
  if (match) {
    return { formatted: `${match[1]} (month/day unknown)`, raw: match[1] };
  }

  return null;
}

function getZodiacSign(dateStr) {
  if (!dateStr || dateStr.length === 4) return null;

  const [year, month, day] = dateStr.split('-').map(Number);
  if (!month || !day) return null;

  const signs = [
    { name: 'Capricorn', symbol: '♑', start: [12, 22], end: [1, 19] },
    { name: 'Aquarius', symbol: '♒', start: [1, 20], end: [2, 18] },
    { name: 'Pisces', symbol: '♓', start: [2, 19], end: [3, 20] },
    { name: 'Aries', symbol: '♈', start: [3, 21], end: [4, 19] },
    { name: 'Taurus', symbol: '♉', start: [4, 20], end: [5, 20] },
    { name: 'Gemini', symbol: '♊', start: [5, 21], end: [6, 20] },
    { name: 'Cancer', symbol: '♋', start: [6, 21], end: [7, 22] },
    { name: 'Leo', symbol: '♌', start: [7, 23], end: [8, 22] },
    { name: 'Virgo', symbol: '♍', start: [8, 23], end: [9, 22] },
    { name: 'Libra', symbol: '♎', start: [9, 23], end: [10, 22] },
    { name: 'Scorpio', symbol: '♏', start: [10, 23], end: [11, 21] },
    { name: 'Sagittarius', symbol: '♐', start: [11, 22], end: [12, 21] },
  ];

  for (const sign of signs) {
    const [startMonth, startDay] = sign.start;
    const [endMonth, endDay] = sign.end;

    if (startMonth === 12 && endMonth === 1) {
      if ((month === 12 && day >= startDay) || (month === 1 && day <= endDay)) {
        return { name: sign.name, symbol: sign.symbol };
      }
    } else {
      if ((month === startMonth && day >= startDay) ||
          (month === endMonth && day <= endDay) ||
          (month > startMonth && month < endMonth)) {
        return { name: sign.name, symbol: sign.symbol };
      }
    }
  }

  return null;
}

export const config = {
  path: "/api/crawl"
};
