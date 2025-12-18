/**
 * Misses Registry - Track entities where birthdate lookup failed
 *
 * This registry helps:
 * 1. Avoid repeated Wikipedia API calls for known failures
 * 2. Prioritize manual review (most-requested duds first)
 * 3. Enable future smarts (flag bands, roles, organizations)
 * 4. Allow manual resolution with correct birthdates
 *
 * Examples of duds:
 * - "One Direction" - band, not a person
 * - "Secretary of State" - role, not a specific person
 * - "John Smith" - too ambiguous, wrong Wikipedia page found
 */

import { getStore } from '@netlify/blobs';
import { createLogger } from './logger.js';
import { normalizeName } from './utils.js';

const logger = createLogger('misses-registry');

const MISSES_STORE_NAME = 'misses-registry';

// Don't retry Wikipedia for this many days after a miss
const MISS_COOLDOWN_DAYS = 7;

/**
 * Reason why the lookup failed
 */
export type MissReason =
  | 'not-found'           // Wikipedia page not found
  | 'no-birthdate'        // Page found but no birthdate
  | 'low-confidence'      // Birthdate found but confidence too low
  | 'ambiguous'           // Multiple possible matches
  | 'not-a-person';       // Detected as band, org, role, etc.

/**
 * Entity type hints for future smart handling
 */
export type EntityType =
  | 'unknown'
  | 'person'
  | 'band'
  | 'organization'
  | 'role'                // e.g., "Secretary of State"
  | 'fictional';          // e.g., character names

/**
 * Miss registry entry
 */
export interface MissEntry {
  // Core data
  originalName: string;         // The name as it appeared in the market
  reason: MissReason;

  // Metadata
  firstSeenAt: string;          // ISO timestamp
  lastSeenAt: string;           // ISO timestamp
  seenCount: number;            // How many times this entity appeared

  // Entity classification (for future smart handling)
  entityType: EntityType;
  entityTypeConfidence: number; // 0-100, how sure we are about the type

  // Wikipedia info (if page was found)
  wikipediaUrl?: string;
  wikipediaTitle?: string;

  // For manual resolution
  resolvedBirthDate?: string;   // If manually added later
  resolvedAt?: string;
  notes?: string;               // Manual notes about this entity

  // Market context (helps understand what this entity is)
  sampleMarkets: string[];      // Up to 3 market titles where this appeared
}

/**
 * Misses registry statistics
 */
export interface MissesStats {
  totalMisses: number;
  byReason: Record<MissReason, number>;
  byEntityType: Record<EntityType, number>;
  recentlyAdded: number;        // Added in last 24h
}

// In-memory stats for current request
let requestStats = {
  checked: 0,
  newMisses: 0,
  existingMisses: 0,
  cooldownSkips: 0
};

/**
 * Reset stats for a new request
 */
export function resetMissesStats(): void {
  requestStats = {
    checked: 0,
    newMisses: 0,
    existingMisses: 0,
    cooldownSkips: 0
  };
}

/**
 * Get current request stats
 */
export function getMissesRequestStats() {
  return { ...requestStats };
}

/**
 * Check if an entity is in the misses registry and still in cooldown
 * Returns the entry if found and in cooldown, null otherwise
 */
export async function checkMissesRegistry(name: string): Promise<MissEntry | null> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const key = normalizeName(name);
    const entry = await store.get(key, { type: 'json' }) as MissEntry | null;

    requestStats.checked++;

    if (entry) {
      // Check if still in cooldown
      const lastSeen = new Date(entry.lastSeenAt);
      const now = new Date();
      const daysSinceLastSeen = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceLastSeen < MISS_COOLDOWN_DAYS) {
        requestStats.cooldownSkips++;
        logger.debug('Miss registry hit (in cooldown)', {
          name: key,
          reason: entry.reason,
          daysSinceLastSeen: Math.round(daysSinceLastSeen)
        });

        // Update seen count (fire and forget)
        updateMissSeenCount(key, entry).catch(() => {});

        return entry;
      }

      // Cooldown expired, allow retry
      logger.debug('Miss registry hit (cooldown expired)', { name: key });
      requestStats.existingMisses++;
    }

    return null;
  } catch (error) {
    logger.warn('Misses registry read failed', { name, error: (error as Error).message });
    return null;
  }
}

