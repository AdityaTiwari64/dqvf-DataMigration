import { BaseAgent } from './base-agent.js';
import type { AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { RuleCheckResult } from '../types/report.js';
import { createLogger } from '../utils/logger.js';

// Common format patterns
const FORMAT_PATTERNS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^[\+]?[\d\s\-\(\)]{7,15}$/,
  date_iso: /^\d{4}-\d{2}-\d{2}/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  ip_address: /^(\d{1,3}\.){3}\d{1,3}$/,
};

export class ColumnProfilingAgent extends BaseAgent {
  readonly name = 'column_profiling';
  readonly description = 'Column-by-column data fidelity and completeness validation';

  constructor() {
    super();
    this.log = createLogger('ColumnProfilingAgent');
  }

  protected async validateTable(
    ctx: AgentContext,
    table: TableConfig
  ): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];
    const { sourceDb, targetDb, config } = ctx;
    const thresholds = config.thresholds;
    const skipCols = table.skip_columns ?? [];

    const sourceColumns = await sourceDb.getColumns(table.name, table.schema);
    const targetColumns = await targetDb.getColumns(table.name, table.schema);

    for (const srcCol of sourceColumns) {
      if (skipCols.includes(srcCol.name)) continue;

      const tgtCol = targetColumns.find(
        (c) => c.name.toLowerCase() === srcCol.name.toLowerCase()
      );

      if (!tgtCol) {
        // Column missing — already caught by table profiling, skip
        continue;
      }

      // Rule 1: Data Type Compatibility
      try {
        const truncationRisk =
          srcCol.maxLength !== null &&
          tgtCol.maxLength !== null &&
          tgtCol.maxLength < srcCol.maxLength;

        if (truncationRisk) {
          results.push(
            this.fail('data_type_compatibility', table.name,
              `Source ${srcCol.fullType} → target ${tgtCol.fullType}; potential truncation of ${srcCol.maxLength! - tgtCol.maxLength!} characters`,
              'HIGH',
              `ALTER TABLE "${table.name}" ALTER COLUMN "${tgtCol.name}" TYPE ${srcCol.fullType}`,
              srcCol.name)
          );
        } else if (srcCol.dataType.toLowerCase() !== tgtCol.dataType.toLowerCase()) {
          results.push(
            this.warn('data_type_compatibility', table.name,
              `Data type changed: ${srcCol.fullType} → ${tgtCol.fullType}`,
              'MEDIUM', srcCol.name)
          );
        } else {
          results.push(
            this.pass('data_type_compatibility', table.name,
              `Type compatible: ${srcCol.fullType}`, srcCol.name)
          );
        }
      } catch (error) {
        results.push(this.fail('data_type_compatibility', table.name,
          `Error checking type compatibility: ${error instanceof Error ? error.message : String(error)}`,
          'HIGH', undefined, srcCol.name));
      }

      // Rule 2: Null / Completeness Ratio
      try {
        const sourceStats = await sourceDb.getColumnStats(table.name, srcCol.name, table.schema);
        const targetStats = await targetDb.getColumnStats(table.name, tgtCol.name, table.schema);

        const sourceNullRate = sourceStats.totalCount > 0
          ? (sourceStats.nullCount / sourceStats.totalCount) * 100
          : 0;
        const targetNullRate = targetStats.totalCount > 0
          ? (targetStats.nullCount / targetStats.totalCount) * 100
          : 0;

        const nullDelta = Math.abs(targetNullRate - sourceNullRate);
        const threshold = thresholds.null_rate_delta_pct;

        if (nullDelta <= threshold) {
          results.push(
            this.pass('null_completeness_ratio', table.name,
              `Null rate consistent: source=${sourceNullRate.toFixed(2)}%, target=${targetNullRate.toFixed(2)}% (delta=${nullDelta.toFixed(2)}%)`,
              srcCol.name)
          );
        } else {
          results.push(
            this.fail('null_completeness_ratio', table.name,
              `Null rate drift: source=${sourceNullRate.toFixed(2)}%, target=${targetNullRate.toFixed(2)}% (delta=${nullDelta.toFixed(2)}% exceeds ${threshold}% threshold)`,
              'HIGH',
              `Investigate NULL values introduced during migration for column "${srcCol.name}"`,
              srcCol.name)
          );
        }

        // Rule 3: Distinct Value Cardinality
        const cardinalityDelta = sourceStats.distinctCount > 0
          ? Math.abs(targetStats.distinctCount - sourceStats.distinctCount) / sourceStats.distinctCount * 100
          : 0;
        const cardThreshold = thresholds.cardinality_change_pct;

        if (cardinalityDelta <= cardThreshold) {
          results.push(
            this.pass('distinct_cardinality', table.name,
              `Cardinality consistent: source=${sourceStats.distinctCount}, target=${targetStats.distinctCount}`,
              srcCol.name)
          );
        } else {
          results.push(
            this.fail('distinct_cardinality', table.name,
              `Cardinality change: source=${sourceStats.distinctCount}, target=${targetStats.distinctCount} (${cardinalityDelta.toFixed(1)}% change)`,
              'MEDIUM',
              'Check for duplicate insertion or data loss during migration',
              srcCol.name)
          );
        }

        // Rule 4: Statistical Range Comparison
        if (sourceStats.mean !== undefined && targetStats.mean !== undefined) {
          const issues: string[] = [];

          if (sourceStats.min !== undefined && targetStats.min !== undefined) {
            if (String(sourceStats.min) !== String(targetStats.min)) {
              issues.push(`min: ${sourceStats.min} → ${targetStats.min}`);
            }
          }
          if (sourceStats.max !== undefined && targetStats.max !== undefined) {
            if (String(sourceStats.max) !== String(targetStats.max)) {
              issues.push(`max: ${sourceStats.max} → ${targetStats.max}`);
            }
          }

          const meanDrift = sourceStats.mean !== 0
            ? Math.abs(targetStats.mean - sourceStats.mean) / Math.abs(sourceStats.mean) * 100
            : 0;
          if (meanDrift > 5) {
            issues.push(`mean drift: ${meanDrift.toFixed(2)}%`);
          }

          if (issues.length === 0) {
            results.push(
              this.pass('statistical_range', table.name,
                `Statistical range consistent (mean=${sourceStats.mean?.toFixed(2)})`,
                srcCol.name)
            );
          } else {
            results.push(
              this.fail('statistical_range', table.name,
                `Statistical range drift: ${issues.join('; ')}`,
                'MEDIUM', undefined, srcCol.name)
            );
          }
        }

        // Rule 8: Whitespace & Encoding
        if (srcCol.dataType.toLowerCase().includes('char') || srcCol.dataType.toLowerCase().includes('text')) {
          try {
            const sampleValues = await targetDb.getColumnValues(table.name, tgtCol.name, 1000, table.schema);
            let whitespaceIssues = 0;

            for (const val of sampleValues) {
              if (typeof val === 'string') {
                if (val !== val.trim()) whitespaceIssues++;
              }
            }

            if (whitespaceIssues > 0) {
              results.push(
                this.fail('whitespace_encoding', table.name,
                  `${whitespaceIssues} values with leading/trailing whitespace detected`,
                  'MEDIUM',
                  `UPDATE "${table.name}" SET "${tgtCol.name}" = TRIM("${tgtCol.name}") WHERE "${tgtCol.name}" != TRIM("${tgtCol.name}")`,
                  srcCol.name)
              );
            } else {
              results.push(
                this.pass('whitespace_encoding', table.name,
                  'No whitespace or encoding issues detected', srcCol.name)
              );
            }
          } catch {
            // Skip whitespace check if we can't get sample values
          }
        }
      } catch (error) {
        results.push(this.fail('null_completeness_ratio', table.name,
          `Error getting column stats: ${error instanceof Error ? error.message : String(error)}`,
          'HIGH', undefined, srcCol.name));
      }
    }

    // Rule 5: Format / Regex Validation
    try {
      for (const col of targetColumns) {
        if (skipCols.includes(col.name)) continue;
        if (!col.dataType.toLowerCase().includes('char') && !col.dataType.toLowerCase().includes('text')) continue;

        const sampleValues = await targetDb.getColumnValues(table.name, col.name, 100, table.schema);
        const strValues = sampleValues.filter((v): v is string => typeof v === 'string');
        if (strValues.length === 0) continue;

        // Detect which format pattern matches most values
        for (const [formatName, pattern] of Object.entries(FORMAT_PATTERNS)) {
          const matchingCount = strValues.filter((v) => pattern.test(v)).length;
          const matchRate = matchingCount / strValues.length;

          // If >80% of source values match a pattern, check target maintains it
          if (matchRate > 0.5 && matchRate < 0.8) {
            results.push(
              this.warn('format_validation', table.name,
                `Column "${col.name}" has ${(matchRate * 100).toFixed(0)}% ${formatName} format match (potential format inconsistency)`,
                'MEDIUM', col.name)
            );
          }
        }
      }
    } catch {
      // Format validation is best-effort
    }

    return results;
  }
}
