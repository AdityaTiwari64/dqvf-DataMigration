/**
 * Hashing utilities for row-level and chunk-level data comparison.
 * Uses Node.js built-in crypto module.
 */

import { createHash } from 'node:crypto';

export type HashAlgorithm = 'md5' | 'sha256';

/**
 * Compute a deterministic hash of a set of values (representing a row).
 * Values are joined with a pipe separator and hashed.
 */
export function hashRow(values: unknown[], algorithm: HashAlgorithm = 'md5'): string {
  const serialized = values
    .map((v) => {
      if (v === null || v === undefined) return '\\N';
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    })
    .join('|');

  return createHash(algorithm).update(serialized, 'utf-8').digest('hex');
}

/**
 * Compute an aggregate hash over multiple row hashes.
 * Row hashes are sorted first to ensure order-independence.
 */
export function hashChunk(rowHashes: string[], algorithm: HashAlgorithm = 'md5'): string {
  const sorted = [...rowHashes].sort();
  const combined = sorted.join('');
  return createHash(algorithm).update(combined, 'utf-8').digest('hex');
}

/**
 * Hash an array of rows (each row is an array of values).
 */
export function hashRows(
  rows: unknown[][],
  algorithm: HashAlgorithm = 'md5'
): string {
  const rowHashes = rows.map((row) => hashRow(row, algorithm));
  return hashChunk(rowHashes, algorithm);
}

/**
 * Compare two hash values and return a comparison result.
 */
export function compareHashes(
  sourceHash: string,
  targetHash: string
): { match: boolean; source: string; target: string } {
  return {
    match: sourceHash === targetHash,
    source: sourceHash,
    target: targetHash,
  };
}

/**
 * Compute the hash of a string value.
 */
export function hashString(value: string, algorithm: HashAlgorithm = 'md5'): string {
  return createHash(algorithm).update(value, 'utf-8').digest('hex');
}
