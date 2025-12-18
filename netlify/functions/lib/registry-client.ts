/**
 * Birthdate Registry - Persistent storage for discovered birthdates
 *
 * Unlike the regular cache (30-day TTL), the registry stores high-confidence
 * birthdates permanently. This allows PolyCrawler to build knowledge over time
 * and become less dependent on Wikipedia API calls.
 *
 * Storage hierarchy:
 * 1. Celebrity DB (static, instant)
 * 2. Birthdate Registry (persistent, high-confidence only)
 * 3. Wiki Cache (30-day TTL, all results)
 * 4. Wikipedia API (live fetch)
 */

import { getStore } from '@netlify/blobs';
import { createLogger } from './logger.js';
import { normalizeName } from './utils.js';
import type { WikipediaResult } from './types.js';

const logger = createLogger('registry');

// Registry store name (separate from wiki-cache)
const REGISTRY_STORE_NAME = 'birthdate-registry';

// Minimum confidence threshold to store in registry
const MIN_CONFIDENCE_FOR_REGISTRY = 80;

/**
 * Registry entry with metadata
 */
export interface RegistryEntry {
  // Core birthdate data
  birthDate: string;
  birthDateRaw: string;
  wikipediaUrl?: string;
  confidence: number;

  // Metadata
  addedAt: string;           // ISO timestamp when first added
  lastAccessedAt: string;    // ISO timestamp of last access
  accessCount: number;       // How many times this entry was used
  source: 'wikipedia' | 'cache' | 'manual';  // Original source

  // Optional enrichment
  variants?: string[];       // Alternative name spellings that resolved to this
}

/**
 * Registry statistics
 */
export interface RegistryStats {
  totalEntries: number;
  hits: number;
  misses: number;
  writes: number;
}

// In-memory stats for current request
let requestStats: RegistryStats = {
  totalEntries: 0,
  hits: 0,
  misses: 0,
  writes: 0
};

/**
 * Reset stats for a new request
 */
export function resetRegistryStats(): void {
  requestStats = {
    totalEntries: 0,
    hits: 0,
    misses: 0,
    writes: 0
  };
}

/**
 * Get current registry stats
 */
export function getRegistryStats(): RegistryStats {
  return { ...requestStats };
}

/**
 * Check if a result qualifies for registry storage
 */
export function qualifiesForRegistry(result: WikipediaResult): boolean {
  return (
    result.found &&
    result.birthDate != null &&
    result.birthDateRaw != null &&
    (result.confidence ?? 0) >= MIN_CONFIDENCE_FOR_REGISTRY
  );
}

/**
 * Look up a name in the birthdate registry
 */
export async function getFromRegistry(name: string): Promise<WikipediaResult | null> {
  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const key = normalizeName(name);
    const entry = await store.get(key, { type: 'json' }) as RegistryEntry | null;

    if (entry) {
      requestStats.hits++;
      logger.debug('Registry hit', { name: key, accessCount: entry.accessCount });

      // Update access metadata (fire and forget)
      updateAccessMetadata(key, entry).catch(() => {});

      return {
        found: true,
        birthDate: entry.birthDate,
        birthDateRaw: entry.birthDateRaw,
        wikipediaUrl: entry.wikipediaUrl,
        confidence: entry.confidence,
        status: 'Found',
        source: 'registry'
      };
    }

    requestStats.misses++;
    return null;
  } catch (error) {
    logger.warn('Registry read failed', { name, error: (error as Error).message });
    requestStats.misses++;
    return null;
  }
}

/**
 * Store a birthdate in the registry (only if it qualifies)
 */