/**
 * Add or update an entry in the misses registry
 */
export async function addToMissesRegistry(
  name: string,
  reason: MissReason,
  options: {
    wikipediaUrl?: string;
    wikipediaTitle?: string;
    marketTitle?: string;
    entityType?: EntityType;
  } = {}
): Promise<boolean> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const key = normalizeName(name);
    const now = new Date().toISOString();

    // Check for existing entry
    const existing = await store.get(key, { type: 'json' }) as MissEntry | null;

    // Build sample markets list (keep up to 3)
    let sampleMarkets = existing?.sampleMarkets ?? [];
    if (options.marketTitle && !sampleMarkets.includes(options.marketTitle)) {
      sampleMarkets = [...sampleMarkets, options.marketTitle].slice(-3);
    }

    const entry: MissEntry = {
      originalName: existing?.originalName ?? name,
      reason: reason,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      seenCount: (existing?.seenCount ?? 0) + 1,
      entityType: options.entityType ?? existing?.entityType ?? 'unknown',
      entityTypeConfidence: existing?.entityTypeConfidence ?? 0,
      wikipediaUrl: options.wikipediaUrl ?? existing?.wikipediaUrl,
      wikipediaTitle: options.wikipediaTitle ?? existing?.wikipediaTitle,
      sampleMarkets,
      // Preserve manual resolution if exists
      resolvedBirthDate: existing?.resolvedBirthDate,
      resolvedAt: existing?.resolvedAt,
      notes: existing?.notes
    };

    await store.setJSON(key, entry);

    if (existing) {
      requestStats.existingMisses++;
      logger.debug('Updated miss entry', { name: key, seenCount: entry.seenCount });
    } else {
      requestStats.newMisses++;
      logger.info('Added to misses registry', { name: key, reason });
    }

    return true;
  } catch (error) {
    logger.warn('Misses registry write failed', { name, error: (error as Error).message });
    return false;
  }
}

/**
 * Update seen count without changing other fields
 */
async function updateMissSeenCount(key: string, entry: MissEntry): Promise<void> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const updated: MissEntry = {
      ...entry,
      lastSeenAt: new Date().toISOString(),
      seenCount: entry.seenCount + 1
    };
    await store.setJSON(key, updated);
  } catch (error) {
    logger.debug('Failed to update miss seen count', { key });
  }
}

/**
 * Manually resolve a miss with a birthdate
 */
export async function resolveMiss(
  name: string,
  birthDate: string,
  notes?: string
): Promise<boolean> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const key = normalizeName(name);

    const existing = await store.get(key, { type: 'json' }) as MissEntry | null;
    if (!existing) {
      logger.warn('Cannot resolve miss - entry not found', { name: key });
      return false;
    }

    const updated: MissEntry = {
      ...existing,
      resolvedBirthDate: birthDate,
      resolvedAt: new Date().toISOString(),
      notes: notes ?? existing.notes
    };

    await store.setJSON(key, updated);
    logger.info('Resolved miss with birthdate', { name: key, birthDate });
    return true;
  } catch (error) {
    logger.warn('Failed to resolve miss', { name, error: (error as Error).message });
    return false;
  }
}

/**
 * Update entity type classification
 */
export async function classifyMiss(
  name: string,
  entityType: EntityType,
  confidence: number = 80,
  notes?: string
): Promise<boolean> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const key = normalizeName(name);

    const existing = await store.get(key, { type: 'json' }) as MissEntry | null;
    if (!existing) {
      return false;
    }

    const updated: MissEntry = {
      ...existing,
      entityType,
      entityTypeConfidence: confidence,
      notes: notes ?? existing.notes
    };

    await store.setJSON(key, updated);
    logger.info('Classified miss', { name: key, entityType });
    return true;
  } catch (error) {
    logger.warn('Failed to classify miss', { name, error: (error as Error).message });
    return false;
  }
}

/**
 * Get all misses, sorted by seenCount (most requested first)
 */
