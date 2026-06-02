/**
 * PostgreSQL database connector using Knex + pg driver.
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

const log = createLogger('PostgresConnector');

export class PostgresConnector extends DatabaseConnector {
  readonly type = 'postgresql';
  private db: Knex;

  constructor(connectionConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: boolean;
  }) {
    super();
    const connection = connectionConfig.connectionString
      ? { connectionString: connectionConfig.connectionString }
      : {
          host: connectionConfig.host ?? 'localhost',
          port: connectionConfig.port ?? 5432,
          user: connectionConfig.user ?? 'postgres',
          password: connectionConfig.password ?? '',
          database: connectionConfig.database ?? 'postgres',
          ssl: connectionConfig.ssl ? { rejectUnauthorized: false } : undefined,
        };

    this.db = knex({
      client: 'pg',
      connection,
      pool: { min: 1, max: 10 },
    });
  }

  async testConnection(): Promise<void> {
    await this.db.raw('SELECT 1');
    log.info('PostgreSQL connection verified');
  }

  async getRowCount(table: string, schema = 'public'): Promise<number> {
    const result = await this.db.raw(
      `SELECT COUNT(*)::int AS count FROM "${schema}"."${table}"`
    );
    return result.rows[0].count;
  }

  async getTableSchema(table: string, schema = 'public'): Promise<TableSchema> {
    const columns = await this.getColumns(table, schema);
    const constraints = await this.getConstraints(table, schema);
    const primaryKeyColumns = constraints
      .filter((c) => c.type === 'PRIMARY KEY')
      .flatMap((c) => c.columns);

    return { tableName: table, schemaName: schema, columns, constraints, primaryKeyColumns };
  }

  async getColumns(table: string, schema = 'public'): Promise<ColumnMetadata[]> {
    const result = await this.db.raw(
      `SELECT
        column_name,
        data_type,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_nullable,
        ordinal_position,
        column_default,
        udt_name
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`,
      [schema, table]
    );

    return result.rows.map((row: Record<string, unknown>) => {
      const maxLen = row.character_maximum_length as number | null;
      const dataType = row.data_type as string;
      let fullType = dataType.toUpperCase();
      if (maxLen) fullType += `(${maxLen})`;
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

  async getPrimaryKeys(table: string, schema = 'public'): Promise<string[]> {
    const result = await this.db.raw(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = ?
         AND tc.table_name = ?
       ORDER BY kcu.ordinal_position`,
      [schema, table]
    );
    return result.rows.map((r: Record<string, unknown>) => r.column_name as string);
  }

  async getForeignKeys(table: string, schema = 'public'): Promise<ForeignKeyInfo[]> {
    const result = await this.db.raw(
      `SELECT
        tc.constraint_name,
        kcu.column_name AS source_column,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = ?
         AND tc.table_name = ?`,
      [schema, table]
    );

    // Group by constraint name
    const fkMap = new Map<string, ForeignKeyInfo>();
    for (const row of result.rows as Record<string, unknown>[]) {
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

  async getConstraints(table: string, schema = 'public'): Promise<ConstraintInfo[]> {
    const result = await this.db.raw(
      `SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        cc.check_clause
       FROM information_schema.table_constraints tc
       LEFT JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       LEFT JOIN information_schema.check_constraints cc
         ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
       WHERE tc.table_schema = ?
         AND tc.table_name = ?
       ORDER BY tc.constraint_name, kcu.ordinal_position`,
      [schema, table]
    );

    const constraintMap = new Map<string, ConstraintInfo>();
    for (const row of result.rows as Record<string, unknown>[]) {
      const name = row.constraint_name as string;
      if (!constraintMap.has(name)) {
        const rawType = row.constraint_type as string;
        let type: ConstraintInfo['type'] = 'CHECK';
        if (rawType === 'PRIMARY KEY') type = 'PRIMARY KEY';
        else if (rawType === 'FOREIGN KEY') type = 'FOREIGN KEY';
        else if (rawType === 'UNIQUE') type = 'UNIQUE';
        else if (rawType === 'CHECK') type = 'CHECK';

        constraintMap.set(name, {
          name,
          type,
          columns: [],
          checkExpression: row.check_clause as string | undefined,
        });
      }
      const col = row.column_name as string | null;
      if (col) constraintMap.get(name)!.columns.push(col);
    }

    // Also detect NOT NULL constraints from column info
    const cols = await this.db.raw(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND is_nullable = 'NO'`,
      [schema, table]
    );
    for (const row of cols.rows as Record<string, unknown>[]) {
      const colName = row.column_name as string;
      constraintMap.set(`nn_${colName}`, {
        name: `nn_${colName}`,
        type: 'NOT NULL',
        columns: [colName],
      });
    }

    return Array.from(constraintMap.values());
  }

  async getColumnStats(table: string, column: string, schema = 'public'): Promise<ColumnStats> {
    const result = await this.db.raw(
      `SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE "${column}" IS NULL)::int AS null_count,
        COUNT(DISTINCT "${column}")::int AS distinct_count,
        MIN("${column}")::text AS min_val,
        MAX("${column}")::text AS max_val,
        AVG("${column}"::numeric)::float AS mean_val,
        STDDEV("${column}"::numeric)::float AS stddev_val,
        MIN(LENGTH("${column}"::text))::int AS min_length,
        MAX(LENGTH("${column}"::text))::int AS max_length,
        AVG(LENGTH("${column}"::text))::float AS avg_length
       FROM "${schema}"."${table}"`
    );

    const row = result.rows[0];
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

  async getSampleRows(table: string, limit: number, schema = 'public'): Promise<SampleRow[]> {
    const result = await this.db.raw(
      `SELECT * FROM "${schema}"."${table}" TABLESAMPLE SYSTEM(1) LIMIT ?`,
      [limit]
    );
    // Fallback if TABLESAMPLE returns nothing
    if (result.rows.length === 0) {
      const fallback = await this.db.raw(
        `SELECT * FROM "${schema}"."${table}" LIMIT ?`,
        [limit]
      );
      return fallback.rows;
    }
    return result.rows;
  }

  async getColumnValues(
    table: string,
    column: string,
    limit: number,
    schema = 'public'
  ): Promise<unknown[]> {
    const result = await this.db.raw(
      `SELECT DISTINCT "${column}" AS val FROM "${schema}"."${table}" WHERE "${column}" IS NOT NULL LIMIT ?`,
      [limit]
    );
    return result.rows.map((r: Record<string, unknown>) => r.val);
  }

  async getValueFrequencies(
    table: string,
    column: string,
    topN: number,
    schema = 'public'
  ): Promise<Array<{ value: unknown; count: number }>> {
    const result = await this.db.raw(
      `SELECT "${column}" AS value, COUNT(*)::int AS count
       FROM "${schema}"."${table}"
       WHERE "${column}" IS NOT NULL
       GROUP BY "${column}"
       ORDER BY count DESC
       LIMIT ?`,
      [topN]
    );
    return result.rows;
  }

  async getTableHash(
    table: string,
    algorithm: 'md5' | 'sha256',
    schema = 'public'
  ): Promise<HashResult> {
    // Use MD5 aggregation over all rows
    const hashFunc = algorithm === 'md5' ? 'md5' : 'encode(digest(x, \'sha256\'), \'hex\')';
    const result = await this.db.raw(
      `SELECT md5(string_agg(row_hash, '' ORDER BY row_hash)) AS table_hash, COUNT(*)::int AS row_count
       FROM (
         SELECT md5(${table}::text) AS row_hash
         FROM "${schema}"."${table}"
       ) sub`
    );
    return {
      hash: result.rows[0].table_hash ?? '',
      rowCount: result.rows[0].row_count,
      algorithm,
    };
  }

  async getChunkHash(
    table: string,
    pkColumn: string,
    offset: number,
    limit: number,
    algorithm: 'md5' | 'sha256',
    schema = 'public'
  ): Promise<HashResult> {
    const result = await this.db.raw(
      `SELECT md5(string_agg(row_hash, '' ORDER BY row_hash)) AS chunk_hash, COUNT(*)::int AS row_count
       FROM (
         SELECT md5("${table}"::text) AS row_hash
         FROM "${schema}"."${table}"
         ORDER BY "${pkColumn}"
         OFFSET ? LIMIT ?
       ) sub`,
      [offset, limit]
    );
    return {
      hash: result.rows[0].chunk_hash ?? '',
      rowCount: result.rows[0].row_count,
      algorithm,
    };
  }

  async getPrimaryKeyValues(
    table: string,
    pkColumn: string,
    schema = 'public'
  ): Promise<string[]> {
    const result = await this.db.raw(
      `SELECT "${pkColumn}"::text AS pk_val FROM "${schema}"."${table}" ORDER BY "${pkColumn}"`,
    );
    return result.rows.map((r: Record<string, unknown>) => r.pk_val as string);
  }

  async findDuplicatePrimaryKeys(
    table: string,
    pkColumn: string,
    schema = 'public'
  ): Promise<Array<{ key: string; count: number }>> {
    const result = await this.db.raw(
      `SELECT "${pkColumn}"::text AS key, COUNT(*)::int AS count
       FROM "${schema}"."${table}"
       GROUP BY "${pkColumn}"
       HAVING COUNT(*) > 1
       ORDER BY count DESC
       LIMIT 100`,
      []
    );
    return result.rows;
  }

  async findOrphanedForeignKeys(
    table: string,
    fk: ForeignKeyInfo,
    schema = 'public'
  ): Promise<number> {
    const sourceCol = fk.sourceColumns[0];
    const refCol = fk.referencedColumns[0];
    const result = await this.db.raw(
      `SELECT COUNT(*)::int AS orphan_count
       FROM "${schema}"."${table}" src
       LEFT JOIN "${schema}"."${fk.referencedTable}" ref
         ON src."${sourceCol}" = ref."${refCol}"
       WHERE ref."${refCol}" IS NULL
         AND src."${sourceCol}" IS NOT NULL`,
    );
    return result.rows[0].orphan_count;
  }

  async getMaxTimestamp(table: string, column: string, schema = 'public'): Promise<Date | null> {
    const result = await this.db.raw(
      `SELECT MAX("${column}") AS max_ts FROM "${schema}"."${table}"`
    );
    const val = result.rows[0]?.max_ts;
    return val ? new Date(val) : null;
  }

  async findTimestampAnomalies(
    table: string,
    column: string,
    schema = 'public'
  ): Promise<{ futureCount: number; nullCount: number }> {
    const result = await this.db.raw(
      `SELECT
        COUNT(*) FILTER (WHERE "${column}" > NOW())::int AS future_count,
        COUNT(*) FILTER (WHERE "${column}" IS NULL)::int AS null_count
       FROM "${schema}"."${table}"`
    );
    return {
      futureCount: result.rows[0].future_count,
      nullCount: result.rows[0].null_count,
    };
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.db.raw(sql, params);
    return result.rows as T[];
  }

  async getTableDDL(table: string, schema = 'public'): Promise<string> {
    // Build a synthetic DDL from information_schema
    const columns = await this.getColumns(table, schema);
    const constraints = await this.getConstraints(table, schema);

    let ddl = `CREATE TABLE "${schema}"."${table}" (\n`;
    const colDefs = columns.map((col) => {
      let def = `  "${col.name}" ${col.fullType}`;
      if (!col.isNullable) def += ' NOT NULL';
      if (col.columnDefault) def += ` DEFAULT ${col.columnDefault}`;
      return def;
    });

    const pkConstraint = constraints.find((c) => c.type === 'PRIMARY KEY');
    if (pkConstraint) {
      colDefs.push(`  PRIMARY KEY (${pkConstraint.columns.map((c) => `"${c}"`).join(', ')})`);
    }

    ddl += colDefs.join(',\n');
    ddl += '\n);';
    return ddl;
  }

  // Checkpoint Management

  async ensureCheckpointTable(): Promise<void> {
    await this.db.raw(`
      CREATE TABLE IF NOT EXISTS _dqvf_checkpoints (
        table_name TEXT NOT NULL,
        run_id TEXT NOT NULL,
        last_validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_pk_value TEXT,
        chunk_index INT NOT NULL DEFAULT 0,
        PRIMARY KEY (table_name, run_id)
      )
    `);
  }

  async getCheckpoint(table: string, runId: string): Promise<DqvfCheckpoint | null> {
    const result = await this.db.raw(
      `SELECT * FROM _dqvf_checkpoints WHERE table_name = ? AND run_id = ?`,
      [table, runId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
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
      `INSERT INTO _dqvf_checkpoints (table_name, run_id, last_validated_at, last_pk_value, chunk_index)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_name, run_id)
       DO UPDATE SET last_validated_at = EXCLUDED.last_validated_at,
                     last_pk_value = EXCLUDED.last_pk_value,
                     chunk_index = EXCLUDED.chunk_index`,
      [
        checkpoint.tableName,
        checkpoint.runId,
        checkpoint.lastValidatedAt,
        checkpoint.lastPkValue,
        checkpoint.chunkIndex,
      ]
    );
  }

  async disconnect(): Promise<void> {
    await this.db.destroy();
    log.info('PostgreSQL connection closed');
  }
}
