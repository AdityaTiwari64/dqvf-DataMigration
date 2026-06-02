import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TableProfilingAgent } from '../../../src/agents/table-profiling.agent.js';
import type { AgentContext } from '../../../src/types/agent.js';
import type { RunConfig } from '../../../src/config/schema.js';

// ─── Mock Database Connector ───────────────────────────────────────

function createMockConnector(overrides: Record<string, unknown> = {}) {
  return {
    type: 'postgresql',
    testConnection: vi.fn().mockResolvedValue(undefined),
    getRowCount: vi.fn().mockResolvedValue(1000),
    getTableSchema: vi.fn().mockResolvedValue({
      tableName: 'users',
      schemaName: 'public',
      columns: [
        { name: 'id', dataType: 'integer', fullType: 'INTEGER', ordinalPosition: 1, isNullable: false, maxLength: null, numericPrecision: 32, numericScale: 0, columnDefault: null },
        { name: 'email', dataType: 'varchar', fullType: 'VARCHAR(100)', ordinalPosition: 2, isNullable: true, maxLength: 100, numericPrecision: null, numericScale: null, columnDefault: null },
        { name: 'name', dataType: 'varchar', fullType: 'VARCHAR(50)', ordinalPosition: 3, isNullable: true, maxLength: 50, numericPrecision: null, numericScale: null, columnDefault: null },
      ],
      constraints: [
        { name: 'pk_users', type: 'PRIMARY KEY', columns: ['id'] },
      ],
      primaryKeyColumns: ['id'],
    }),
    getColumns: vi.fn().mockResolvedValue([]),
    getPrimaryKeys: vi.fn().mockResolvedValue(['id']),
    getForeignKeys: vi.fn().mockResolvedValue([]),
    getConstraints: vi.fn().mockResolvedValue([
      { name: 'pk_users', type: 'PRIMARY KEY', columns: ['id'] },
    ]),
    findDuplicatePrimaryKeys: vi.fn().mockResolvedValue([]),
    findOrphanedForeignKeys: vi.fn().mockResolvedValue(0),
    getTableHash: vi.fn().mockResolvedValue({ hash: 'abc123def456', rowCount: 1000, algorithm: 'md5' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentContext['sourceDb'];
}

function createMockConfig(): RunConfig {
  return {
    migration_run_id: 'test-run',
    source: { type: 'postgresql' },
    target: { type: 'postgresql' },
    tables: [{ name: 'users', pk: 'id', schema: 'public', sla_freshness_hours: 24, skip_columns: [], business_rules: [] }],
    thresholds: {
      row_count_tolerance_pct: 0,
      null_rate_delta_pct: 1,
      distribution_drift_pvalue: 0.05,
      cardinality_change_pct: 10,
      chunk_size: 100000,
      cdc_lag_max_minutes: 15,
      hash_algorithm: 'md5',
      volume_baseline_pct: 10,
      fuzzy_duplicate_threshold: 0.85,
      levenshtein_max_distance: 3,
      parallel_chunk_workers: 4,
    },
    agents: {
      table_profiling: true,
      column_profiling: true,
      pattern_analysis: true,
      reconciliation: true,
      semantic: true,
      freshness: true,
    },
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', max_tokens: 4096, temperature: 0 },
    notifications: { alert_on: ['HIGH', 'MEDIUM'] },
  } as RunConfig;
}

describe('TableProfilingAgent', () => {
  let agent: TableProfilingAgent;

  beforeEach(() => {
    agent = new TableProfilingAgent();
  });

  it('should pass when row counts match', async () => {
    const sourceDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(1000) });
    const targetDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(1000) });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const rowCountResult = result.results.find((r) => r.rule === 'row_count_reconciliation');
    expect(rowCountResult?.status).toBe('PASS');
  });

  it('should fail when row counts mismatch beyond tolerance', async () => {
    const sourceDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(1000) });
    const targetDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(900) });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const rowCountResult = result.results.find((r) => r.rule === 'row_count_reconciliation');
    expect(rowCountResult?.status).toBe('FAIL');
    expect(rowCountResult?.severity).toBe('HIGH');
  });

  it('should pass when no duplicate PKs found', async () => {
    const sourceDb = createMockConnector();
    const targetDb = createMockConnector({
      findDuplicatePrimaryKeys: vi.fn().mockResolvedValue([]),
    });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const pkResult = result.results.find((r) => r.rule === 'duplicate_primary_key');
    expect(pkResult?.status).toBe('PASS');
  });

  it('should fail when duplicate PKs found', async () => {
    const sourceDb = createMockConnector();
    const targetDb = createMockConnector({
      findDuplicatePrimaryKeys: vi.fn().mockResolvedValue([
        { key: '42', count: 3 },
        { key: '99', count: 2 },
      ]),
    });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const pkResult = result.results.find((r) => r.rule === 'duplicate_primary_key');
    expect(pkResult?.status).toBe('FAIL');
    expect(pkResult?.severity).toBe('HIGH');
  });

  it('should pass when table hashes match', async () => {
    const hash = { hash: 'abc123', rowCount: 1000, algorithm: 'md5' };
    const sourceDb = createMockConnector({ getTableHash: vi.fn().mockResolvedValue(hash) });
    const targetDb = createMockConnector({ getTableHash: vi.fn().mockResolvedValue(hash) });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const hashResult = result.results.find((r) => r.rule === 'checksum_hash');
    expect(hashResult?.status).toBe('PASS');
  });

  it('should fail when table hashes mismatch', async () => {
    const sourceDb = createMockConnector({
      getTableHash: vi.fn().mockResolvedValue({ hash: 'abc', rowCount: 1000, algorithm: 'md5' }),
    });
    const targetDb = createMockConnector({
      getTableHash: vi.fn().mockResolvedValue({ hash: 'xyz', rowCount: 1000, algorithm: 'md5' }),
    });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const hashResult = result.results.find((r) => r.rule === 'checksum_hash');
    expect(hashResult?.status).toBe('FAIL');
  });

  it('should set overall status to FAIL on any HIGH failure', async () => {
    const sourceDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(1000) });
    const targetDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(500) });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    expect(result.status).toBe('FAIL');
    expect(result.rulesFailed).toBeGreaterThan(0);
  });

  it('should handle empty target table', async () => {
    const sourceDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(1000) });
    const targetDb = createMockConnector({ getRowCount: vi.fn().mockResolvedValue(0) });

    const ctx: AgentContext = {
      sourceDb,
      targetDb,
      config: createMockConfig(),
      llm: null,
    };

    const result = await agent.run(ctx);
    const volumeResult = result.results.find((r) => r.rule === 'volume_baseline');
    expect(volumeResult?.status).toBe('FAIL');
  });
});
