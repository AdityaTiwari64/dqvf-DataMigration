/**
 * Database schema metadata types used by connectors and agents.
 */

// Database Type

export type DatabaseType = 'postgresql' | 'neon' | 'sqlserver' | 'mysql' | 'mongodb';

// Column Metadata

export interface ColumnMetadata {
  name: string;
  dataType: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  isNullable: boolean;
  ordinalPosition: number;
  columnDefault: string | null;
  /** Full type string, e.g. "VARCHAR(100)" */
  fullType: string;
}

// Constraint Info

export type ConstraintType = 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'NOT NULL';

export interface ConstraintInfo {
  name: string;
  type: ConstraintType;
  columns: string[];
  /** For FK: the referenced table */
  referencedTable?: string;
  /** For FK: the referenced columns */
  referencedColumns?: string[];
  /** For CHECK: the check expression */
  checkExpression?: string;
}

// Table Schema

export interface TableSchema {
  tableName: string;
  schemaName: string;
  columns: ColumnMetadata[];
  constraints: ConstraintInfo[];
  primaryKeyColumns: string[];
}

// Column Statistics

export interface ColumnStats {
  columnName: string;
  totalCount: number;
  nullCount: number;
  distinctCount: number;
  /** Numeric columns only */
  min?: number | string;
  max?: number | string;
  mean?: number;
  stddev?: number;
  /** String columns: min/max length */
  minLength?: number;
  maxLength?: number;
  avgLength?: number;
}

// Foreign Key Reference

export interface ForeignKeyInfo {
  constraintName: string;
  sourceTable: string;
  sourceColumns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

// Sample Row

export type SampleRow = Record<string, unknown>;

// Hash Result

export interface HashResult {
  hash: string;
  rowCount: number;
  algorithm: 'md5' | 'sha256';
}

// Checkpoint

export interface DqvfCheckpoint {
  tableName: string;
  lastValidatedAt: Date;
  lastPkValue: string | null;
  chunkIndex: number;
  runId: string;
}
