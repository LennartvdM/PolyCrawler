/**
 * Netlify Function: Chunked crawl - supports progressive loading
 * Phase 1: Fetch markets and extract people (returns list to look up)
 * Phase 2: Look up batch of people on Wikipedia
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
  const phase = url.searchParams.get('phase') || 'full';
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const topN = parseInt(url.searchParams.get('top')) || 4;

  try {
    // Phase 1: Fetch markets and extract people
    if (phase === 'markets') {
      log('INFO', 'Phase 1: Fetching markets', { limit, topN });
      const { markets, people, logs: marketLogs } = await fetchMarketsAndPeople(limit, topN, log);

      return new Response(JSON.stringify({
        success: true,
        phase: 'markets',
        markets,
        people, // Array of { name, nameKey, markets: [...] }
        logs
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Phase 2: Look up a batch of people on Wikipedia
    if (phase === 'lookup') {
      const namesParam = url.searchParams.get('names');
      if (!namesParam) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing names parameter',
          logs
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const names = JSON.parse(namesParam);
      log('INFO', 'Phase 2: Looking up people', { count: names.length, names });

      const results = await Promise.all(
        names.map(async (name) => {
          const result = await lookupPerson(name, log);
          return { name, ...result };
        })
      );

      return new Response(JSON.stringify({
        success: true,
        phase: 'lookup',
        results,
        logs
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Full mode (legacy) - for backwards compatibility, but with limits
    log('INFO', 'Full crawl mode', { limit, topN });
    const { markets, people } = await fetchMarketsAndPeople(limit, topN, log);

    // Limit lookups to avoid timeout
    const maxLookups = 15;
    const namesToLookup = people.slice(0, maxLookups);

    log('INFO', 'Starting Wikipedia lookups', {
      total: people.length,
      looking_up: namesToLookup.length
    });

    // Parallel Wikipedia lookups
    const wikiResults = new Map();
    const batchSize = 5;

    for (let i = 0; i < namesToLookup.length; i += batchSize) {
      const batch = namesToLookup.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (person) => {
          const result = await lookupPerson(person.name, log);
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

    return new Response(JSON.stringify({
      success: true,
      phase: 'full',
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

/**
 * Fetch markets and extract unique people
 */
async function fetchMarketsAndPeople(limit, topN, log) {
  const allMarkets = [];

  // Fetch from events endpoint
  log('INFO', 'Fetching events from Polymarket API');
  try {
    const eventsUrl = `https://gamma-api.polymarket.com/events?limit=${limit}&active=true&closed=false`;
    const eventsResponse = await fetch(eventsUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0' }
    });

    if (eventsResponse.ok) {
      const events = await eventsResponse.json();
      log('INFO', 'Events fetched', { count: events.length });

      for (const event of events) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const market of event.markets) {
            market._source = 'events';
            market._eventSlug = event.slug; // Store parent event slug
            allMarkets.push(market);
          }
        }
      }
    }
  } catch (e) {
    log('WARN', 'Events fetch failed', { error: e.message });
  }

  // Fetch from markets endpoint
  log('INFO', 'Fetching markets from Polymarket API');
  const apiUrl = `https://gamma-api.polymarket.com/markets?limit=${Math.max(limit, 100)}&active=true&closed=false`;

  const marketResponse = await fetch(apiUrl, {
    headers: { 'User-Agent': 'PolyCrawler/1.0' }
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
      market._source = 'markets';
      allMarkets.push(market);
    }
  }

  log('INFO', 'Total unique markets', { count: allMarkets.length });

  // Extract people from markets
  const markets = [];
  const peopleMap = new Map(); // nameKey -> { name, markets: [...] }

  for (const market of allMarkets) {
    const processed = extractPeopleFromMarket(market, topN);
    if (processed.people.length > 0) {
      markets.push(processed);

      for (const person of processed.people) {
        const nameKey = person.name.toLowerCase();
        if (!peopleMap.has(nameKey)) {
          peopleMap.set(nameKey, {
            name: person.name,
            nameKey,
            markets: []
          });
        }
        peopleMap.get(nameKey).markets.push({
          title: processed.title,
          slug: processed.slug,
          conditionId: processed.conditionId,
          volume: processed.volume,
          endDate: processed.endDate,
          probability: person.probability,
          source: person.source
        });
      }
    }
  }

  const people = Array.from(peopleMap.values());
  log('INFO', 'People extracted', {
    marketsWithPeople: markets.length,
    uniquePeople: people.length
  });

  return { markets, people };
}

/**
 * Extract people from a market - both from title AND outcomes
 */
function extractPeopleFromMarket(market, topN) {
  const title = market.question || market.title || 'Unknown';
  const slug = market._eventSlug || market.slug || '';
  const conditionId = market.conditionId || market.condition_id || '';
  const volume = parseFloat(market.volume || 0);
  const endDate = market.endDate || market.end_date_iso || null;

  const people = [];
  const seenNames = new Set();

  // Extract from outcomes
  const outcomeNames = extractFromOutcomes(market, topN);
  for (const { name, probability } of outcomeNames) {
    const normalized = name.toLowerCase();
    if (!seenNames.has(normalized)) {
      seenNames.add(normalized);
      people.push({ name, probability, source: 'outcome' });
    }
  }

  // Extract from title
  const titleNames = extractNamesFromText(title);
  for (const name of titleNames) {
    const normalized = name.toLowerCase();
    if (!seenNames.has(normalized)) {
      seenNames.add(normalized);
      people.push({ name, probability: null, source: 'title' });
    }
  }

  return { title, slug, conditionId, volume, endDate, people };
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

  // Extract ALL valid person names from outcomes (no limit)
  // Parse patterns like "Sam Altman - OpenAI" to get just the name
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

/**
 * Parse person name from outcome strings like:
 * - "Sam Altman - OpenAI" -> "Sam Altman"
 * - "Tim Cook - Apple" -> "Tim Cook"
 * - "John Smith" -> "John Smith"
 */
function parsePersonFromOutcome(outcomeStr) {
  if (!outcomeStr) return null;

  // Pattern: "Name - Company" or "Name (Company)" or "Name, Title"
  let name = outcomeStr;

  // Remove company/title after dash
  if (name.includes(' - ')) {
    name = name.split(' - ')[0].trim();
  }

  // Remove company/title in parentheses
  name = name.replace(/\s*\([^)]*\)\s*/g, '').trim();

  // Remove company/title after comma
  if (name.includes(', ')) {
    const parts = name.split(', ');
    // Keep first part if it looks like a name (has multiple words)
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

  // Filter out names starting with common question words
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

async function lookupPerson(name, log) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=5&format=json&origin=*`;

    const searchResponse = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0' }
    });

    if (!searchResponse.ok) {
      return { found: false, status: `Wikipedia search failed: ${searchResponse.status}` };
    }

    const searchData = await searchResponse.json();
    const results = searchData.query?.search || [];

    if (results.length === 0) {
      return { found: false, status: 'Wikipedia page not found' };
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
      headers: { 'User-Agent': 'PolyCrawler/1.0' }
    });

    if (!contentResponse.ok) {
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
      return {
        found: true,
        wikipediaUrl,
        birthDate: birthInfo.formatted,
        birthDateRaw: birthInfo.raw,
        status: 'Found'
      };
    } else {
      return {
        found: true,
        wikipediaUrl,
        birthDate: null,
        birthDateRaw: null,
        status: 'Birth date not found on Wikipedia'
      };
    }
  } catch (error) {
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

export const config = {
  path: "/api/crawl"
};
