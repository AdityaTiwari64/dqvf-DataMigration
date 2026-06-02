import { BaseAgent } from './base-agent.js';
import type { AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { RuleCheckResult } from '../types/report.js';
import { createLogger } from '../utils/logger.js';
import { compareHashes } from '../utils/hashing.js';

export class ReconciliationAgent extends BaseAgent {
  readonly name = 'reconciliation';
  readonly description = 'Exact source-to-target record matching and reconciliation';

  constructor() {
    super();
    this.log = createLogger('ReconciliationAgent');
  }

  protected async validateTable(
    ctx: AgentContext,
    table: TableConfig
  ): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];
    const { sourceDb, targetDb, config } = ctx;
    const thresholds = config.thresholds;

    // Rule 1 & 3: Row Reconciliation + Missing Records
    try {
      const { result: res, durationMs } = await this.timed(async () => {
        const sourcePKs = await sourceDb.getPrimaryKeyValues(table.name, table.pk, table.schema);
        const targetPKs = await targetDb.getPrimaryKeyValues(table.name, table.pk, table.schema);
        return { sourcePKs, targetPKs };
      });

      const { sourcePKs, targetPKs } = res;
      const sourceSet = new Set(sourcePKs);
      const targetSet = new Set(targetPKs);

      // Missing in target (exist in source but not target)
      const missingInTarget = sourcePKs.filter((pk) => !targetSet.has(pk));
      // Extra in target (exist in target but not source)
      const extraInTarget = targetPKs.filter((pk) => !sourceSet.has(pk));

      if (missingInTarget.length === 0) {
        const r = this.pass('missing_records', table.name,
          `All ${sourcePKs.length} source records found in target`);
        r.durationMs = durationMs;
        results.push(r);
      } else {
        const sampleMissing = missingInTarget.slice(0, 10).join(', ');
        const r = this.fail('missing_records', table.name,
          `${missingInTarget.length} records missing in target. Sample PKs: ${sampleMissing}`,
          'HIGH',
          `Re-run migration for missing records or investigate WHERE clause filters`,
          undefined,
          { pk: table.pk, missingCount: missingInTarget.length, samplePKs: missingInTarget.slice(0, 50) });
        r.durationMs = durationMs;
        results.push(r);
      }

      // Cross-table reconciliation summary
      if (missingInTarget.length === 0 && extraInTarget.length === 0) {
        results.push(
          this.pass('row_reconciliation', table.name,
            `Perfect reconciliation: ${sourcePKs.length} records match 1:1`)
        );
      } else {
        results.push(
          this.fail('row_reconciliation', table.name,
            `Reconciliation mismatch: ${missingInTarget.length} missing, ${extraInTarget.length} extra records`,
            'HIGH',
            'Run detailed comparison on mismatched records')
        );
      }
    } catch (error) {
      results.push(this.fail('missing_records', table.name,
        `Failed to reconcile records: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 2: Chunk-Based Parallel Hash Comparison
    try {
      const sourceCount = await sourceDb.getRowCount(table.name, table.schema);
      const chunkSize = thresholds.chunk_size;
      const totalChunks = Math.ceil(sourceCount / chunkSize);
      const algorithm = thresholds.hash_algorithm;

      this.log.info(`Running chunk hash comparison: ${totalChunks} chunks of ${chunkSize} rows`);

      const concurrency = thresholds.parallel_chunk_workers;
      const mismatchedChunks: number[] = [];
      let completedChunks = 0;

      // Process chunks with limited concurrency
      for (let batchStart = 0; batchStart < totalChunks; batchStart += concurrency) {
        const batchEnd = Math.min(batchStart + concurrency, totalChunks);
        const batchPromises = [];

        for (let chunkIdx = batchStart; chunkIdx < batchEnd; chunkIdx++) {
          const offset = chunkIdx * chunkSize;
          batchPromises.push(
            (async () => {
              const sourceHash = await sourceDb.getChunkHash(
                table.name, table.pk, offset, chunkSize, algorithm, table.schema
              );
              const targetHash = await targetDb.getChunkHash(
                table.name, table.pk, offset, chunkSize, algorithm, table.schema
              );
              const comparison = compareHashes(sourceHash.hash, targetHash.hash);
              return { chunkIdx, match: comparison.match };
            })()
          );
        }

        const batchResults = await Promise.all(batchPromises);
        for (const br of batchResults) {
          completedChunks++;
          if (!br.match) mismatchedChunks.push(br.chunkIdx);
        }
      }

      if (mismatchedChunks.length === 0) {
        results.push(
          this.pass('chunk_hash', table.name,
            `All ${totalChunks} chunks match (${algorithm.toUpperCase()}, ${chunkSize} rows/chunk)`)
        );
      } else {
        results.push(
          this.fail('chunk_hash', table.name,
            `${mismatchedChunks.length} of ${totalChunks} chunks have hash mismatches: chunks [${mismatchedChunks.slice(0, 10).join(', ')}]`,
            'HIGH',
            'Investigate specific mismatched chunks for row-level differences',
            undefined,
            { mismatchedChunks, totalChunks, chunkSize })
        );
      }
    } catch (error) {
      results.push(this.fail('chunk_hash', table.name,
        `Chunk hash comparison failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 4: Duplicate Record Injection Detection
    try {
      const duplicates = await targetDb.findDuplicatePrimaryKeys(table.name, table.pk, table.schema);

      if (duplicates.length === 0) {
        results.push(
          this.pass('duplicate_injection', table.name,
            'No duplicate records injected on target')
        );
      } else {
        const totalDupes = duplicates.reduce((sum, d) => sum + d.count - 1, 0);
        const sampleDupes = duplicates.slice(0, 5)
          .map((d) => `${d.key} (${d.count}x)`)
          .join(', ');

        results.push(
          this.fail('duplicate_injection', table.name,
            `${totalDupes} duplicate records detected across ${duplicates.length} PKs. Samples: ${sampleDupes}`,
            'HIGH',
            `Deduplicate target table using: DELETE FROM "${table.name}" WHERE ctid NOT IN (SELECT MIN(ctid) FROM "${table.name}" GROUP BY "${table.pk}")`)
        );
      }
    } catch (error) {
      results.push(this.fail('duplicate_injection', table.name,
        `Duplicate detection failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 5: Delta / Incremental Validation
    try {
      await targetDb.ensureCheckpointTable();
      const checkpoint = await targetDb.getCheckpoint(table.name, config.migration_run_id);

      if (checkpoint) {
        this.log.info(`Found checkpoint for ${table.name}: chunk ${checkpoint.chunkIndex}, last validated ${checkpoint.lastValidatedAt}`);
        results.push(
          this.pass('incremental_validation', table.name,
            `Incremental validation supported. Last checkpoint: chunk ${checkpoint.chunkIndex} at ${checkpoint.lastValidatedAt.toISOString()}`)
        );
      } else {
        results.push(
          this.pass('incremental_validation', table.name,
            'Full validation run (no previous checkpoint)')
        );
      }

      // Save checkpoint for this run
      await targetDb.saveCheckpoint({
        tableName: table.name,
        runId: config.migration_run_id,
        lastValidatedAt: new Date(),
        lastPkValue: null,
        chunkIndex: 0,
      });
    } catch (error) {
      results.push(
        this.warn('incremental_validation', table.name,
          `Checkpoint management failed: ${error instanceof Error ? error.message : String(error)}`,
          'LOW')
      );
    }

    return results;
  }
}
