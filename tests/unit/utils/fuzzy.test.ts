import { describe, it, expect } from 'vitest';
import {
  levenshteinDistance,
  similarity,
  findClosest,
  findFuzzyDuplicates,
  fuzzyMatch,
  normalizeColumnName,
  columnNameSimilarity,
} from '../../../src/utils/fuzzy.js';

describe('fuzzy matching utilities', () => {
  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('hello', 'hello')).toBe(0);
    });

    it('should count single character edits', () => {
      expect(levenshteinDistance('hello', 'hallo')).toBe(1);
    });

    it('should handle empty strings', () => {
      expect(levenshteinDistance('', 'abc')).toBe(3);
      expect(levenshteinDistance('abc', '')).toBe(3);
    });

    it('should be symmetric', () => {
      expect(levenshteinDistance('abc', 'xyz')).toBe(levenshteinDistance('xyz', 'abc'));
    });
  });

  describe('similarity', () => {
    it('should return 1 for identical strings', () => {
      expect(similarity('hello', 'hello')).toBe(1);
    });

    it('should return 0 for completely different strings of same length', () => {
      const sim = similarity('abc', 'xyz');
      expect(sim).toBeLessThan(0.5);
    });

    it('should handle empty strings', () => {
      expect(similarity('', '')).toBe(1);
    });
  });

  describe('findClosest', () => {
    it('should find the closest match', () => {
      const result = findClosest('hello', ['world', 'hallo', 'hell']);
      expect(result).not.toBeNull();
      expect(result!.match).toBe('hallo');
      expect(result!.distance).toBe(1);
    });

    it('should return null for empty candidates', () => {
      expect(findClosest('hello', [])).toBeNull();
    });

    it('should find exact matches', () => {
      const result = findClosest('hello', ['hello', 'world']);
      expect(result!.distance).toBe(0);
      expect(result!.similarity).toBe(1);
    });
  });

  describe('findFuzzyDuplicates', () => {
    it('should find near-duplicate values', () => {
      const values = ['John Smith', 'Jon Smith', 'Jane Doe', 'John Smth'];
      const groups = findFuzzyDuplicates(values, 2);
      expect(groups.length).toBeGreaterThan(0);
    });

    it('should return no groups for unique values', () => {
      const values = ['apple', 'banana', 'cherry', 'dragon'];
      const groups = findFuzzyDuplicates(values, 1);
      expect(groups.length).toBe(0);
    });

    it('should respect max distance threshold', () => {
      const values = ['abcdef', 'abcxyz']; // distance = 3
      expect(findFuzzyDuplicates(values, 2).length).toBe(0);
      expect(findFuzzyDuplicates(values, 3).length).toBeGreaterThan(0);
    });

    it('should handle max comparisons limit', () => {
      const values = Array.from({ length: 100 }, (_, i) => `value_${i}`);
      const groups = findFuzzyDuplicates(values, 1, 100);
      // Should complete without error
      expect(groups).toBeDefined();
    });
  });

  describe('fuzzyMatch', () => {
    it('should find fuzzy matches between source and target', () => {
      const source = ['customer_id', 'cust_name'];
      const target = ['customer_identifier', 'customer_name'];
      const matches = fuzzyMatch(source, target, 0.5);
      expect(matches.length).toBeGreaterThan(0);
    });

    it('should not return exact matches', () => {
      const source = ['exact'];
      const target = ['exact'];
      const matches = fuzzyMatch(source, target, 0.5);
      expect(matches.length).toBe(0); // similarity = 1 is excluded
    });
  });

  describe('normalizeColumnName', () => {
    it('should normalize camelCase to snake_case', () => {
      expect(normalizeColumnName('customerName')).toBe('customer_name');
    });

    it('should lowercase and strip special characters', () => {
      expect(normalizeColumnName('Customer-ID')).toBe('customer_id');
    });

    it('should handle already normalized names', () => {
      expect(normalizeColumnName('customer_id')).toBe('customer_id');
    });
  });

  describe('columnNameSimilarity', () => {
    it('should return 1 for equivalent column names', () => {
      expect(columnNameSimilarity('customerId', 'customer_id')).toBe(1);
    });

    it('should return high similarity for close names', () => {
      const sim = columnNameSimilarity('cust_id', 'customer_id');
      expect(sim).toBeGreaterThan(0.5);
    });
  });
});
