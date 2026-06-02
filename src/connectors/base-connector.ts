/**
 * Abstract database connector defining the interface all DB connectors must implement.
 * Provides schema introspection, statistics, hashing, and query capabilities.
 */

import type {
  ColumnMetadata,
  ColumnStats,
  ConstraintInfo,
  ForeignKeyInfo,
  HashResult,
  SampleRow,
  TableSchema,
  DqvfCheckpoint,
} from '../types/database.js';

export abstract class DatabaseConnector {
  abstract readonly type: string;

  /**
   * Test the database connection.
   * @throws Error if connection fails
   */
  abstract testConnection(): Promise<void>;

  /**
   * Get the row count for a table.
   */
  abstract getRowCount(table: string, schema?: string): Promise<number>;

  /**
   * Get full schema metadata for a table.
   */
  abstract getTableSchema(table: string, schema?: string): Promise<TableSchema>;

  /**
   * Get column metadata for a specific table.
   */
  abstract getColumns(table: string, schema?: string): Promise<ColumnMetadata[]>;

  /**
   * Get primary key column names for a table.
   */
  abstract getPrimaryKeys(table: string, schema?: string): Promise<string[]>;

  /**
   * Get foreign key references for a table.
   */
  abstract getForeignKeys(table: string, schema?: string): Promise<ForeignKeyInfo[]>;

  /**
   * Get constraints (PK, FK, UNIQUE, CHECK, NOT NULL) for a table.
   */
  abstract getConstraints(table: string, schema?: string): Promise<ConstraintInfo[]>;

  /**
   * Get column-level statistics (null count, distinct, min, max, mean, stddev).
   */
  abstract getColumnStats(table: string, column: string, schema?: string): Promise<ColumnStats>;

  /**
   * Get sample rows from a table for LLM analysis.
   */
  abstract getSampleRows(table: string, limit: number, schema?: string): Promise<SampleRow[]>;

  /**
   * Get distinct values for a column (for pattern/frequency analysis).
   */
  abstract getColumnValues(
    table: string,
    column: string,
    limit: number,
    schema?: string
  ): Promise<unknown[]>;

  /**
   * Get value frequency distribution for a column (top-N values with counts).
   */
  abstract getValueFrequencies(
    table: string,
    column: string,
    topN: number,
    schema?: string
  ): Promise<Array<{ value: unknown; count: number }>>;

  /**
   * Compute a table-level hash for row-order-independent comparison.
   */
  abstract getTableHash(
    table: string,
    algorithm: 'md5' | 'sha256',
    schema?: string
  ): Promise<HashResult>;

  /**
   * Compute a hash for a chunk of rows (for parallel reconciliation).
   */
  abstract getChunkHash(
    table: string,
    pkColumn: string,
    offset: number,
    limit: number,
    algorithm: 'md5' | 'sha256',
    schema?: string
  ): Promise<HashResult>;

  /**
   * Get all primary key values for missing-record detection.
   */
  abstract getPrimaryKeyValues(
    table: string,
    pkColumn: string,
    schema?: string
  ): Promise<string[]>;

  /**
   * Find duplicate primary keys.
   */
  abstract findDuplicatePrimaryKeys(
    table: string,
    pkColumn: string,
    schema?: string
  ): Promise<Array<{ key: string; count: number }>>;

  /**
   * Check referential integrity — find FK values with no matching parent.
   */
  abstract findOrphanedForeignKeys(
    table: string,
    fk: ForeignKeyInfo,
    schema?: string
  ): Promise<number>;

  /**
   * Get the most recent timestamp value in a column (for freshness checks).
   */
  abstract getMaxTimestamp(table: string, column: string, schema?: string): Promise<Date | null>;

  /**
   * Find rows where a date column has future dates or null values.
   */
  abstract findTimestampAnomalies(
    table: string,
    column: string,
    schema?: string
  ): Promise<{ futureCount: number; nullCount: number }>;

  /**
   * Execute a raw SQL query (escape hatch for complex validations).
   */
  abstract executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Get DDL / CREATE TABLE statement (for LLM schema mapping).
   */
  abstract getTableDDL(table: string, schema?: string): Promise<string>;

  // Checkpoint Management

  /**
   * Ensure the _dqvf_checkpoints table exists on the target DB.
   */
  abstract ensureCheckpointTable(): Promise<void>;

  /**
   * Get the last checkpoint for a table.
   */
  abstract getCheckpoint(table: string, runId: string): Promise<DqvfCheckpoint | null>;

  /**
   * Save a checkpoint for a table.
   */
  abstract saveCheckpoint(checkpoint: DqvfCheckpoint): Promise<void>;

  /**
   * Close the database connection and release resources.
   */
  abstract disconnect(): Promise<void>;
}
