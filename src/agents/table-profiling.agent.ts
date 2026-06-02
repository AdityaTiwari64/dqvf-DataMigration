import { BaseAgent } from './base-agent.js';
import type { AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { RuleCheckResult } from '../types/report.js';
import { createLogger } from '../utils/logger.js';

export class TableProfilingAgent extends BaseAgent {
  readonly name = 'table_profiling';
  readonly description = 'Fail-fast structural checks for table-level data quality';

  constructor() {
    super();
    this.log = createLogger('TableProfilingAgent');
  }

  protected async validateTable(
    ctx: AgentContext,
    table: TableConfig
  ): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];
    const { sourceDb, targetDb, config } = ctx;
    const thresholds = config.thresholds;

    // Rule 1: Row Count Reconciliation
    try {
      const { result: res, durationMs } = await this.timed(async () => {
        const sourceCount = await sourceDb.getRowCount(table.name, table.schema);
        const targetCount = await targetDb.getRowCount(table.name, table.schema);
        return { sourceCount, targetCount };
      });

      const { sourceCount, targetCount } = res;
      const tolerance = thresholds.row_count_tolerance_pct;
      const diff = sourceCount > 0 ? Math.abs(targetCount - sourceCount) / sourceCount * 100 : 0;

      if (sourceCount === targetCount) {
        const r = this.pass('row_count_reconciliation', table.name,
          `Row counts match: source=${sourceCount}, target=${targetCount}`);
        r.durationMs = durationMs;
        results.push(r);
      } else if (diff <= tolerance) {
        const r = this.warn('row_count_reconciliation', table.name,
          `Row count difference within tolerance: source=${sourceCount}, target=${targetCount} (${diff.toFixed(2)}% diff, tolerance=${tolerance}%)`,
          'MEDIUM');
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const r = this.fail('row_count_reconciliation', table.name,
          `Row count mismatch: source=${sourceCount}, target=${targetCount} (${diff.toFixed(2)}% diff exceeds ${tolerance}% tolerance)`,
          'HIGH',
          `Investigate missing or extra rows. Expected ${sourceCount} rows but found ${targetCount}.`);
        r.durationMs = durationMs;
        results.push(r);
      }
    } catch (error) {
      results.push(this.fail('row_count_reconciliation', table.name,
        `Failed to compare row counts: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 2: Schema Compatibility
    try {
      const { result: res, durationMs } = await this.timed(async () => {
        const sourceSchema = await sourceDb.getTableSchema(table.name, table.schema);
        const targetSchema = await targetDb.getTableSchema(table.name, table.schema);
        return { sourceSchema, targetSchema };
      });

      const { sourceSchema, targetSchema } = res;
      const mismatches: string[] = [];

      // Check column count
      if (sourceSchema.columns.length !== targetSchema.columns.length) {
        mismatches.push(
          `Column count differs: source=${sourceSchema.columns.length}, target=${targetSchema.columns.length}`
        );
      }

      // Check each source column exists in target with compatible type
      for (const srcCol of sourceSchema.columns) {
        const skipCols = table.skip_columns ?? [];
        if (skipCols.includes(srcCol.name)) continue;

        const tgtCol = targetSchema.columns.find(
          (c) => c.name.toLowerCase() === srcCol.name.toLowerCase()
        );

        if (!tgtCol) {
          mismatches.push(`Column "${srcCol.name}" missing in target`);
        } else {
          // Check ordinal position
          if (srcCol.ordinalPosition !== tgtCol.ordinalPosition) {
            mismatches.push(
              `Column "${srcCol.name}" ordinal position changed: ${srcCol.ordinalPosition} → ${tgtCol.ordinalPosition}`
            );
          }
        }
      }

      if (mismatches.length === 0) {
        const r = this.pass('schema_compatibility', table.name,
          `Schema compatible: ${sourceSchema.columns.length} columns match`);
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const r = this.fail('schema_compatibility', table.name,
          `Schema mismatches detected: ${mismatches.join('; ')}`,
          'HIGH',
          'Review schema differences and adjust target DDL accordingly');
        r.durationMs = durationMs;
        r.metadata = { mismatches };
        results.push(r);
      }
    } catch (error) {
      results.push(this.fail('schema_compatibility', table.name,
        `Failed to compare schemas: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 3: Duplicate Primary Key Detection
    try {
      const { result: duplicates, durationMs } = await this.timed(() =>
        targetDb.findDuplicatePrimaryKeys(table.name, table.pk, table.schema)
      );

      if (duplicates.length === 0) {
        const r = this.pass('duplicate_primary_key', table.name,
          'No duplicate primary keys found on target');
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const topDupes = duplicates.slice(0, 5).map((d) => `${d.key} (${d.count}x)`).join(', ');
        const r = this.fail('duplicate_primary_key', table.name,
          `${duplicates.length} duplicate primary key(s) found on target. Top: ${topDupes}`,
          'HIGH',
          `DELETE duplicate rows from target table "${table.name}" or investigate ETL logic`);
        r.durationMs = durationMs;
        r.metadata = { duplicateCount: duplicates.length, topDuplicates: duplicates.slice(0, 10) };
        results.push(r);
      }
    } catch (error) {
      results.push(this.fail('duplicate_primary_key', table.name,
        `Failed to check duplicate PKs: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 4: Referential Integrity
    try {
      const { result: fks, durationMs } = await this.timed(() =>
        targetDb.getForeignKeys(table.name, table.schema)
      );

      let totalOrphans = 0;
      const orphanDetails: string[] = [];

      for (const fk of fks) {
        const orphanCount = await targetDb.findOrphanedForeignKeys(table.name, fk, table.schema);
        if (orphanCount > 0) {
          totalOrphans += orphanCount;
          orphanDetails.push(`FK ${fk.constraintName}: ${orphanCount} orphaned records`);
        }
      }

      if (fks.length === 0) {
        const r = this.pass('referential_integrity', table.name,
          'No foreign keys defined — skipping referential integrity check');
        r.status = 'SKIPPED';
        r.durationMs = durationMs;
        results.push(r);
      } else if (totalOrphans === 0) {
        const r = this.pass('referential_integrity', table.name,
          `All ${fks.length} foreign key references resolve correctly`);
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const r = this.fail('referential_integrity', table.name,
          `${totalOrphans} orphaned FK records: ${orphanDetails.join('; ')}`,
          'HIGH',
          'Investigate missing parent records or incorrect FK mappings');
        r.durationMs = durationMs;
        results.push(r);
      }
    } catch (error) {
      results.push(this.fail('referential_integrity', table.name,
        `Failed to check referential integrity: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 5: Checksum / Hash Comparison
    try {
      const algorithm = thresholds.hash_algorithm;
      const { result: res, durationMs } = await this.timed(async () => {
        const sourceHash = await sourceDb.getTableHash(table.name, algorithm, table.schema);
        const targetHash = await targetDb.getTableHash(table.name, algorithm, table.schema);
        return { sourceHash, targetHash };
      });

      const { sourceHash, targetHash } = res;

      if (sourceHash.hash === targetHash.hash) {
        const r = this.pass('checksum_hash', table.name,
          `Table hashes match (${algorithm.toUpperCase()}): ${sourceHash.hash.substring(0, 16)}...`);
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const r = this.fail('checksum_hash', table.name,
          `Table hash mismatch (${algorithm.toUpperCase()}): source=${sourceHash.hash.substring(0, 16)}... target=${targetHash.hash.substring(0, 16)}...`,
          'HIGH',
          'Run reconciliation agent for detailed row-level comparison');
        r.durationMs = durationMs;
        results.push(r);
      }
    } catch (error) {
      results.push(this.warn('checksum_hash', table.name,
        `Failed to compute table hash: ${error instanceof Error ? error.message : String(error)}`,
        'MEDIUM'));
    }

    // Rule 6: Constraint Preservation
    try {
      const { result: res, durationMs } = await this.timed(async () => {
        const sourceConstraints = await sourceDb.getConstraints(table.name, table.schema);
        const targetConstraints = await targetDb.getConstraints(table.name, table.schema);
        return { sourceConstraints, targetConstraints };
      });

      const { sourceConstraints, targetConstraints } = res;
      const missing: string[] = [];

      // Check that key constraints are preserved (by type and columns)
      for (const srcC of sourceConstraints) {
        if (srcC.type === 'NOT NULL' || srcC.type === 'CHECK') continue; // checked separately

        const found = targetConstraints.some(
          (tgtC) =>
            tgtC.type === srcC.type &&
            JSON.stringify(tgtC.columns.sort()) === JSON.stringify(srcC.columns.sort())
        );

        if (!found) {
          missing.push(`${srcC.type} on (${srcC.columns.join(', ')})`);
        }
      }

      if (missing.length === 0) {
        const r = this.pass('constraint_preservation', table.name,
          `All ${sourceConstraints.length} constraints preserved`);
        r.durationMs = durationMs;
        r.severity = 'MEDIUM';
        results.push(r);
      } else {
        const r = this.fail('constraint_preservation', table.name,
          `${missing.length} constraints missing on target: ${missing.join('; ')}`,
          'MEDIUM',
          'Re-create missing constraints on target database');
        r.durationMs = durationMs;
        results.push(r);
      }
    } catch (error) {
      results.push(this.warn('constraint_preservation', table.name,
        `Failed to compare constraints: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 7: Volume Baseline Check
    try {
      const { result: targetCount, durationMs } = await this.timed(() =>
        targetDb.getRowCount(table.name, table.schema)
      );

      // Volume baseline is a sanity check — if we expect at least some rows
      if (targetCount === 0) {
        const r = this.fail('volume_baseline', table.name,
          'Target table is empty — zero rows migrated',
          'HIGH',
          'Check ETL pipeline execution logs');
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const r = this.pass('volume_baseline', table.name,
          `Target table has ${targetCount.toLocaleString()} rows`);
        r.durationMs = durationMs;
        results.push(r);
      }
    } catch (error) {
      results.push(this.fail('volume_baseline', table.name,
        `Failed to check volume: ${error instanceof Error ? error.message : String(error)}`));
    }

    return results;
  }
}
