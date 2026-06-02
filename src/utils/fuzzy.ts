/**
 * Fuzzy matching and duplicate detection utilities.
 * Uses fastest-levenshtein for string distance computation.
 */

import { distance as levenshtein, closest } from 'fastest-levenshtein';

/**
 * Compute the Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  return levenshtein(a, b);
}

/**
 * Compute normalized similarity (0-1, where 1 = identical).
 */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Find the closest match for a string in a list of candidates.
 */
export function findClosest(target: string, candidates: string[]): {
  match: string;
  distance: number;
  similarity: number;
} | null {
  if (candidates.length === 0) return null;
  const match = closest(target, candidates);
  const dist = levenshtein(target, match);
  return {
    match,
    distance: dist,
    similarity: 1 - dist / Math.max(target.length, match.length),
  };
}

/**
 * Detect fuzzy duplicates within a set of values.
 * Groups values that are within the specified Levenshtein distance threshold.
 *
 * @param values Array of string values to check
 * @param maxDistance Maximum Levenshtein distance to consider a duplicate (default: 3)
 * @param maxComparisons Maximum pairwise comparisons to prevent O(n²) explosion (default: 50000)
 * @returns Groups of fuzzy duplicates
 */
export function findFuzzyDuplicates(
  values: string[],
  maxDistance = 3,
  maxComparisons = 50000
): Array<{
  group: string[];
  distance: number;
}> {
  const groups: Array<{ group: string[]; distance: number }> = [];
  const assigned = new Set<number>();
  let comparisons = 0;

  for (let i = 0; i < values.length && comparisons < maxComparisons; i++) {
    if (assigned.has(i)) continue;
    const group: string[] = [values[i]];
    let minDist = Infinity;

    for (let j = i + 1; j < values.length && comparisons < maxComparisons; j++) {
      if (assigned.has(j)) continue;
      comparisons++;
      const dist = levenshtein(values[i], values[j]);
      if (dist <= maxDistance && dist > 0) {
        group.push(values[j]);
        assigned.add(j);
        if (dist < minDist) minDist = dist;
      }
    }

    if (group.length > 1) {
      assigned.add(i);
      groups.push({ group, distance: minDist });
    }
  }

  return groups;
}

/**
 * Cross-table fuzzy matching: find values in source that have fuzzy matches in target.
 *
 * @param sourceValues Source column values
 * @param targetValues Target column values
 * @param threshold Similarity threshold (0-1, default: 0.85)
 * @returns Matched pairs with similarity scores
 */
export function fuzzyMatch(
  sourceValues: string[],
  targetValues: string[],
  threshold = 0.85
): Array<{
  source: string;
  target: string;
  similarity: number;
  distance: number;
}> {
  const matches: Array<{
    source: string;
    target: string;
    similarity: number;
    distance: number;
  }> = [];

  for (const sourceVal of sourceValues) {
    const result = findClosest(sourceVal, targetValues);
    if (result && result.similarity >= threshold && result.similarity < 1) {
      matches.push({
        source: sourceVal,
        target: result.match,
        similarity: result.similarity,
        distance: result.distance,
      });
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Check if two column names are semantically similar (case-insensitive, underscore/camelCase normalization).
 */
export function normalizeColumnName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export function columnNameSimilarity(name1: string, name2: string): number {
  const norm1 = normalizeColumnName(name1);
  const norm2 = normalizeColumnName(name2);
  if (norm1 === norm2) return 1;
  return similarity(norm1, norm2);
}
