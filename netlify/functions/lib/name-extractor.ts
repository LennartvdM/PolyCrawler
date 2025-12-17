/**
 * NLP-based name extraction using compromise library
 * Provides more reliable person detection than regex patterns
 */

import nlp from 'compromise';
import { createLogger } from './logger.js';
import type { ExtractedPerson } from './types.js';

const logger = createLogger('name-extractor');

// Known public figures for boosting recognition
const KNOWN_FIGURES: string[] = [
  // Political figures
  'Donald Trump', 'Joe Biden', 'Barack Obama', 'Vladimir Putin', 'Xi Jinping',
  'Volodymyr Zelensky', 'Emmanuel Macron', 'Olaf Scholz', 'Rishi Sunak',
  'Benjamin Netanyahu', 'Narendra Modi', 'Recep Erdogan', 'Javier Milei',
  'Kim Jong Un', 'Bashar al-Assad', 'Lula da Silva',
  // US Politicians
  'Ron DeSantis', 'Gavin Newsom', 'Nikki Haley', 'Vivek Ramaswamy', 'JD Vance',
  'Nancy Pelosi', 'Mitch McConnell', 'Chuck Schumer', 'Alexandria Ocasio-Cortez',
  'Pete Buttigieg', 'Josh Shapiro', 'Gretchen Whitmer', 'Andy Beshear', 'Mike Pence',
  'Robert F Kennedy Jr', 'Kamala Harris', 'Tim Walz', 'Doug Burgum',
  // Tech leaders
  'Elon Musk', 'Jeff Bezos', 'Mark Zuckerberg', 'Sam Altman', 'Tim Cook',
  'Sundar Pichai', 'Satya Nadella', 'Jensen Huang', 'Dario Amodei',
  'Demis Hassabis', 'Ilya Sutskever', 'Andrej Karpathy', 'Yann LeCun',
  'Geoffrey Hinton', 'Vitalik Buterin', 'Changpeng Zhao', 'Brian Armstrong',
  // Finance
  'Warren Buffett', 'Bill Gates', 'Jamie Dimon', 'Larry Fink', 'Cathie Wood',
  'Michael Saylor', 'Jerome Powell', 'Janet Yellen',
  // Entertainment & Media
  'Taylor Swift', 'Beyoncé', 'Drake', 'Kanye West', 'Joe Rogan', 'Tucker Carlson',
  'MrBeast', 'PewDiePie', 'Andrew Tate', 'Jordan Peterson', 'Ben Shapiro',
  // Sports
  'Lionel Messi', 'Cristiano Ronaldo', 'LeBron James', 'Tom Brady',
  'Patrick Mahomes', 'Travis Kelce', 'Shohei Ohtani', 'Serena Williams',
  'Novak Djokovic',
  // Royalty & Religious
  'Pope Francis', 'King Charles III', 'Prince Harry', 'Meghan Markle',
  'Prince William', 'Kate Middleton',
  // Other notable figures
  'Greta Thunberg', 'Keir Starmer'
];

// Short name variants (single names or abbreviations)
const KNOWN_SHORT_NAMES: Record<string, string> = {
  'trump': 'Donald Trump',
  'biden': 'Joe Biden',
  'obama': 'Barack Obama',
  'putin': 'Vladimir Putin',
  'zelensky': 'Volodymyr Zelensky',
  'macron': 'Emmanuel Macron',
  'musk': 'Elon Musk',
  'bezos': 'Jeff Bezos',
  'ye': 'Kanye West',
  'drake': 'Drake',
  'aoc': 'Alexandria Ocasio-Cortez',
  'mtg': 'Marjorie Taylor Greene',
  'rfk': 'Robert F Kennedy Jr',
  'rfk jr': 'Robert F Kennedy Jr',
  'sbf': 'Sam Bankman-Fried',
  'cz': 'Changpeng Zhao',
  'altman': 'Sam Altman'
};

// Non-person terms to filter out
const NON_PERSON_TERMS = new Set([
  'yes', 'no', 'other', 'none', 'neither', 'both', 'will',
  'before', 'after', 'over', 'under', 'between', 'higher', 'lower', 'same',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'q1', 'q2', 'q3', 'q4', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday'
]);

// Non-person phrases to filter out
const NON_PERSON_PHRASES = [
  'united states', 'united kingdom', 'united nations', 'european union',
  'north korea', 'south korea', 'new york', 'los angeles', 'san francisco',
  'wall street', 'silicon valley', 'white house', 'supreme court',
  'federal reserve', 'world war', 'middle east', 'hong kong',
  'super bowl', 'world cup', 'champions league', 'grand prix',
  'prime minister', 'president of', 'secretary of'
];

/**
 * Check if a string is likely a person name
 */
function isLikelyPersonName(name: string): boolean {
  const lower = name.toLowerCase().trim();

  // Filter out non-person terms
  if (NON_PERSON_TERMS.has(lower)) return false;

  // Filter out phrases that start with common question words
  if (/^(will|when|what|how|who|which)\s/i.test(name)) return false;

  // Filter out non-person phrases
  for (const phrase of NON_PERSON_PHRASES) {
    if (lower.includes(phrase)) return false;
  }

  // Filter out numbers and percentages
  if (/^[\d,.\s%$€£]+$/.test(name)) return false;
  if (/^\d/.test(name)) return false;

  // Single words need to be known figures
  const parts = name.split(/\s+/);
  if (parts.length < 2) {
    return KNOWN_SHORT_NAMES[lower] !== undefined ||
           KNOWN_FIGURES.some(f => f.toLowerCase().split(/\s+/).includes(lower));
  }

  // Must be reasonable length
  if (parts.length > 5) return false;

  return true;
}

