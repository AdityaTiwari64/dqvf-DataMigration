/**
 * MongoDB connector for document-source migration validation.
 *
 * Collections are treated as tables and top-level document fields are treated as columns.
 */

import crypto from 'node:crypto';
import { MongoClient, type Collection, type Db, type Document, type Filter } from 'mongodb';
import { DatabaseConnector } from './base-connector.js';
import type {
  ColumnMetadata,
  ColumnStats,
  ConstraintInfo,
  DqvfCheckpoint,
  ForeignKeyInfo,
  HashResult,
  SampleRow,
  TableSchema,
} from '../types/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MongoDbConnector');

function encodeCredential(value = ''): string {
  return encodeURIComponent(value);
}

function bsonToPlain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && '_bsontype' in value && typeof value.toString === 'function') {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(bsonToPlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, bsonToPlain(entry)])
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  const plain = bsonToPlain(value);
  if (plain === null || typeof plain !== 'object') return JSON.stringify(plain);
  if (Array.isArray(plain)) return `[${plain.map(stableStringify).join(',')}]`;
  const entries = Object.entries(plain as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

function inferType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function normalizeFieldValue(value: unknown): unknown {
  if (value && typeof value === 'object' && '_bsontype' in value && typeof value.toString === 'function') {
    return value.toString();
  }
  return value;
}

export class MongoDbConnector extends DatabaseConnector {
  readonly type = 'mongodb';
  private client: MongoClient;
  private databaseName: string;
  private connected = false;

  constructor(connectionConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  }) {
    super();
    this.databaseName = connectionConfig.database ?? 'admin';

    const uri = connectionConfig.connectionString
      ? connectionConfig.connectionString
      : this.buildConnectionString(connectionConfig);

    this.client = new MongoClient(uri);
  }

  private buildConnectionString(connectionConfig: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  }): string {
    const host = connectionConfig.host ?? 'localhost';
    const port = connectionConfig.port ?? 27017;
    const auth =
      connectionConfig.user && connectionConfig.password !== undefined
        ? `${encodeCredential(connectionConfig.user)}:${encodeCredential(connectionConfig.password)}@`
        : '';
    return `mongodb://${auth}${host}:${port}/${connectionConfig.database ?? this.databaseName}`;
  }

  private async db(): Promise<Db> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    return this.client.db(this.databaseName);
  }

  private async collection(table: string): Promise<Collection<Document>> {
    return (await this.db()).collection(table);
  }

  async testConnection(): Promise<void> {
    await (await this.db()).command({ ping: 1 });
    log.info('MongoDB connection verified');
  }

  async getRowCount(table: string): Promise<number> {
    return (await this.collection(table)).countDocuments();
  }

  async getTableSchema(table: string): Promise<TableSchema> {
    const columns = await this.getColumns(table);
    const constraints = await this.getConstraints();
    return {
      tableName: table,
      schemaName: this.databaseName,
      columns,
      constraints,
      primaryKeyColumns: ['_id'],
    };
  }

  async getColumns(table: string): Promise<ColumnMetadata[]> {
    const docs = await (await this.collection(table)).find({}).limit(100).toArray();
    const fields = new Map<string, { types: Set<string>; nullable: boolean; maxLength: number | null }>();

    for (const doc of docs) {
      const keys = new Set(Object.keys(doc));
      for (const key of fields.keys()) {
        if (!keys.has(key)) fields.get(key)!.nullable = true;
      }

      for (const [key, value] of Object.entries(doc)) {
        const entry = fields.get(key) ?? { types: new Set<string>(), nullable: false, maxLength: null };
        const valueType = inferType(value);
        entry.types.add(valueType);
        if (value === null || value === undefined) entry.nullable = true;
        if (typeof value === 'string') {
          entry.maxLength = Math.max(entry.maxLength ?? 0, value.length);
        }
        fields.set(key, entry);
      }
    }

    return Array.from(fields.entries()).map(([name, entry], index) => {
      const dataType = Array.from(entry.types).filter((type) => type !== 'null').join('|') || 'unknown';
      return {
        name,
        dataType,
        maxLength: entry.maxLength,
        numericPrecision: null,
        numericScale: null,
        isNullable: entry.nullable,
        ordinalPosition: index + 1,
        columnDefault: null,
        fullType: dataType.toUpperCase(),
      };
    });
  }

  async getPrimaryKeys(): Promise<string[]> {
    return ['_id'];
  }

  async getForeignKeys(): Promise<ForeignKeyInfo[]> {
    return [];
  }

  async getConstraints(): Promise<ConstraintInfo[]> {
    return [{ name: 'pk__id', type: 'PRIMARY KEY', columns: ['_id'] }];
  }

  async getColumnStats(table: string, column: string): Promise<ColumnStats> {
    const collection = await this.collection(table);
    const totalCount = await collection.countDocuments();
    const nullCount = await collection.countDocuments({
      $or: [{ [column]: null }, { [column]: { $exists: false } }],
    } as Filter<Document>);
    const distinctValues = await collection.distinct(column, { [column]: { $ne: null } });
    const sampleValues = await collection
      .find({ [column]: { $ne: null } } as Filter<Document>, { projection: { [column]: 1 } })
      .limit(10000)
      .toArray();
    const values = sampleValues.map((doc) => normalizeFieldValue(doc[column])).filter((value) => value !== undefined);
    const numericValues = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const stringLengths = values.map((value) => String(value).length);

    const mean =
      numericValues.length > 0
        ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
        : undefined;
    const stddev =
      mean !== undefined && numericValues.length > 1
        ? Math.sqrt(numericValues.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (numericValues.length - 1))
        : undefined;

    return {
      columnName: column,
      totalCount,
      nullCount,
      distinctCount: distinctValues.length,
      min: values.length > 0 ? String([...values].sort()[0]) : undefined,
      max: values.length > 0 ? String([...values].sort().at(-1)) : undefined,
      mean,
      stddev,
      minLength: stringLengths.length > 0 ? Math.min(...stringLengths) : undefined,
      maxLength: stringLengths.length > 0 ? Math.max(...stringLengths) : undefined,
      avgLength:
        stringLengths.length > 0
          ? stringLengths.reduce((sum, length) => sum + length, 0) / stringLengths.length
          : undefined,
    };
  }

  async getSampleRows(table: string, limit: number): Promise<SampleRow[]> {
    const docs = await (await this.collection(table)).aggregate([{ $sample: { size: limit } }]).toArray();
    return docs.map((doc) => bsonToPlain(doc) as SampleRow);
  }

  async getColumnValues(table: string, column: string, limit: number): Promise<unknown[]> {
    const values = await (await this.collection(table)).distinct(column, { [column]: { $ne: null } });
    return values.slice(0, limit).map(normalizeFieldValue);
  }

  async getValueFrequencies(
    table: string,
    column: string,
    topN: number
  ): Promise<Array<{ value: unknown; count: number }>> {
    const results = await (await this.collection(table))
      .aggregate([
        { $match: { [column]: { $ne: null } } },
        { $group: { _id: `$${column}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: topN },
      ])
      .toArray();

    return results.map((row) => ({ value: normalizeFieldValue(row._id), count: row.count as number }));
  }

  async getTableHash(table: string, algorithm: 'md5' | 'sha256'): Promise<HashResult> {
    const rowHashes: string[] = [];
    const cursor = (await this.collection(table)).find({}).sort({ _id: 1 });
    for await (const doc of cursor) {
      rowHashes.push(crypto.createHash(algorithm).update(stableStringify(doc)).digest('hex'));
    }

    rowHashes.sort();
    return {
      hash: crypto.createHash(algorithm).update(rowHashes.join('')).digest('hex'),
      rowCount: rowHashes.length,
      algorithm,
    };
  }

  async getChunkHash(
    table: string,
    pkColumn: string,
    offset: number,
    limit: number,
    algorithm: 'md5' | 'sha256'
  ): Promise<HashResult> {
    const rowHashes: string[] = [];
    const cursor = (await this.collection(table)).find({}).sort({ [pkColumn]: 1 }).skip(offset).limit(limit);
    for await (const doc of cursor) {
      rowHashes.push(crypto.createHash(algorithm).update(stableStringify(doc)).digest('hex'));
    }

    rowHashes.sort();
    return {
      hash: crypto.createHash(algorithm).update(rowHashes.join('')).digest('hex'),
      rowCount: rowHashes.length,
      algorithm,
    };
  }

  async getPrimaryKeyValues(table: string, pkColumn: string): Promise<string[]> {
    const docs = await (await this.collection(table))
      .find({}, { projection: { [pkColumn]: 1 } })
      .sort({ [pkColumn]: 1 })
      .toArray();
    return docs.map((doc) => String(normalizeFieldValue(doc[pkColumn])));
  }

  async findDuplicatePrimaryKeys(table: string, pkColumn: string): Promise<Array<{ key: string; count: number }>> {
    const results = await (await this.collection(table))
      .aggregate([
        { $group: { _id: `$${pkColumn}`, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ])
      .toArray();
    return results.map((row) => ({ key: String(normalizeFieldValue(row._id)), count: row.count as number }));
  }

  async findOrphanedForeignKeys(): Promise<number> {
    return 0;
  }

  async getMaxTimestamp(table: string, column: string): Promise<Date | null> {
    const doc = await (await this.collection(table)).find({ [column]: { $ne: null } }).sort({ [column]: -1 }).limit(1).next();
    const value = doc?.[column];
    return value ? new Date(value as string | number | Date) : null;
  }

  async findTimestampAnomalies(table: string, column: string): Promise<{ futureCount: number; nullCount: number }> {
    const collection = await this.collection(table);
    const now = new Date();
    const futureCount = await collection.countDocuments({ [column]: { $gt: now } });
    const nullCount = await collection.countDocuments({
      $or: [{ [column]: null }, { [column]: { $exists: false } }],
    } as Filter<Document>);
    return { futureCount, nullCount };
  }

  async executeRaw<T = Record<string, unknown>>(commandText: string): Promise<T[]> {
    const db = await this.db();
    const trimmed = commandText.trim();
    const sqlResult = await this.tryExecuteSimpleSqlAggregate<T>(trimmed);
    if (sqlResult) return sqlResult;

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        throw new Error('MongoDB aggregate JSON arrays require a collection and are not supported by executeRaw');
      }
      const result = await db.command(parsed);
      return [bsonToPlain(result) as T];
    } catch (error) {
      throw new Error(
        `MongoDB executeRaw expects a JSON database command. Received unsupported expression: ${trimmed.slice(0, 80)}`
      );
    }
  }

  private async tryExecuteSimpleSqlAggregate<T>(expression: string): Promise<T[] | null> {
    const normalized = expression.replace(/\s+/g, ' ');
    const countMatch = normalized.match(/^SELECT COUNT\(\*\) AS ([a-zA-Z_][\w]*) FROM ([a-zA-Z_][\w]*)$/i);
    if (countMatch) {
      const [, alias, table] = countMatch;
      return [{ [alias]: await this.getRowCount(table) } as T];
    }

    const sumMatch = normalized.match(
      /^SELECT SUM\(([a-zA-Z_][\w]*)\) AS ([a-zA-Z_][\w]*) FROM ([a-zA-Z_][\w]*)$/i
    );
    if (sumMatch) {
      const [, column, alias, table] = sumMatch;
      const [row] = await (await this.collection(table))
        .aggregate([{ $group: { _id: null, value: { $sum: `$${column}` } } }])
        .toArray();
      return [{ [alias]: row?.value ?? null } as T];
    }

    const avgMatch = normalized.match(
      /^SELECT ROUND\(AVG\(([a-zA-Z_][\w]*)\)(?:::numeric)?,\s*(\d+)\) AS ([a-zA-Z_][\w]*) FROM ([a-zA-Z_][\w]*)$/i
    );
    if (avgMatch) {
      const [, column, decimalsText, alias, table] = avgMatch;
      const [row] = await (await this.collection(table))
        .aggregate([{ $group: { _id: null, value: { $avg: `$${column}` } } }])
        .toArray();
      const decimals = Number(decimalsText);
      const value = typeof row?.value === 'number' ? Number(row.value.toFixed(decimals)) : null;
      return [{ [alias]: value } as T];
    }

    const activeRatioMatch = normalized.match(
      /^SELECT ROUND\(COUNT\(\*\) FILTER \(WHERE ([a-zA-Z_][\w]*) = '([^']+)'\)(?:::numeric)? \/ COUNT\(\*\)(?:::numeric)? \* 100,\s*(\d+)\) AS ([a-zA-Z_][\w]*) FROM ([a-zA-Z_][\w]*)$/i
    );
    if (activeRatioMatch) {
      const [, column, expectedValue, decimalsText, alias, table] = activeRatioMatch;
      const collection = await this.collection(table);
      const total = await collection.countDocuments();
      const matching = await collection.countDocuments({ [column]: expectedValue });
      const decimals = Number(decimalsText);
      const ratio = total > 0 ? Number(((matching / total) * 100).toFixed(decimals)) : null;
      return [{ [alias]: ratio } as T];
    }

    return null;
  }

  async getTableDDL(table: string): Promise<string> {
    const columns = await this.getColumns(table);
    const lines = columns.map((column) => `  ${column.name}: ${column.fullType}`);
    return `MongoDB collection ${this.databaseName}.${table} {\n${lines.join('\n')}\n}`;
  }

  async ensureCheckpointTable(): Promise<void> {
    await (await this.db()).createCollection('_dqvf_checkpoints').catch((error: Error & { codeName?: string }) => {
      if (error.codeName !== 'NamespaceExists') throw error;
    });
  }

  async getCheckpoint(table: string, runId: string): Promise<DqvfCheckpoint | null> {
    const doc = await (await this.collection('_dqvf_checkpoints')).findOne({ tableName: table, runId });
    if (!doc) return null;
    return {
      tableName: doc.tableName as string,
      lastValidatedAt: new Date(doc.lastValidatedAt as string | Date),
      lastPkValue: (doc.lastPkValue as string | null) ?? null,
      chunkIndex: (doc.chunkIndex as number) ?? 0,
      runId: doc.runId as string,
    };
  }

  async saveCheckpoint(checkpoint: DqvfCheckpoint): Promise<void> {
    await (await this.collection('_dqvf_checkpoints')).updateOne(
      { tableName: checkpoint.tableName, runId: checkpoint.runId },
      { $set: checkpoint },
      { upsert: true }
    );
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    this.connected = false;
    log.info('MongoDB connection closed');
  }
}
