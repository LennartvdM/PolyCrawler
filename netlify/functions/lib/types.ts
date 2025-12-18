/**
 * Shared type definitions for PolyCheck
 */

// Person information from Polymarket
export interface Person {
  name: string;
  nameKey: string;
  markets: MarketInfo[];
}

// Market information
export interface MarketInfo {
  title: string;
  slug: string;
  eventTitle: string | null;
  conditionId: string;
  volume: number;
  endDate: string | null;
  probability: number | null;
  source: 'outcome' | 'title';
}

// Birth date extraction result
export interface BirthInfo {
  formatted: string;
  raw: string;
  confidence: number;
  source: 'infobox' | 'infobox-year' | 'text' | 'text-year';
}

// Wikipedia lookup result
export interface WikipediaResult {
  found: boolean;
  birthDate?: string | null;
  birthDateRaw?: string | null;
  wikipediaUrl?: string;
  confidence?: number;
  status: string;
  source: 'celebrity-db' | 'cache' | 'wikipedia' | 'wikipedia-error';
  matchedAs?: string;
  cachedAt?: string;
}

// Celebrity database entry
export interface CelebrityEntry {
  birthDate: string;
  birthDateRaw: string;
  wikipediaUrl: string;
  confidence: number;
}

// Celebrity database structure
export interface CelebrityDatabase {
  _metadata: {
    description: string;
    lastUpdated: string;
    source: string;
  };
  celebrities: Record<string, CelebrityEntry>;
}

// Cache status result
export interface CacheStatus {
  name: string;
  cached: boolean;
  source?: 'celebrity-db' | 'blob-cache';
}

// Crawl result for a person
export interface CrawlResult {
  marketTitle: string;
  marketSlug: string;
  eventTitle: string | null;
  marketConditionId: string;
  marketVolume: number;
  marketEndDate: string | null;
  personName: string;
  probability: number | null;
  nameSource: 'outcome' | 'title';
  found: boolean;
  birthDate?: string | null;
  birthDateRaw?: string | null;
  wikipediaUrl?: string;
  confidence?: number;
  status: string;
  source?: string;
}

// Crawl statistics
export interface CrawlStats {
  totalMarkets: number;
  totalPeople: number;
  uniquePeople: number;
  lookedUp: number;
  birthDatesFound: number;
  wikipediaNotFound: number;
  birthDateMissing: number;
}

// Log entry
export interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  context: string;
  message: string;
  data?: unknown;
}

// Configuration schema item
export interface ConfigSchemaItem {
  required: boolean;
  description: string;
  default: string | number | null;
  validate?: (value: string) => boolean;
  transform?: (value: string) => string | number;
}

// Validated configuration
export interface AppConfig {
  GOOGLE_CREDENTIALS_PATH: string | null;
  GOOGLE_SHEET_ID: string | null;
  WORKSHEET_NAME: string;
  LOG_LEVEL: string;
  WIKI_RATE_LIMIT_PER_SECOND: number;
  CACHE_TTL_DAYS: number;
  MAX_BATCH_SIZE: number;
}

// Rate limiter task
export interface RateLimiterTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  addedAt: number;
}

// Rate limiter stats
export interface RateLimiterStats {
  name: string;
  tokens: number;
  maxTokens: number;
  queueSize: number;
  maxQueueSize: number;
}

// Processed market with extracted people
export interface ProcessedMarket {
  title: string;
  slug: string;
  eventTitle: string | null;
  conditionId: string;
  volume: number;
  endDate: string | null;
  people: ExtractedPerson[];
}

// Person extracted from market
export interface ExtractedPerson {
  name: string;
  probability: number | null;
  source: 'outcome' | 'title';
}

// Similar person match result
export interface SimilarPersonMatch {
  person: Person;
  similarity: number;
}

// Raw Polymarket API market
export interface RawMarket {
  question?: string;
  title?: string;
  slug?: string;
  conditionId?: string;
  condition_id?: string;
  volume?: string | number;
  endDate?: string;
  end_date_iso?: string;
  startDate?: string;
  tokens?: Array<{
    outcome?: string;
    price?: string | number;
  }>;
  outcomes?: string | string[];
  outcomePrices?: string | number[];
  _source?: string;
  _eventSlug?: string;
  _eventTitle?: string;
}

// Raw Polymarket API event
export interface RawEvent {
  slug?: string;
  title?: string;
  question?: string;
  startDate?: string;
  markets?: RawMarket[];
}