/**
 * Extract person names from text using NLP
 */
export function extractNamesFromText(text: string): string[] {
  const names: string[] = [];
  const seenLower = new Set<string>();

  // First, check for known figures (highest priority)
  for (const figure of KNOWN_FIGURES) {
    const regex = new RegExp(`\\b${escapeRegex(figure)}\\b`, 'i');
    if (regex.test(text)) {
      const lower = figure.toLowerCase();
      if (!seenLower.has(lower)) {
        names.push(figure);
        seenLower.add(lower);
      }
    }
  }

  // Check for short name variants
  for (const [short, full] of Object.entries(KNOWN_SHORT_NAMES)) {
    const regex = new RegExp(`\\b${escapeRegex(short)}\\b`, 'i');
    if (regex.test(text)) {
      const lower = full.toLowerCase();
      if (!seenLower.has(lower)) {
        names.push(full);
        seenLower.add(lower);
      }
    }
  }

  // Use NLP to find additional person names
  try {
    const doc = nlp(text);

    // Get all people entities
    const people = doc.people().out('array') as string[];

    for (const person of people) {
      const cleaned = cleanPersonName(person);
      if (cleaned && isLikelyPersonName(cleaned)) {
        const lower = cleaned.toLowerCase();
        if (!seenLower.has(lower)) {
          names.push(cleaned);
          seenLower.add(lower);
          logger.debug('NLP extracted person', { name: cleaned, original: person });
        }
      }
    }

    // Also try to find proper nouns that might be names
    const properNouns = doc.match('#ProperNoun+').out('array') as string[];

    for (const noun of properNouns) {
      const cleaned = cleanPersonName(noun);
      if (cleaned && isLikelyPersonName(cleaned) && cleaned.split(/\s+/).length >= 2) {
        const lower = cleaned.toLowerCase();
        if (!seenLower.has(lower)) {
          // Verify it looks like a person name (capitalized words)
          if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(cleaned)) {
            names.push(cleaned);
            seenLower.add(lower);
            logger.debug('NLP extracted proper noun as name', { name: cleaned });
          }
        }
      }
    }
  } catch (error) {
    logger.warn('NLP extraction failed, falling back to regex', {
      error: (error as Error).message
    });
  }

  // Fallback: use regex pattern for capitalized names
  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1];
    if (isLikelyPersonName(name)) {
      const lower = name.toLowerCase();
      if (!seenLower.has(lower)) {
        names.push(name);
        seenLower.add(lower);
      }
    }
  }

  return names;
}

/**
 * Clean a person name extracted by NLP
 */
function cleanPersonName(name: string): string | null {
  if (!name) return null;

  let cleaned = name.trim();

  // Remove leading/trailing punctuation
  cleaned = cleaned.replace(/^[^\w]+|[^\w]+$/g, '');

  // Remove titles
  cleaned = cleaned.replace(/^(Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Prof\.?|Sir|Dame|Lord|Lady)\s+/i, '');

  // Remove Jr, Sr, III etc at the end
  cleaned = cleaned.replace(/\s+(Jr\.?|Sr\.?|I{1,3}|IV|V)$/i, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Must be at least 2 characters
  if (cleaned.length < 2) return null;

  return cleaned;
}

/**
 * Parse a person name from a market outcome string
 */
export function parsePersonFromOutcome(outcomeStr: string): string | null {
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

  // Use NLP to verify it's a person
  try {
    const doc = nlp(name);
    if (doc.has('#Person') || doc.has('#ProperNoun')) {
      return cleanPersonName(name);
    }
  } catch {
    // Fall through to basic check
  }

  // Basic check: is it likely a name?
  if (isLikelyPersonName(name)) {
    return cleanPersonName(name);
  }

  return null;
}

/**
 * Check if a string is a person name (exported for use in market extraction)
 */
export function isPersonName(name: string): boolean {
  return isLikelyPersonName(name);
}

/**
 * Get the full name for a short name variant
 */
export function expandShortName(shortName: string): string | null {
  const lower = shortName.toLowerCase().trim();
  return KNOWN_SHORT_NAMES[lower] || null;
}

/**
 * Get all known figures (for reference)
 */
export function getKnownFigures(): string[] {
  return [...KNOWN_FIGURES];
}

/**
 * Escape regex special characters
 */
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract all people from market outcomes with NLP enhancement
 */
export function extractPeopleFromOutcomes(
  outcomes: Array<{ name: string; probability: number }>
): ExtractedPerson[] {
  const people: ExtractedPerson[] = [];

  for (const outcome of outcomes) {
    const parsedName = parsePersonFromOutcome(outcome.name);
    if (parsedName && isPersonName(parsedName)) {
      people.push({
        name: parsedName,
        probability: outcome.probability,
        source: 'outcome'
      });
    }
  }

  return people;
}
