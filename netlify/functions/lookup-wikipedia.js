/**
 * Netlify Function: Look up a person on Wikipedia and extract birth date
 */

export default async (request, context) => {
  const url = new URL(request.url);
  const name = url.searchParams.get('name');

  if (!name) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Name parameter required'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const result = await lookupPerson(name);

    return new Response(JSON.stringify({
      success: true,
      ...result
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      name,
      found: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

async function lookupPerson(name) {
  // Search Wikipedia for the person
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=5&format=json`;

  const searchResponse = await fetch(searchUrl, {
    headers: { 'User-Agent': 'PolyCrawler/1.0 (Horoscope research)' }
  });

  if (!searchResponse.ok) {
    throw new Error(`Wikipedia search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();
  const results = searchData.query?.search || [];

  if (results.length === 0) {
    return {
      name,
      found: false,
      status: 'Wikipedia page not found'
    };
  }

  // Find best match
  const nameLower = name.toLowerCase();
  let title = results[0].title;

  for (const result of results) {
    if (nameLower === result.title.toLowerCase() ||
        result.title.toLowerCase().includes(nameLower)) {
      title = result.title;
      break;
    }
  }

  // Get page content
  const contentUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json`;

  const contentResponse = await fetch(contentUrl, {
    headers: { 'User-Agent': 'PolyCrawler/1.0 (Horoscope research)' }
  });

  if (!contentResponse.ok) {
    throw new Error(`Wikipedia content fetch failed: ${contentResponse.status}`);
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
      name,
      found: false,
      status: 'Wikipedia page not found'
    };
  }

  const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const birthInfo = extractBirthDate(wikitext);

  if (birthInfo) {
    return {
      name,
      found: true,
      wikipediaUrl,
      birthDate: birthInfo.formatted,
      birthDateRaw: birthInfo.raw,
      status: 'Found'
    };
  } else {
    return {
      name,
      found: true,
      wikipediaUrl,
      birthDate: null,
      birthDateRaw: null,
      status: 'Birth date not found on Wikipedia'
    };
  }
}

function extractBirthDate(wikitext) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  // Pattern 1: {{birth date and age|YYYY|MM|DD}}
  let match = wikitext.match(/\{\{[Bb]irth date(?: and age)?\|(\d{4})\|(\d{1,2})\|(\d{1,2})/);
  if (match) {
    const [_, year, month, day] = match;
    const monthName = months[parseInt(month) - 1];
    return {
      formatted: `${monthName} ${parseInt(day)}, ${year}`,
      raw: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    };
  }

  // Pattern 2: birth_date = {{birth date and age|...}}
  match = wikitext.match(/birth_date\s*=\s*\{\{[^|]+\|(\d{4})\|(\d{1,2})\|(\d{1,2})/i);
  if (match) {
    const [_, year, month, day] = match;
    const monthName = months[parseInt(month) - 1];
    return {
      formatted: `${monthName} ${parseInt(day)}, ${year}`,
      raw: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
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
        raw: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
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
        raw: `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`
      };
    }
  }

  // Pattern 5: Just year {{birth year and age|1962}}
  match = wikitext.match(/\{\{[Bb]irth year(?: and age)?\|(\d{4})/);
  if (match) {
    const year = match[1];
    return {
      formatted: `${year} (month/day unknown)`,
      raw: year
    };
  }

  return null;
}

export const config = {
  path: "/api/lookup-wikipedia"
};
