/**
 * Netlify Function: Full crawl - fetch markets and lookup all Wikipedia birth dates
 * Returns streaming progress updates
 */

export default async (request, context) => {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const topN = parseInt(url.searchParams.get('top')) || 4;

  try {
    // Step 1: Fetch markets
    const apiUrl = `https://gamma-api.polymarket.com/markets?limit=${limit}&active=true&closed=false`;

    const marketResponse = await fetch(apiUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0' }
    });

    if (!marketResponse.ok) {
      throw new Error(`Polymarket API error: ${marketResponse.status}`);
    }

    const rawMarkets = await marketResponse.json();

    // Process markets
    const markets = [];
    for (const market of rawMarkets) {
      const processed = extractContenders(market, topN);
      if (processed.contenders.length > 0) {
        markets.push(processed);
      }
    }

    // Step 2: Look up each contender on Wikipedia
    const results = [];

    for (const market of markets) {
      for (const contender of market.contenders) {
        const wikiResult = await lookupPerson(contender.name);

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

    return new Response(JSON.stringify({
      success: true,
      stats,
      results,
      crawledAt: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

function extractContenders(market, topN) {
  const title = market.question || market.title || 'Unknown';
  const slug = market.slug || '';
  const volume = parseFloat(market.volume || 0);
  const endDate = market.endDate || market.end_date_iso || null;

  let outcomes = [];

  if (market.tokens) {
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

  outcomes.sort((a, b) => b.probability - a.probability);

  const contenders = outcomes
    .slice(0, topN)
    .filter(o => o.name && looksLikePersonName(o.name))
    .map(o => ({ name: o.name, probability: o.probability }));

  return { title, slug, volume, endDate, contenders };
}

function looksLikePersonName(name) {
  const nonPersonTerms = new Set([
    'yes', 'no', 'other', 'none', 'neither', 'both',
    'before', 'after', 'over', 'under', 'between',
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ]);

  const nameLower = name.toLowerCase().trim();
  if (nonPersonTerms.has(nameLower)) return false;
  if (/^[\d,.\s]+$/.test(name)) return false;

  const parts = name.split(/\s+/);
  if (parts.length < 2) return false;
  if (/^\d/.test(parts[0])) return false;

  return true;
}

async function lookupPerson(name) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=5&format=json`;

    const searchResponse = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PolyCrawler/1.0' }
    });

    if (!searchResponse.ok) {
      return { found: false, status: 'Wikipedia search failed' };
    }

    const searchData = await searchResponse.json();
    const results = searchData.query?.search || [];

    if (results.length === 0) {
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

    // Get content
    const contentUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;

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
        zodiacSign: getZodiacSign(birthInfo.raw),
        status: 'Found'
      };
    } else {
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
  if (!dateStr || dateStr.length === 4) return null; // Year only

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
      // Capricorn spans year boundary
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
