import { describe, it, expect } from 'vitest';
import { aggregateRuleResults, createSkippedAgentResult } from '../../../src/types/report.js';
import type { RuleCheckResult } from '../../../src/types/report.js';

describe('report type helpers', () => {
  describe('aggregateRuleResults', () => {
    it('should aggregate PASS results', () => {
      const results: RuleCheckResult[] = [
        { rule: 'rule1', status: 'PASS', severity: 'HIGH', table: 'test', detail: 'ok' },
        { rule: 'rule2', status: 'PASS', severity: 'MEDIUM', table: 'test', detail: 'ok' },
      ];
      const agg = aggregateRuleResults(results);
      expect(agg.status).toBe('PASS');
      expect(agg.rulesChecked).toBe(2);
      expect(agg.rulesPassed).toBe(2);
      expect(agg.rulesFailed).toBe(0);
      expect(agg.failures).toHaveLength(0);
    });

    it('should aggregate FAIL results and set status', () => {
      const results: RuleCheckResult[] = [
        { rule: 'rule1', status: 'PASS', severity: 'HIGH', table: 'test', detail: 'ok' },
        { rule: 'rule2', status: 'FAIL', severity: 'HIGH', table: 'test', detail: 'bad', remediation: 'fix it' },
      ];
      const agg = aggregateRuleResults(results);
      expect(agg.status).toBe('FAIL');
      expect(agg.rulesFailed).toBe(1);
      expect(agg.failures).toHaveLength(1);
      expect(agg.failures[0].rule).toBe('rule2');
      expect(agg.failures[0].remediation).toBe('fix it');
    });

    it('should set WARN for MEDIUM failures without HIGH', () => {
      const results: RuleCheckResult[] = [
        { rule: 'rule1', status: 'FAIL', severity: 'MEDIUM', table: 'test', detail: 'warning' },
      ];
      const agg = aggregateRuleResults(results);
      expect(agg.status).toBe('WARN');
    });

    it('should handle SKIPPED results', () => {
      const results: RuleCheckResult[] = [
        { rule: 'rule1', status: 'SKIPPED', severity: 'MEDIUM', table: 'test', detail: 'skipped' },
      ];
      const agg = aggregateRuleResults(results);
      expect(agg.rulesSkipped).toBe(1);
    });
  });

  describe('createSkippedAgentResult', () => {
    it('should create a WARN result with skip reason', () => {
      const result = createSkippedAgentResult('Agent blocked by upstream failure');
      expect(result.status).toBe('WARN');
      expect(result.skippedReason).toBe('Agent blocked by upstream failure');
      expect(result.rulesChecked).toBe(0);
    });
  });
});