export async function listMisses(options: {
  limit?: number;
  reason?: MissReason;
  entityType?: EntityType;
  unresolvedOnly?: boolean;
} = {}): Promise<MissEntry[]> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const { blobs } = await store.list();

    const entries: MissEntry[] = [];

    for (const blob of blobs) {
      const entry = await store.get(blob.key, { type: 'json' }) as MissEntry;
      if (!entry) continue;

      // Apply filters
      if (options.reason && entry.reason !== options.reason) continue;
      if (options.entityType && entry.entityType !== options.entityType) continue;
      if (options.unresolvedOnly && entry.resolvedBirthDate) continue;

      entries.push(entry);
    }

    // Sort by seenCount descending (most requested first)
    entries.sort((a, b) => b.seenCount - a.seenCount);

    // Apply limit
    const limit = options.limit ?? 100;
    return entries.slice(0, limit);
  } catch (error) {
    logger.warn('Failed to list misses', { error: (error as Error).message });
    return [];
  }
}

/**
 * Get misses registry statistics
 */
export async function getMissesStats(): Promise<MissesStats> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const { blobs } = await store.list();

    const stats: MissesStats = {
      totalMisses: 0,
      byReason: {
        'not-found': 0,
        'no-birthdate': 0,
        'low-confidence': 0,
        'ambiguous': 0,
        'not-a-person': 0
      },
      byEntityType: {
        'unknown': 0,
        'person': 0,
        'band': 0,
        'organization': 0,
        'role': 0,
        'fictional': 0
      },
      recentlyAdded: 0
    };

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const blob of blobs) {
      const entry = await store.get(blob.key, { type: 'json' }) as MissEntry;
      if (!entry) continue;

      stats.totalMisses++;
      stats.byReason[entry.reason]++;
      stats.byEntityType[entry.entityType]++;

      if (new Date(entry.firstSeenAt) > oneDayAgo) {
        stats.recentlyAdded++;
      }
    }

    return stats;
  } catch (error) {
    logger.warn('Failed to get misses stats', { error: (error as Error).message });
    return {
      totalMisses: 0,
      byReason: {
        'not-found': 0,
        'no-birthdate': 0,
        'low-confidence': 0,
        'ambiguous': 0,
        'not-a-person': 0
      },
      byEntityType: {
        'unknown': 0,
        'person': 0,
        'band': 0,
        'organization': 0,
        'role': 0,
        'fictional': 0
      },
      recentlyAdded: 0
    };
  }
}

/**
 * Delete a miss entry (e.g., after adding to birthdate registry)
 */
export async function deleteMiss(name: string): Promise<boolean> {
  try {
    const store = getStore(MISSES_STORE_NAME);
    const key = normalizeName(name);
    await store.delete(key);
    logger.info('Deleted from misses registry', { name: key });
    return true;
  } catch (error) {
    logger.warn('Failed to delete miss', { name, error: (error as Error).message });
    return false;
  }
}

/**
 * Detect if a name looks like a non-person entity
 * Returns suggested entity type and confidence
 */
export function detectEntityType(name: string): { type: EntityType; confidence: number } {
  const lower = name.toLowerCase();

  // Band/group indicators
  const bandPatterns = [
    /\band\b/,                    // "X and the Y"
    /\bthe\s+\w+s\b/,            // "The Beatles"
    /\b(band|group|duo|trio|quartet)\b/i,
    /\b(direction|backstreet|boys|girls|spice)\b/i
  ];
  for (const pattern of bandPatterns) {
    if (pattern.test(lower)) {
      return { type: 'band', confidence: 70 };
    }
  }

  // Role/position indicators
  const rolePatterns = [
    /\b(secretary|minister|director|chairman|president|ceo|cfo)\b/i,
    /\b(of state|of defense|of treasury|of commerce)\b/i,
    /\b(general|admiral|commander)\b/i
  ];
  for (const pattern of rolePatterns) {
    if (pattern.test(lower)) {
      return { type: 'role', confidence: 60 };
    }
  }

  // Organization indicators
  const orgPatterns = [
    /\b(inc|corp|llc|ltd|company|foundation|institute)\b/i,
    /\b(university|college|school|academy)\b/i,
    /\b(party|committee|council|commission)\b/i
  ];
  for (const pattern of orgPatterns) {
    if (pattern.test(lower)) {
      return { type: 'organization', confidence: 70 };
    }
  }

  return { type: 'unknown', confidence: 0 };
}