export async function addToRegistry(
  name: string,
  result: WikipediaResult,
  originalSource: 'wikipedia' | 'cache' = 'wikipedia'
): Promise<boolean> {
  // Only store high-confidence results with actual birthdates
  if (!qualifiesForRegistry(result)) {
    logger.debug('Result does not qualify for registry', {
      name,
      confidence: result.confidence,
      hasBirthDate: !!result.birthDate
    });
    return false;
  }

  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const key = normalizeName(name);

    // Check if entry already exists
    const existing = await store.get(key, { type: 'json' }) as RegistryEntry | null;

    const now = new Date().toISOString();

    const entry: RegistryEntry = {
      birthDate: result.birthDate!,
      birthDateRaw: result.birthDateRaw!,
      wikipediaUrl: result.wikipediaUrl,
      confidence: result.confidence ?? MIN_CONFIDENCE_FOR_REGISTRY,
      addedAt: existing?.addedAt ?? now,
      lastAccessedAt: now,
      accessCount: (existing?.accessCount ?? 0) + 1,
      source: existing?.source ?? originalSource,
      variants: existing?.variants ?? []
    };

    await store.setJSON(key, entry);
    requestStats.writes++;

    logger.info('Added to registry', {
      name: key,
      confidence: entry.confidence,
      isUpdate: !!existing
    });

    return true;
  } catch (error) {
    logger.warn('Registry write failed', { name, error: (error as Error).message });
    return false;
  }
}

/**
 * Add a name variant that resolves to an existing entry
 */
export async function addNameVariant(
  variant: string,
  canonicalName: string
): Promise<boolean> {
  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const canonicalKey = normalizeName(canonicalName);
    const variantKey = normalizeName(variant);

    // Get the canonical entry
    const entry = await store.get(canonicalKey, { type: 'json' }) as RegistryEntry | null;
    if (!entry) {
      return false;
    }

    // Add variant to the list if not already present
    if (!entry.variants) {
      entry.variants = [];
    }
    if (!entry.variants.includes(variantKey)) {
      entry.variants.push(variantKey);
      await store.setJSON(canonicalKey, entry);
    }

    // Also create a pointer entry for the variant
    await store.setJSON(variantKey, entry);

    logger.debug('Added name variant', { variant: variantKey, canonical: canonicalKey });
    return true;
  } catch (error) {
    logger.warn('Failed to add name variant', { variant, error: (error as Error).message });
    return false;
  }
}

/**
 * Update access metadata for a registry entry
 */
async function updateAccessMetadata(key: string, entry: RegistryEntry): Promise<void> {
  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const updated: RegistryEntry = {
      ...entry,
      lastAccessedAt: new Date().toISOString(),
      accessCount: entry.accessCount + 1
    };
    await store.setJSON(key, updated);
  } catch (error) {
    // Silently fail - this is just metadata
    logger.debug('Failed to update access metadata', { key });
  }
}

/**
 * Get registry entry count (approximate - scans keys)
 */
export async function getRegistrySize(): Promise<number> {
  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const { blobs } = await store.list();
    requestStats.totalEntries = blobs.length;
    return blobs.length;
  } catch (error) {
    logger.warn('Failed to get registry size', { error: (error as Error).message });
    return 0;
  }
}

/**
 * List all registry entries (for debugging/admin)
 */
export async function listRegistryEntries(limit: number = 100): Promise<Array<{ key: string; entry: RegistryEntry }>> {
  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const { blobs } = await store.list();

    const entries: Array<{ key: string; entry: RegistryEntry }> = [];

    for (const blob of blobs.slice(0, limit)) {
      const entry = await store.get(blob.key, { type: 'json' }) as RegistryEntry;
      if (entry) {
        entries.push({ key: blob.key, entry });
      }
    }

    return entries;
  } catch (error) {
    logger.warn('Failed to list registry entries', { error: (error as Error).message });
    return [];
  }
}

/**
 * Delete a registry entry (for corrections)
 */
export async function deleteFromRegistry(name: string): Promise<boolean> {
  try {
    const store = getStore(REGISTRY_STORE_NAME);
    const key = normalizeName(name);
    await store.delete(key);
    logger.info('Deleted from registry', { name: key });
    return true;
  } catch (error) {
    logger.warn('Failed to delete from registry', { name, error: (error as Error).message });
    return false;
  }
}
