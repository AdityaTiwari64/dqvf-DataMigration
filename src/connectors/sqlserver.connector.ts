/**
 * SQL Server database connector using Knex + tedious driver.
 * Implements all schema introspection, statistics, and hashing operations.
 */

import knex, { type Knex } from 'knex';
import { DatabaseConnector } from './base-connector.js';
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
import { createLogger } from '../utils/logger.js';

const log = createLogger('SqlServerConnector');

export class SqlServerConnector extends DatabaseConnector {
  readonly type = 'sqlserver';
  private db: Knex;

  constructor(connectionConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  }) {
    super();
    const connection = connectionConfig.connectionString
      ? connectionConfig.connectionString
      : {
          server: connectionConfig.host ?? 'localhost',
          port: connectionConfig.port ?? 1433,
          user: connectionConfig.user ?? 'sa',
          password: connectionConfig.password ?? '',
          database: connectionConfig.database ?? 'master',
          options: {
            encrypt: true,
            trustServerCertificate: true,
          },
        };

    this.db = knex({
      client: 'mssql',
      connection,
      pool: { min: 1, max: 10 },
    });
  }

  async testConnection(): Promise<void> {
    await this.db.raw('SELECT 1 AS result');
    log.info('SQL Server connection verified');
  }

  async getRowCount(table: string, schema = 'dbo'): Promise<number> {
    const result = await this.db.raw(
      `SELECT COUNT(*) AS [count] FROM [${schema}].[${table}]`
    );
    return result[0].count;
  }

  async getTableSchema(table: string, schema = 'dbo'): Promise<TableSchema> {
    const columns = await this.getColumns(table, schema);
    const constraints = await this.getConstraints(table, schema);
    const primaryKeyColumns = constraints
      .filter((c) => c.type === 'PRIMARY KEY')
      .flatMap((c) => c.columns);

    return { tableName: table, schemaName: schema, columns, constraints, primaryKeyColumns };
  }

  async getColumns(table: string, schema = 'dbo'): Promise<ColumnMetadata[]> {
    const result = await this.db.raw(
      `SELECT
        c.COLUMN_NAME AS column_name,
        c.DATA_TYPE AS data_type,
        c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
        c.NUMERIC_PRECISION AS numeric_precision,
        c.NUMERIC_SCALE AS numeric_scale,
        c.IS_NULLABLE AS is_nullable,
        c.ORDINAL_POSITION AS ordinal_position,
        c.COLUMN_DEFAULT AS column_default
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
      ORDER BY c.ORDINAL_POSITION`,
      [schema, table]
    );

    return result.map((row: Record<string, unknown>) => {
      const maxLen = row.character_maximum_length as number | null;
      const dataType = row.data_type as string;
      let fullType = dataType.toUpperCase();
      if (maxLen && maxLen > 0) fullType += `(${maxLen})`;
      else if (row.numeric_precision)
        fullType += `(${row.numeric_precision}${row.numeric_scale ? ',' + row.numeric_scale : ''})`;

      return {
        name: row.column_name as string,
        dataType,
        maxLength: maxLen,
        numericPrecision: row.numeric_precision as number | null,
        numericScale: row.numeric_scale as number | null,
        isNullable: (row.is_nullable as string) === 'YES',
        ordinalPosition: row.ordinal_position as number,
        columnDefault: row.column_default as string | null,
        fullType,
      };
    });
  }

  async getPrimaryKeys(table: string, schema = 'dbo'): Promise<string[]> {
    const result = await this.db.raw(
      `SELECT kcu.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         AND tc.TABLE_SCHEMA = ?
         AND tc.TABLE_NAME = ?
       ORDER BY kcu.ORDINAL_POSITION`,
      [schema, table]
    );
    return result.map((r: Record<string, unknown>) => r.column_name as string);
  }

  async getForeignKeys(table: string, schema = 'dbo'): Promise<ForeignKeyInfo[]> {
    const result = await this.db.raw(
      `SELECT
        fk.name AS constraint_name,
        COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS source_column,
        OBJECT_NAME(fkc.referenced_object_id) AS referenced_table,
        COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
       WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = ?
         AND OBJECT_NAME(fk.parent_object_id) = ?`,
      [schema, table]
    );

    const fkMap = new Map<string, ForeignKeyInfo>();
    for (const row of result as Record<string, unknown>[]) {
      const name = row.constraint_name as string;
      if (!fkMap.has(name)) {
        fkMap.set(name, {
          constraintName: name,
          sourceTable: table,
          sourceColumns: [],
          referencedTable: row.referenced_table as string,
          referencedColumns: [],
        });
      }
      const fk = fkMap.get(name)!;
      fk.sourceColumns.push(row.source_column as string);
      fk.referencedColumns.push(row.referenced_column as string);
    }

    return Array.from(fkMap.values());
  }

  async getConstraints(table: string, schema = 'dbo'): Promise<ConstraintInfo[]> {
    const result = await this.db.raw(
      `SELECT
        tc.CONSTRAINT_NAME AS constraint_name,
        tc.CONSTRAINT_TYPE AS constraint_type,
        kcu.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       WHERE tc.TABLE_SCHEMA = ?
         AND tc.TABLE_NAME = ?
       ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [schema, table]
    );

    const constraintMap = new Map<string, ConstraintInfo>();
    for (const row of result as Record<string, unknown>[]) {
      const name = row.constraint_name as string;
      if (!constraintMap.has(name)) {
        const rawType = row.constraint_type as string;
        let type: ConstraintInfo['type'] = 'CHECK';
        if (rawType === 'PRIMARY KEY') type = 'PRIMARY KEY';
        else if (rawType === 'FOREIGN KEY') type = 'FOREIGN KEY';
        else if (rawType === 'UNIQUE') type = 'UNIQUE';

        constraintMap.set(name, { name, type, columns: [] });
      }
      const col = row.column_name as string | null;
      if (col) constraintMap.get(name)!.columns.push(col);
    }

    // Detect NOT NULL constraints
    const cols = await this.db.raw(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND IS_NULLABLE = 'NO'`,
      [schema, table]
    );
    for (const row of cols as Record<string, unknown>[]) {
      const colName = row.COLUMN_NAME as string;
      constraintMap.set(`nn_${colName}`, {
        name: `nn_${colName}`,
        type: 'NOT NULL',
        columns: [colName],
      });
    }

    return Array.from(constraintMap.values());
  }

  async getColumnStats(table: string, column: string, schema = 'dbo'): Promise<ColumnStats> {
    const result = await this.db.raw(
      `SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN [${column}] IS NULL THEN 1 ELSE 0 END) AS null_count,
        COUNT(DISTINCT [${column}]) AS distinct_count,
        MIN(CAST([${column}] AS NVARCHAR(MAX))) AS min_val,
        MAX(CAST([${column}] AS NVARCHAR(MAX))) AS max_val,
        AVG(CAST([${column}] AS FLOAT)) AS mean_val,
        STDEV(CAST([${column}] AS FLOAT)) AS stddev_val,
        MIN(LEN(CAST([${column}] AS NVARCHAR(MAX)))) AS min_length,
        MAX(LEN(CAST([${column}] AS NVARCHAR(MAX)))) AS max_length,
        AVG(CAST(LEN(CAST([${column}] AS NVARCHAR(MAX))) AS FLOAT)) AS avg_length
       FROM [${schema}].[${table}]`
    );

    const row = result[0];
    return {
      columnName: column,
      totalCount: row.total_count,
      nullCount: row.null_count,
      distinctCount: row.distinct_count,
      min: row.min_val ?? undefined,
      max: row.max_val ?? undefined,
      mean: row.mean_val ?? undefined,
      stddev: row.stddev_val ?? undefined,
      minLength: row.min_length ?? undefined,
      maxLength: row.max_length ?? undefined,
      avgLength: row.avg_length ?? undefined,
    };
  }

  async getSampleRows(table: string, limit: number, schema = 'dbo'): Promise<SampleRow[]> {
    const result = await this.db.raw(
      `SELECT TOP (?) * FROM [${schema}].[${table}] ORDER BY NEWID()`,
      [limit]
    );
    return result;
  }

  async getColumnValues(
    table: string,
    column: string,
    limit: number,
    schema = 'dbo'
  ): Promise<unknown[]> {
    const result = await this.db.raw(
      `SELECT DISTINCT TOP (?) [${column}] AS val FROM [${schema}].[${table}] WHERE [${column}] IS NOT NULL`,
      [limit]
    );
    return result.map((r: Record<string, unknown>) => r.val);
  }

  async getValueFrequencies(
    table: string,
    column: string,
    topN: number,
    schema = 'dbo'
  ): Promise<Array<{ value: unknown; count: number }>> {
    const result = await this.db.raw(
      `SELECT TOP (?) [${column}] AS value, COUNT(*) AS [count]
       FROM [${schema}].[${table}]
       WHERE [${column}] IS NOT NULL
       GROUP BY [${column}]
       ORDER BY [count] DESC`,
      [topN]
    );
    return result;
  }

  async getTableHash(
    table: string,
    algorithm: 'md5' | 'sha256',
    schema = 'dbo'
  ): Promise<HashResult> {
    const hashAlg = algorithm === 'md5' ? 'MD5' : 'SHA2_256';
    const result = await this.db.raw(
      `SELECT
        CONVERT(VARCHAR(64), HASHBYTES('${hashAlg}',
          (SELECT STRING_AGG(CAST(row_hash AS NVARCHAR(MAX)), '') WITHIN GROUP (ORDER BY row_hash)
           FROM (
             SELECT CONVERT(VARCHAR(32), HASHBYTES('${hashAlg}',
               (SELECT CONCAT_WS('|', *) FROM [${schema}].[${table}] t2 WHERE t2.${table} = t.${table})
             ), 2) AS row_hash
             FROM [${schema}].[${table}] t
           ) sub)
        ), 2) AS table_hash,
        COUNT(*) AS row_count
       FROM [${schema}].[${table}]`
    );
    return {
      hash: result[0]?.table_hash ?? '',
      rowCount: result[0]?.row_count ?? 0,
      algorithm,
    };
  }

  async getChunkHash(
    table: string,
    pkColumn: string,
    offset: number,
    limit: number,
    algorithm: 'md5' | 'sha256',
    schema = 'dbo'
  ): Promise<HashResult> {
    const hashAlg = algorithm === 'md5' ? 'MD5' : 'SHA2_256';
    const result = await this.db.raw(
      `SELECT CONVERT(VARCHAR(64), HASHBYTES('${hashAlg}',
         STRING_AGG(CAST(row_hash AS NVARCHAR(MAX)), '') WITHIN GROUP (ORDER BY row_hash)
       ), 2) AS chunk_hash, COUNT(*) AS row_count
       FROM (
         SELECT CONVERT(VARCHAR(32), HASHBYTES('MD5', CONCAT_WS('|', *)), 2) AS row_hash
         FROM [${schema}].[${table}]
         ORDER BY [${pkColumn}]
         OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
       ) sub`,
      [offset, limit]
    );
    return {
      hash: result[0]?.chunk_hash ?? '',
      rowCount: result[0]?.row_count ?? 0,
      algorithm,
    };
  }

  async getPrimaryKeyValues(
    table: string,
    pkColumn: string,
    schema = 'dbo'
  ): Promise<string[]> {
    const result = await this.db.raw(
      `SELECT CAST([${pkColumn}] AS NVARCHAR(MAX)) AS pk_val FROM [${schema}].[${table}] ORDER BY [${pkColumn}]`
    );
    return result.map((r: Record<string, unknown>) => r.pk_val as string);
  }

  async findDuplicatePrimaryKeys(
    table: string,
    pkColumn: string,
    schema = 'dbo'
  ): Promise<Array<{ key: string; count: number }>> {
    const result = await this.db.raw(
      `SELECT TOP 100 CAST([${pkColumn}] AS NVARCHAR(MAX)) AS [key], COUNT(*) AS [count]
       FROM [${schema}].[${table}]
       GROUP BY [${pkColumn}]
       HAVING COUNT(*) > 1
       ORDER BY [count] DESC`
    );
    return result;
  }

  async findOrphanedForeignKeys(
    table: string,
    fk: ForeignKeyInfo,
    schema = 'dbo'
  ): Promise<number> {
    const sourceCol = fk.sourceColumns[0];
    const refCol = fk.referencedColumns[0];
    const result = await this.db.raw(
      `SELECT COUNT(*) AS orphan_count
       FROM [${schema}].[${table}] src
       LEFT JOIN [${schema}].[${fk.referencedTable}] ref
         ON src.[${sourceCol}] = ref.[${refCol}]
       WHERE ref.[${refCol}] IS NULL
         AND src.[${sourceCol}] IS NOT NULL`
    );
    return result[0].orphan_count;
  }

  async getMaxTimestamp(table: string, column: string, schema = 'dbo'): Promise<Date | null> {
    const result = await this.db.raw(
      `SELECT MAX([${column}]) AS max_ts FROM [${schema}].[${table}]`
    );
    const val = result[0]?.max_ts;
    return val ? new Date(val) : null;
  }

  async findTimestampAnomalies(
    table: string,
    column: string,
    schema = 'dbo'
  ): Promise<{ futureCount: number; nullCount: number }> {
    const result = await this.db.raw(
      `SELECT
        SUM(CASE WHEN [${column}] > GETUTCDATE() THEN 1 ELSE 0 END) AS future_count,
        SUM(CASE WHEN [${column}] IS NULL THEN 1 ELSE 0 END) AS null_count
       FROM [${schema}].[${table}]`
    );
    return {
      futureCount: result[0].future_count,
      nullCount: result[0].null_count,
    };
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.db.raw(sql, params);
    return result as T[];
  }

  async getTableDDL(table: string, schema = 'dbo'): Promise<string> {
    const columns = await this.getColumns(table, schema);
    const constraints = await this.getConstraints(table, schema);

    let ddl = `CREATE TABLE [${schema}].[${table}] (\n`;
    const colDefs = columns.map((col) => {
      let def = `  [${col.name}] ${col.fullType}`;
      if (!col.isNullable) def += ' NOT NULL';
      if (col.columnDefault) def += ` DEFAULT ${col.columnDefault}`;
      return def;
    });

    const pkConstraint = constraints.find((c) => c.type === 'PRIMARY KEY');
    if (pkConstraint) {
      colDefs.push(
        `  CONSTRAINT [${pkConstraint.name}] PRIMARY KEY (${pkConstraint.columns.map((c) => `[${c}]`).join(', ')})`
      );
    }

    ddl += colDefs.join(',\n');
    ddl += '\n);';
    return ddl;
  }

  // Checkpoint Management

  async ensureCheckpointTable(): Promise<void> {
    await this.db.raw(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '_dqvf_checkpoints')
      BEGIN
        CREATE TABLE _dqvf_checkpoints (
          table_name NVARCHAR(255) NOT NULL,
          run_id NVARCHAR(255) NOT NULL,
          last_validated_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
          last_pk_value NVARCHAR(MAX),
          chunk_index INT NOT NULL DEFAULT 0,
          PRIMARY KEY (table_name, run_id)
        )
      END
    `);
  }

  async getCheckpoint(table: string, runId: string): Promise<DqvfCheckpoint | null> {
    const result = await this.db.raw(
      `SELECT * FROM _dqvf_checkpoints WHERE table_name = ? AND run_id = ?`,
      [table, runId]
    );
    if (result.length === 0) return null;
    const row = result[0];
    return {
      tableName: row.table_name,
      lastValidatedAt: new Date(row.last_validated_at),
      lastPkValue: row.last_pk_value,
      chunkIndex: row.chunk_index,
      runId: row.run_id,
    };
  }

  async saveCheckpoint(checkpoint: DqvfCheckpoint): Promise<void> {
    await this.db.raw(
      `MERGE _dqvf_checkpoints AS target
       USING (SELECT ? AS table_name, ? AS run_id) AS source
       ON target.table_name = source.table_name AND target.run_id = source.run_id
       WHEN MATCHED THEN
         UPDATE SET last_validated_at = ?, last_pk_value = ?, chunk_index = ?
       WHEN NOT MATCHED THEN
         INSERT (table_name, run_id, last_validated_at, last_pk_value, chunk_index)
         VALUES (?, ?, ?, ?, ?);`,
      [
        checkpoint.tableName, checkpoint.runId,
        checkpoint.lastValidatedAt, checkpoint.lastPkValue, checkpoint.chunkIndex,
        checkpoint.tableName, checkpoint.runId,
        checkpoint.lastValidatedAt, checkpoint.lastPkValue, checkpoint.chunkIndex,
      ]
    );
  }

  async disconnect(): Promise<void> {
    await this.db.destroy();
    log.info('SQL Server connection closed');
  }
}
