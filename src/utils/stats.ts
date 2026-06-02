/**
 * Statistical testing utilities for distribution drift detection,
 * outlier analysis, and data quality scoring.
 *
 * Wraps simple-statistics and implements additional tests.
 */

import {
  mean,
  standardDeviation,
  median,
  quantile,
  interquartileRange,
  zScore as ssZScore,
  sampleSkewness,
} from 'simple-statistics';

// Kolmogorov-Smirnov Test

export interface KSTestResult {
  statistic: number;
  pValue: number;
  significant: boolean;
}

/**
 * Two-sample Kolmogorov-Smirnov test.
 * Tests whether two samples come from the same distribution.
 *
 * @param sample1 First sample (numeric array)
 * @param sample2 Second sample (numeric array)
 * @param alpha Significance level (default 0.05)
 * @returns KS test statistic, approximate p-value, and significance flag
 */
export function ksTest(sample1: number[], sample2: number[], alpha = 0.05): KSTestResult {
  if (sample1.length === 0 || sample2.length === 0) {
    return { statistic: 0, pValue: 1, significant: false };
  }

  const sorted1 = [...sample1].sort((a, b) => a - b);
  const sorted2 = [...sample2].sort((a, b) => a - b);
  const n1 = sorted1.length;
  const n2 = sorted2.length;

  // Merge and compute empirical CDFs
  const all = [...sorted1, ...sorted2].sort((a, b) => a - b);
  let maxD = 0;
  let i1 = 0;
  let i2 = 0;

  for (const val of all) {
    while (i1 < n1 && sorted1[i1] <= val) i1++;
    while (i2 < n2 && sorted2[i2] <= val) i2++;
    const d = Math.abs(i1 / n1 - i2 / n2);
    if (d > maxD) maxD = d;
  }

  if (maxD === 0) {
    return { statistic: 0, pValue: 1, significant: false };
  }

  // Approximate p-value using asymptotic formula
  const en = Math.sqrt((n1 * n2) / (n1 + n2));
  const lambda = (en + 0.12 + 0.11 / en) * maxD;
  // Kolmogorov distribution approximation
  let pValue = 0;
  for (let k = 1; k <= 100; k++) {
    pValue += 2 * Math.pow(-1, k + 1) * Math.exp(-2 * k * k * lambda * lambda);
  }
  pValue = Math.max(0, Math.min(1, pValue));

  return {
    statistic: maxD,
    pValue,
    significant: pValue < alpha,
  };
}

// Chi-Square Test

export interface ChiSquareResult {
  statistic: number;
  pValue: number;
  degreesOfFreedom: number;
  significant: boolean;
}

/**
 * Chi-square test for comparing categorical distributions.
 *
 * @param observed Observed frequency counts
 * @param expected Expected frequency counts
 * @param alpha Significance level
 */
export function chiSquareTest(
  observed: number[],
  expected: number[],
  alpha = 0.05
): ChiSquareResult {
  if (observed.length !== expected.length) {
    throw new Error('Observed and expected arrays must have the same length');
  }

  const df = observed.length - 1;
  let statistic = 0;

  for (let i = 0; i < observed.length; i++) {
    if (expected[i] === 0) continue;
    statistic += Math.pow(observed[i] - expected[i], 2) / expected[i];
  }

  // Approximate p-value using regularized gamma function approximation
  const pValue = 1 - gammaCDF(statistic / 2, df / 2);

  return {
    statistic,
    pValue,
    degreesOfFreedom: df,
    significant: pValue < alpha,
  };
}

/**
 * Simplified gamma CDF using series expansion (for chi-square p-value).
 */
function gammaCDF(x: number, a: number): number {
  if (x <= 0) return 0;
  if (a <= 0) return 0;

  // Lower incomplete gamma using series expansion
  let sum = 0;
  let term = 1 / a;
  sum = term;
  for (let n = 1; n < 200; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }

  const gammaA = gammaFunction(a);
  if (gammaA === 0) return 0;
  return (Math.pow(x, a) * Math.exp(-x) * sum) / gammaA;
}

/**
 * Stirling approximation for the gamma function.
 */
