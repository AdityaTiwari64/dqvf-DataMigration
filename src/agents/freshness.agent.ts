import { BaseAgent } from './base-agent.js';
import type { AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { RuleCheckResult } from '../types/report.js';
import { createLogger } from '../utils/logger.js';

export class FreshnessAgent extends BaseAgent {
  readonly name = 'freshness';
  readonly description = 'Time-related data quality, SLA compliance, and CDC pipeline health validation';

  constructor() {
    super();
    this.log = createLogger('FreshnessAgent');
  }

  protected async validateTable(
    ctx: AgentContext,
    table: TableConfig
  ): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];
    const { targetDb, config } = ctx;
    const thresholds = config.thresholds;

    // Discover timestamp columns
    const columns = await targetDb.getColumns(table.name, table.schema);
    const timestampColumns = columns.filter((c) => {
      const dt = c.dataType.toLowerCase();
      return dt.includes('timestamp') || dt.includes('datetime') || dt.includes('date');
    });

    if (timestampColumns.length === 0) {
      results.push(
        this.skip('data_freshness', table.name, 'No timestamp columns found — skipping freshness checks')
      );
      return results;
    }

    // Rule 1: Data Freshness / Currency
    try {
      const slaHours = table.sla_freshness_hours ?? 24;

      // Find the best candidate for "most recent data" timestamp
      const freshnessCol = timestampColumns.find((c) =>
        c.name.toLowerCase().includes('updat') ||
        c.name.toLowerCase().includes('modif') ||
        c.name.toLowerCase().includes('creat')
      ) ?? timestampColumns[0];

      const maxTs = await targetDb.getMaxTimestamp(table.name, freshnessCol.name, table.schema);

      if (!maxTs) {
        results.push(
          this.fail('data_freshness', table.name,
            `No timestamp data found in column "${freshnessCol.name}"`,
            'MEDIUM',
            'Check if timestamp column is populated during migration')
        );
      } else {
        const ageHours = (Date.now() - maxTs.getTime()) / (1000 * 60 * 60);

        if (ageHours <= slaHours) {
          results.push(
            this.pass('data_freshness', table.name,
              `Data is fresh: most recent record is ${ageHours.toFixed(1)} hours old (SLA: ${slaHours}h)`,
              freshnessCol.name)
          );
        } else {
          results.push(
            this.fail('data_freshness', table.name,
              `Data is stale: most recent record is ${ageHours.toFixed(1)} hours old (SLA: ${slaHours}h exceeded by ${(ageHours - slaHours).toFixed(1)}h)`,
              'MEDIUM',
              'Investigate CDC pipeline delays or stalled ETL jobs',
              freshnessCol.name,
              { ageHours, slaHours, lastTimestamp: maxTs.toISOString() })
          );
        }
      }
    } catch (error) {
      results.push(this.fail('data_freshness', table.name,
        `Freshness check failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 2: Temporal / Date Sequence Validation
    for (const tsCol of timestampColumns) {
      try {
        const anomalies = await targetDb.findTimestampAnomalies(table.name, tsCol.name, table.schema);

        if (anomalies.futureCount > 0) {
          results.push(
            this.fail('temporal_sequence', table.name,
              `${anomalies.futureCount} future-dated records in column "${tsCol.name}"`,
              'HIGH',
              `Investigate timezone conversion issues; consider: UPDATE "${table.name}" SET "${tsCol.name}" = NOW() WHERE "${tsCol.name}" > NOW()`,
              tsCol.name)
          );
        } else {
          results.push(
            this.pass('temporal_sequence', table.name,
              `No future dates in "${tsCol.name}"`, tsCol.name)
          );
        }
      } catch (error) {
        results.push(this.fail('temporal_sequence', table.name,
          `Temporal check failed for "${tsCol.name}": ${error instanceof Error ? error.message : String(error)}`,
          'HIGH', undefined, tsCol.name));
      }
    }

    // Rule 3: Pipeline Lag / CDC Delay
    try {
      const cdcMaxMinutes = thresholds.cdc_lag_max_minutes;

      // Look for a CDC metadata column (common patterns)
      const cdcCol = timestampColumns.find((c) => {
        const name = c.name.toLowerCase();
        return name.includes('cdc') || name.includes('replicated') ||
               name.includes('synced') || name.includes('loaded') ||
               name.includes('etl');
      });

      if (cdcCol) {
        const maxTs = await targetDb.getMaxTimestamp(table.name, cdcCol.name, table.schema);
        if (maxTs) {
          const lagMinutes = (Date.now() - maxTs.getTime()) / (1000 * 60);

          if (lagMinutes <= cdcMaxMinutes) {
            results.push(
              this.pass('pipeline_lag', table.name,
                `CDC lag is ${lagMinutes.toFixed(1)} minutes (within ${cdcMaxMinutes} min threshold)`,
                cdcCol.name)
            );
          } else {
            results.push(
              this.fail('pipeline_lag', table.name,
                `CDC lag is ${lagMinutes.toFixed(1)} minutes (exceeds ${cdcMaxMinutes} min threshold)`,
                'HIGH',
                'Check CDC replication pipeline health and consumer lag',
                cdcCol.name,
                { lagMinutes, threshold: cdcMaxMinutes })
            );
          }
        }
      } else {
        results.push(
          this.skip('pipeline_lag', table.name,
            'No CDC metadata column found — pipeline lag check skipped')
        );
      }
    } catch (error) {
      results.push(this.skip('pipeline_lag', table.name,
        `Pipeline lag check failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 4: Timestamp Integrity
    for (const tsCol of timestampColumns) {
      if (!tsCol.isNullable) continue; // NOT NULL constraint handles it

      try {
        const anomalies = await targetDb.findTimestampAnomalies(table.name, tsCol.name, table.schema);

        if (anomalies.nullCount > 0) {
          const totalCount = await targetDb.getRowCount(table.name, table.schema);
          const nullRate = (anomalies.nullCount / totalCount) * 100;

          results.push(
            this.fail('timestamp_integrity', table.name,
              `${anomalies.nullCount} null timestamps in "${tsCol.name}" (${nullRate.toFixed(2)}% of rows)`,
              'MEDIUM',
              `Investigate missing timestamps; consider: UPDATE "${table.name}" SET "${tsCol.name}" = NOW() WHERE "${tsCol.name}" IS NULL`,
              tsCol.name)
          );
        } else {
          results.push(
            this.pass('timestamp_integrity', table.name,
              `No null timestamps in "${tsCol.name}"`, tsCol.name)
          );
        }
      } catch (error) {
        results.push(this.fail('timestamp_integrity', table.name,
          `Timestamp integrity check failed: ${error instanceof Error ? error.message : String(error)}`,
          'MEDIUM', undefined, tsCol.name));
      }
    }

    // Rule 5: Stale Partition Detection
    try {
      // Check if any timestamp column has very old data partitions
      const slaHours = table.sla_freshness_hours ?? 24;
      const slaWindow = new Date(Date.now() - slaHours * 60 * 60 * 1000);

      const freshnessCol = timestampColumns.find((c) =>
        c.name.toLowerCase().includes('creat') || c.name.toLowerCase().includes('updat')
      ) ?? timestampColumns[0];

      // Find oldest data
      const oldestData = await targetDb.executeRaw<{ oldest: string }>(
        `SELECT MIN("${freshnessCol.name}")::text AS oldest FROM "${table.schema ?? 'public'}"."${table.name}" WHERE "${freshnessCol.name}" IS NOT NULL`
      );

      if (oldestData.length > 0 && oldestData[0].oldest) {
        const oldestDate = new Date(oldestData[0].oldest);
        const ageHours = (Date.now() - oldestDate.getTime()) / (1000 * 60 * 60);

        // Warn if oldest partition is significantly older than expected
        if (ageHours > slaHours * 24 * 30) {
          // More than 30x the SLA window
          results.push(
            this.warn('stale_partition', table.name,
              `Very old data detected: oldest record is ${(ageHours / 24).toFixed(0)} days old in column "${freshnessCol.name}"`,
              'MEDIUM', freshnessCol.name)
          );
        } else {
          results.push(
            this.pass('stale_partition', table.name,
              `Data age within expected range (oldest: ${(ageHours / 24).toFixed(0)} days)`,
              freshnessCol.name)
          );
        }
      }
    } catch {
      // Stale partition detection is best-effort
    }

    return results;
  }
}
