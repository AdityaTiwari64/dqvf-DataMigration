import { describe, it, expect } from 'vitest';
import { loadConfigFromString } from '../../src/config/loader.js';

describe('config loader', () => {
  const minimalConfig = `
migration_run_id: "test-run"
source:
  type: postgresql
  host: localhost
  database: source_db
target:
  type: postgresql
  host: localhost
  database: target_db
tables:
  - name: users
    pk: id
`;

  it('should parse a minimal valid config', () => {
    const config = loadConfigFromString(minimalConfig);
    expect(config.migration_run_id).toBe('test-run');
    expect(config.source.type).toBe('postgresql');
    expect(config.target.type).toBe('postgresql');
    expect(config.tables).toHaveLength(1);
    expect(config.tables[0].name).toBe('users');
    expect(config.tables[0].pk).toBe('id');
  });

  it('should apply default thresholds', () => {
    const config = loadConfigFromString(minimalConfig);
    expect(config.thresholds.row_count_tolerance_pct).toBe(0);
    expect(config.thresholds.null_rate_delta_pct).toBe(1);
    expect(config.thresholds.chunk_size).toBe(100000);
    expect(config.thresholds.hash_algorithm).toBe('md5');
  });

  it('should apply default agent toggles (all enabled)', () => {
    const config = loadConfigFromString(minimalConfig);
    expect(config.agents.table_profiling).toBe(true);
    expect(config.agents.column_profiling).toBe(true);
    expect(config.agents.pattern_analysis).toBe(true);
    expect(config.agents.reconciliation).toBe(true);
    expect(config.agents.semantic).toBe(true);
    expect(config.agents.freshness).toBe(true);
  });

  it('should apply default LLM config', () => {
    const config = loadConfigFromString(minimalConfig);
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.temperature).toBe(0);
  });

  it('should override defaults with explicit values', () => {
    const config = loadConfigFromString(`
migration_run_id: "test"
source:
  type: sqlserver
  host: localhost
  database: src
target:
  type: postgresql
  host: localhost
  database: tgt
tables:
  - name: orders
    pk: order_id
thresholds:
  row_count_tolerance_pct: 5
  chunk_size: 50000
agents:
  semantic: false
  freshness: false
llm:
  provider: openai
  model: gpt-4o
`);
    expect(config.thresholds.row_count_tolerance_pct).toBe(5);
    expect(config.thresholds.chunk_size).toBe(50000);
    expect(config.agents.semantic).toBe(false);
    expect(config.agents.freshness).toBe(false);
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4o');
  });

  it('should reject missing required fields', () => {
    expect(() =>
      loadConfigFromString(`
source:
  type: postgresql
target:
  type: postgresql
tables:
  - name: test
    pk: id
`)
    ).toThrow();
  });

  it('should reject empty tables array', () => {
    expect(() =>
      loadConfigFromString(`
migration_run_id: "test"
source:
  type: postgresql
target:
  type: postgresql
tables: []
`)
    ).toThrow();
  });

  it('should reject invalid database type', () => {
    expect(() =>
      loadConfigFromString(`
migration_run_id: "test"
source:
  type: oracle
target:
  type: postgresql
tables:
  - name: test
    pk: id
`)
    ).toThrow();
  });

  it('should handle table with business rules', () => {
    const config = loadConfigFromString(`
migration_run_id: "test"
source:
  type: postgresql
  host: localhost
  database: src
target:
  type: postgresql
  host: localhost
  database: tgt
tables:
  - name: orders
    pk: order_id
    business_rules:
      - name: total_revenue
        expression: "SELECT SUM(amount) FROM orders"
        description: "Revenue must match"
`);
    expect(config.tables[0].business_rules).toHaveLength(1);
    expect(config.tables[0].business_rules![0].name).toBe('total_revenue');
  });
});
