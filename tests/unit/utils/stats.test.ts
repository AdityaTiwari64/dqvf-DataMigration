import { describe, it, expect } from 'vitest';
import {
  ksTest,
  chiSquareTest,
  zScore,
  iqrOutliers,
  zScoreOutliers,
  compareDistributions,
  compareFrequencies,
} from '../../../src/utils/stats.js';

describe('stats utilities', () => {
  describe('ksTest', () => {
    it('should return non-significant for identical distributions', () => {
      const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = ksTest(sample, sample);
      expect(result.statistic).toBe(0);
      expect(result.significant).toBe(false);
    });

    it('should detect significantly different distributions', () => {
      const sample1 = Array.from({ length: 100 }, (_, i) => i);
      const sample2 = Array.from({ length: 100 }, (_, i) => i + 100);
      const result = ksTest(sample1, sample2);
      expect(result.statistic).toBeGreaterThan(0.5);
      expect(result.significant).toBe(true);
    });

    it('should handle empty samples', () => {
      const result = ksTest([], [1, 2, 3]);
      expect(result.statistic).toBe(0);
      expect(result.significant).toBe(false);
    });

    it('should detect similar distributions as non-significant', () => {
      const sample1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const sample2 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11];
      const result = ksTest(sample1, sample2);
      expect(result.significant).toBe(false);
    });
  });

  describe('chiSquareTest', () => {
    it('should return non-significant for matching distributions', () => {
      const observed = [10, 20, 30, 40];
      const expected = [10, 20, 30, 40];
      const result = chiSquareTest(observed, expected);
      expect(result.statistic).toBe(0);
      expect(result.significant).toBe(false);
    });

    it('should detect significantly different distributions', () => {
      const observed = [50, 10, 10, 30];
      const expected = [25, 25, 25, 25];
      const result = chiSquareTest(observed, expected);
      expect(result.statistic).toBeGreaterThan(0);
      expect(result.significant).toBe(true);
    });

    it('should throw for mismatched array lengths', () => {
      expect(() => chiSquareTest([1, 2], [1, 2, 3])).toThrow();
    });
  });

  describe('zScore', () => {
    it('should compute correct z-score', () => {
      expect(zScore(10, 5, 2.5)).toBe(2);
      expect(zScore(0, 0, 1)).toBe(0);
    });

    it('should handle zero stddev', () => {
      expect(zScore(5, 5, 0)).toBe(0);
    });
  });

  describe('iqrOutliers', () => {
    it('should detect outliers', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]; // 100 is an outlier
      const result = iqrOutliers(values);
      expect(result.outliers.length).toBeGreaterThan(0);
      expect(result.outliers.some((o) => o.value === 100)).toBe(true);
    });

    it('should return no outliers for uniform data', () => {
      const values = [5, 5, 5, 5, 5, 5, 5, 5];
      const result = iqrOutliers(values);
      expect(result.outliers.length).toBe(0);
    });

    it('should handle small arrays', () => {
      const result = iqrOutliers([1, 2]);
      expect(result.outliers.length).toBe(0);
    });
  });

  describe('zScoreOutliers', () => {
    it('should detect outliers beyond threshold', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 50];
      const result = zScoreOutliers(values, 2);
      expect(result.outliers.length).toBeGreaterThan(0);
    });

    it('should handle uniform data', () => {
      const values = [5, 5, 5, 5, 5];
      const result = zScoreOutliers(values);
      expect(result.outliers.length).toBe(0);
    });
  });

  describe('compareDistributions', () => {
    it('should return low drift for identical data', () => {
      const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = compareDistributions(sample, sample);
      expect(result.driftScore).toBeLessThan(0.1);
    });

    it('should return high drift for very different data', () => {
      const source = Array.from({ length: 100 }, (_, i) => i);
      const target = Array.from({ length: 100 }, (_, i) => i + 200);
      const result = compareDistributions(source, target);
      expect(result.driftScore).toBeGreaterThan(0.3);
    });

    it('should handle empty arrays', () => {
      const result = compareDistributions([], []);
      expect(result.driftScore).toBe(0);
    });
  });

  describe('compareFrequencies', () => {
    it('should detect frequency shifts', () => {
      const source = [
        { value: 'a', count: 50 },
        { value: 'b', count: 30 },
        { value: 'c', count: 20 },
      ];
      const target = [
        { value: 'a', count: 30 },
        { value: 'b', count: 50 },
        { value: 'c', count: 20 },
      ];
      const shifts = compareFrequencies(source, target);
      expect(shifts.length).toBeGreaterThan(0);
      expect(shifts[0].shift).toBeGreaterThan(0);
    });

    it('should return zero shifts for identical frequencies', () => {
      const data = [{ value: 'a', count: 100 }];
      const shifts = compareFrequencies(data, data);
      expect(shifts.every((s) => s.shift === 0)).toBe(true);
    });
  });
});