function gammaFunction(z: number): number {
  if (z < 0.5) {
    return Math.PI / (Math.sin(Math.PI * z) * gammaFunction(1 - z));
  }
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

// Z-Score & Outlier Detection

/**
 * Compute the Z-score of a value relative to a sample.
 */
export function zScore(value: number, sampleMean: number, sampleStdDev: number): number {
  if (sampleStdDev === 0) return 0;
  return (value - sampleMean) / sampleStdDev;
}

/**
 * Detect outliers using the IQR method.
 * Returns indices of outlier values.
 */
export function iqrOutliers(values: number[], multiplier = 1.5): {
  outliers: Array<{ index: number; value: number }>;
  q1: number;
  q3: number;
  iqr: number;
  lowerBound: number;
  upperBound: number;
} {
  if (values.length < 4) {
    return { outliers: [], q1: 0, q3: 0, iqr: 0, lowerBound: 0, upperBound: 0 };
  }

  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - multiplier * iqr;
  const upperBound = q3 + multiplier * iqr;

  const outliers = values
    .map((v, i) => ({ index: i, value: v }))
    .filter((item) => item.value < lowerBound || item.value > upperBound);

  return { outliers, q1, q3, iqr, lowerBound, upperBound };
}

/**
 * Detect outliers using Z-score method.
 */
export function zScoreOutliers(values: number[], threshold = 3): {
  outliers: Array<{ index: number; value: number; zScore: number }>;
  mean: number;
  stddev: number;
} {
  if (values.length < 3) {
    return { outliers: [], mean: 0, stddev: 0 };
  }

  const m = mean(values);
  const sd = standardDeviation(values);

  if (sd === 0) {
    return { outliers: [], mean: m, stddev: 0 };
  }

  const outliers = values
    .map((v, i) => ({
      index: i,
      value: v,
      zScore: Math.abs((v - m) / sd),
    }))
    .filter((item) => item.zScore > threshold);

  return { outliers, mean: m, stddev: sd };
}

// Distribution Comparison

export interface DistributionComparison {
  /** 0-1 score; 0 = identical, 1 = completely different */
  driftScore: number;
  ksResult: KSTestResult;
  sourceMean: number;
  targetMean: number;
  sourceStdDev: number;
  targetStdDev: number;
  sourceMedian: number;
  targetMedian: number;
}

/**
 * Compare two numeric distributions and produce a unified drift score.
 */
export function compareDistributions(
  source: number[],
  target: number[],
  pValueThreshold = 0.05
): DistributionComparison {
  const ks = ksTest(source, target, pValueThreshold);

  const sourceMean = source.length > 0 ? mean(source) : 0;
  const targetMean = target.length > 0 ? mean(target) : 0;
  const sourceStdDev = source.length > 1 ? standardDeviation(source) : 0;
  const targetStdDev = target.length > 1 ? standardDeviation(target) : 0;
  const sourceMedian = source.length > 0 ? median(source) : 0;
  const targetMedian = target.length > 0 ? median(target) : 0;

  // Drift score: combine KS statistic with normalized mean/stddev shifts
  const meanShift =
    sourceMean !== 0 ? Math.abs(targetMean - sourceMean) / Math.abs(sourceMean) : 0;
  const stddevShift =
    sourceStdDev !== 0
      ? Math.abs(targetStdDev - sourceStdDev) / sourceStdDev
      : 0;

  const driftScore = Math.min(
    1,
    ks.statistic * 0.5 + meanShift * 0.3 + stddevShift * 0.2
  );

  return {
    driftScore,
    ksResult: ks,
    sourceMean,
    targetMean,
    sourceStdDev,
    targetStdDev,
    sourceMedian,
    targetMedian,
  };
}

// Frequency Comparison

export interface FrequencyShift {
  value: string;
  sourceFrequency: number;
  targetFrequency: number;
  shift: number;
}

/**
 * Compare top-N value frequencies between source and target.
 */
export function compareFrequencies(
  source: Array<{ value: unknown; count: number }>,
  target: Array<{ value: unknown; count: number }>,
  topN = 20
): FrequencyShift[] {
  const sourceTotal = source.reduce((sum, item) => sum + item.count, 0) || 1;
  const targetTotal = target.reduce((sum, item) => sum + item.count, 0) || 1;

  const sourceMap = new Map<string, number>();
  const targetMap = new Map<string, number>();

  for (const item of source.slice(0, topN)) {
    sourceMap.set(String(item.value), item.count / sourceTotal);
  }
  for (const item of target.slice(0, topN)) {
    targetMap.set(String(item.value), item.count / targetTotal);
  }

  const allValues = new Set([...sourceMap.keys(), ...targetMap.keys()]);
  const shifts: FrequencyShift[] = [];

  for (const value of allValues) {
    const sourceFreq = sourceMap.get(value) ?? 0;
    const targetFreq = targetMap.get(value) ?? 0;
    shifts.push({
      value,
      sourceFrequency: sourceFreq,
      targetFrequency: targetFreq,
      shift: Math.abs(targetFreq - sourceFreq),
    });
  }

  return shifts.sort((a, b) => b.shift - a.shift);
}

// Re-exports from simple-statistics for convenience
export { mean, standardDeviation, median, quantile, interquartileRange, sampleSkewness };
