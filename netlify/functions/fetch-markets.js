/**
 * Netlify Function: Fetch active markets from Polymarket API
 */

/**
 * Polymarket category slug mapping
 */
const CATEGORY_SLUGS = {
  'politics': 'politics',
  'sports': 'sports',
  'finance': 'finance',
  'crypto': 'crypto',
  'geopolitics': 'geopolitics',
  'earnings': 'earnings',
  'tech': 'tech',
  'culture': 'culture',
  'world': 'world',
  'economy': 'economy',
  'elections': 'elections',
  'mentions': 'mentions'
};

export default async (request, context) => {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const topN = parseInt(url.searchParams.get('top')) || 4;
  const category = url.searchParams.get('category') || '';

  // Build category filter parameter
  const categorySlug = category ? CATEGORY_SLUGS[category.toLowerCase()] : '';
  const tagParam = categorySlug ? `&tag_slug=${categorySlug}` : '';

  try {
    // Fetch markets from Polymarket
    const apiUrl = `https://gamma-api.polymarket.com/markets?limit=${limit}&active=true&closed=false${tagParam}`;

    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'PolyCheck/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status}`);
    }

    const rawMarkets = await response.json();

    // Process markets to extract person contenders
    const markets = [];

    for (const market of rawMarkets) {
      const processed = extractContenders(market, topN);
      if (processed.contenders.length > 0) {
        markets.push(processed);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      category: category || 'all',
      count: markets.length,
      markets
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

  // Handle different API response formats
  if (market.tokens) {
    for (const token of market.tokens) {
      const name = token.outcome || '';
      const price = parseFloat(token.price || 0);
      outcomes.push({ name, probability: price * 100 });
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
      const name = outcomeNames[i];
      const price = parseFloat(prices[i] || 0);
      outcomes.push({ name, probability: price * 100 });
    }
  }

  // Sort by probability and take top N
  outcomes.sort((a, b) => b.probability - a.probability);
  const topOutcomes = outcomes.slice(0, topN);

  // Filter to only person names
  const contenders = topOutcomes
    .filter(o => o.name && looksLikePersonName(o.name))
    .map(o => ({
      name: o.name,
      probability: o.probability
    }));

  return {
    title,
    slug,
    volume,
    endDate,
    contenders
  };
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

export const config = {
  path: "/api/fetch-markets"
};
