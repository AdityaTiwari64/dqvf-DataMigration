import { BaseAgent } from './base-agent.js';
import type { AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { RuleCheckResult } from '../types/report.js';
import { createLogger } from '../utils/logger.js';
import { ksTest, iqrOutliers, zScoreOutliers, compareFrequencies } from '../utils/stats.js';
import { findFuzzyDuplicates } from '../utils/fuzzy.js';

export class PatternAnalysisAgent extends BaseAgent {
  readonly name = 'pattern_analysis';
  readonly description = 'Global data shape and distribution change detection';

  constructor() {
    super();
    this.log = createLogger('PatternAnalysisAgent');
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

    for (const col of sourceColumns) {
      if (skipCols.includes(col.name)) continue;

      const isNumeric = ['int', 'integer', 'bigint', 'smallint', 'float', 'double', 'decimal',
        'numeric', 'real', 'money'].some((t) => col.dataType.toLowerCase().includes(t));
      const isString = ['char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext']
        .some((t) => col.dataType.toLowerCase().includes(t));

      // Rule 1: Distribution Drift (numeric columns)
      if (isNumeric) {
        try {
          const sourceValues = (await sourceDb.getColumnValues(table.name, col.name, 10000, table.schema))
            .filter((v): v is number => typeof v === 'number');
          const targetValues = (await targetDb.getColumnValues(table.name, col.name, 10000, table.schema))
            .filter((v): v is number => typeof v === 'number');

          if (sourceValues.length > 10 && targetValues.length > 10) {
            const ks = ksTest(sourceValues, targetValues, thresholds.distribution_drift_pvalue);

            if (ks.significant) {
              results.push(
                this.fail('distribution_drift', table.name,
                  `Statistical distribution drift detected (KS statistic=${ks.statistic.toFixed(4)}, p-value=${ks.pValue.toFixed(6)})`,
                  'HIGH', undefined, col.name,
                  { ksStatistic: ks.statistic, pValue: ks.pValue })
              );
            } else {
              results.push(
                this.pass('distribution_drift', table.name,
                  `Distribution stable (KS p-value=${ks.pValue.toFixed(4)})`, col.name)
              );
            }
          }

          // Rule 2: Outlier Detection
          if (targetValues.length > 10) {
            const iqr = iqrOutliers(targetValues);
            const zOutliers = zScoreOutliers(targetValues);

            const totalOutliers = new Set([
              ...iqr.outliers.map((o) => o.index),
              ...zOutliers.outliers.map((o) => o.index),
            ]).size;

            const outlierRate = totalOutliers / targetValues.length * 100;

            if (outlierRate > 10) {
              results.push(
                this.fail('outlier_detection', table.name,
                  `High outlier rate: ${outlierRate.toFixed(1)}% of values are outliers (${totalOutliers} of ${targetValues.length})`,
                  'MEDIUM', undefined, col.name,
                  { iqrOutliers: iqr.outliers.length, zScoreOutliers: zOutliers.outliers.length })
              );
            } else if (totalOutliers > 0) {
              results.push(
                this.warn('outlier_detection', table.name,
                  `${totalOutliers} outliers detected (${outlierRate.toFixed(1)}% of values)`,
                  'MEDIUM', col.name)
              );
            } else {
              results.push(
                this.pass('outlier_detection', table.name,
                  'No outliers detected', col.name)
              );
            }
          }
        } catch (error) {
          this.log.warn(`Distribution analysis failed for ${col.name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Rule 3: Pattern Mining & Frequency Shift
      if (isString || !isNumeric) {
        try {
          const sourceFreqs = await sourceDb.getValueFrequencies(table.name, col.name, 50, table.schema);
          const targetFreqs = await targetDb.getValueFrequencies(table.name, col.name, 50, table.schema);

          if (sourceFreqs.length > 0 && targetFreqs.length > 0) {
            const shifts = compareFrequencies(sourceFreqs, targetFreqs, 20);
            const significantShifts = shifts.filter((s) => s.shift > 0.05);

            if (significantShifts.length > 5) {
              const topShifts = significantShifts.slice(0, 3)
                .map((s) => `"${s.value}": ${(s.sourceFrequency * 100).toFixed(1)}% → ${(s.targetFrequency * 100).toFixed(1)}%`)
                .join('; ');

              results.push(
                this.fail('frequency_shift', table.name,
                  `${significantShifts.length} significant value frequency shifts. Top: ${topShifts}`,
                  'MEDIUM', undefined, col.name)
              );
            } else if (significantShifts.length > 0) {
              results.push(
                this.warn('frequency_shift', table.name,
                  `${significantShifts.length} minor value frequency shifts detected`,
                  'MEDIUM', col.name)
              );
            }
          }
        } catch {
          // Frequency analysis is best-effort
        }
      }

      // Rule 5: Fuzzy Duplicate Detection (string columns)
      if (isString) {
        try {
          const targetValues = (await targetDb.getColumnValues(table.name, col.name, 5000, table.schema))
            .filter((v): v is string => typeof v === 'string');

          if (targetValues.length > 1 && targetValues.length <= 5000) {
            const duplicates = findFuzzyDuplicates(
              targetValues,
              thresholds.levenshtein_max_distance
            );

            if (duplicates.length > 0) {
              const topGroups = duplicates.slice(0, 3)
                .map((g) => `[${g.group.slice(0, 3).map((v) => `"${v}"`).join(', ')}] (dist=${g.distance})`)
                .join('; ');

              results.push(
                this.fail('fuzzy_duplicates', table.name,
                  `${duplicates.length} fuzzy duplicate group(s) detected. Examples: ${topGroups}`,
                  'MEDIUM',
                  'Review near-duplicate values for potential data quality issues',
                  col.name)
              );
            }
          }
        } catch {
          // Fuzzy detection is best-effort
        }
      }
    }

    // Rule 4: Schema Drift Detection
    try {
      const targetColumns = await targetDb.getColumns(table.name, table.schema);
      const sourceColNames = new Set(sourceColumns.map((c) => c.name.toLowerCase()));
      const targetColNames = new Set(targetColumns.map((c) => c.name.toLowerCase()));

      const addedColumns = [...targetColNames].filter((c) => !sourceColNames.has(c));
      const removedColumns = [...sourceColNames].filter((c) => !targetColNames.has(c));

      if (addedColumns.length > 0 || removedColumns.length > 0) {
        const details: string[] = [];
        if (addedColumns.length > 0) details.push(`added: ${addedColumns.join(', ')}`);
        if (removedColumns.length > 0) details.push(`removed: ${removedColumns.join(', ')}`);

        results.push(
          this.fail('schema_drift', table.name,
            `Schema drift detected: ${details.join('; ')}`,
            'HIGH',
            'Review schema changes and update migration scripts')
        );
      } else {
        results.push(
          this.pass('schema_drift', table.name, 'No schema drift detected')
        );
      }
    } catch (error) {
      results.push(this.fail('schema_drift', table.name,
        `Error checking schema drift: ${error instanceof Error ? error.message : String(error)}`));
    }

    return results;
  }
}
