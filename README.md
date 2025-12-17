# PolyCrawler

Extract public figure birth dates from Polymarket prediction markets for horoscope analysis.

## Implementations

PolyCrawler has two implementations:

| Implementation | Location | Status | Best For |
|---------------|----------|--------|----------|
| **Web/Netlify (TypeScript)** | `netlify/functions/` | ✅ Active | Production web deployments |
| **Python CLI** | `src/` | ⚠️ Legacy | Local batch processing |

**Recommended**: Use the TypeScript/Netlify implementation for new projects. It includes:
- Rate limiting for Wikipedia API
- Multi-layer caching (celebrity DB + Netlify Blobs)
- Fuzzy name deduplication
- NLP-based name extraction
- Progressive loading for large datasets
- TypeScript type safety

## Quick Start (Web)

```bash
# Install dependencies
npm install

# Run locally with Netlify CLI
npm run dev

# Open http://localhost:8888
```

## Quick Start (Python CLI - Legacy)

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run crawler
python src/main.py --markets 50 --top 4
```

## Data Flow

```
Polymarket API
  ↓
Extract markets & identify people
  ├── Celebrity database check (instant)
  ├── Netlify Blobs cache (30-day TTL)
  └── Wikipedia API lookup
  ↓
Confidence scoring & deduplication
  ↓
Output: JSON API / Google Sheets / CSV
```

## API Endpoints (Netlify)

| Endpoint | Description |
|----------|-------------|
| `GET /api/crawl?phase=markets` | Fetch markets and extract people list |
| `GET /api/crawl?phase=lookup&names=[...]` | Look up batch of people |
| `GET /api/crawl?phase=cache-status&names=[...]` | Check cache status |
| `GET /api/crawl` | Full crawl (legacy mode) |

### Query Parameters

- `limit` - Maximum markets to fetch (default: 50)
- `top` - Top contenders per market (default: 4)
- `since` - ISO date for incremental crawls

## Project Structure

```
PolyCrawler/
├── netlify/functions/          # TypeScript serverless functions
│   ├── crawl.js               # Main crawl function
│   ├── lib/
│   │   ├── types.ts           # TypeScript type definitions
│   │   ├── logger.ts          # Structured logging
│   │   ├── config.ts          # Environment configuration
│   │   ├── rate-limiter.ts    # API rate limiting
│   │   ├── utils.ts           # Shared utilities
│   │   └── name-extractor.ts  # NLP-based name extraction
│   └── data/
│       └── celebrities.json   # Pre-computed celebrity database
├── src/                        # Python CLI (legacy)
│   ├── main.py
│   ├── polymarket.py
│   ├── wikipedia_lookup.py
│   └── sheets.py
├── public/                     # Frontend static files
├── tests/                      # Unit tests
└── package.json
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level (DEBUG, INFO, WARN, ERROR) | INFO |
| `WIKI_RATE_LIMIT_PER_SECOND` | Wikipedia API rate limit | 5 |
| `CACHE_TTL_DAYS` | Cache expiration in days | 30 |
| `MAX_BATCH_SIZE` | Max batch size for lookups | 15 |
| `GOOGLE_CREDENTIALS_PATH` | Path to Google credentials | - |
| `GOOGLE_SHEET_ID` | Google Sheet ID for output | - |

### Google Sheets (Optional)

1. Create a Google Cloud project and enable Google Sheets API
2. Create a service account and download credentials JSON
3. Share your Google Sheet with the service account email
4. Set environment variables

## Development

```bash
# Install dependencies
npm install

# Run TypeScript compiler (watch mode)
npm run build:watch

# Run tests
npm test

# Type check
npm run typecheck

# Local development server
npm run dev
```

## Output Schema

```typescript
interface CrawlResult {
  marketTitle: string;
  marketSlug: string;
  eventTitle: string | null;
  marketConditionId: string;
  marketVolume: number;
  marketEndDate: string | null;
  personName: string;
  probability: number | null;
  birthDate: string | null;
  birthDateRaw: string | null;
  wikipediaUrl: string;
  confidence: number;        // 0-100
  status: string;
  source: 'celebrity-db' | 'cache' | 'wikipedia';
}
```

## Celebrity Database

The pre-computed celebrity database (`celebrities.json`) includes 170+ public figures:
- Political leaders (US, world)
- Tech executives
- Entertainment personalities
- Sports figures
- Financial leaders

This provides instant lookups without Wikipedia API calls.

## Python CLI Options (Legacy)

| Option | Default | Description |
|--------|---------|-------------|
| `--markets`, `-m` | 100 | Maximum markets to fetch |
| `--top`, `-t` | 4 | Top contenders per market |
| `--output`, `-o` | both | Output: `sheets`, `csv`, or `both` |
| `--csv-path` | polymarket_contenders.csv | CSV output path |
| `--clear` | False | Clear existing sheet data |
| `--quiet`, `-q` | False | Suppress progress output |

## Data Sources

- **Polymarket API**: Public prediction market data
- **Wikipedia API**: Birth date extraction from infoboxes

This tool only extracts publicly available information.

## License

MIT
