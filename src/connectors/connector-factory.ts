/**
 * Factory to create DatabaseConnector instances from configuration.
 */

import type { ConnectionConfig } from '../config/schema.js';
import type { DatabaseConnector } from './base-connector.js';
import { PostgresConnector } from './postgres.connector.js';
import { SqlServerConnector } from './sqlserver.connector.js';
import { MongoDbConnector } from './mongodb.connector.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ConnectorFactory');

/**
 * Parse a connection string into its components.
 * Supports formats:
 *   postgresql://user:pass@host:port/db
 *   mongodb://user:pass@host:port/db
 *   mongodb+srv://user:pass@host/db
 *   mssql+pyodbc://user:pass@host/db
 *   mssql://user:pass@host:port/db
 */
function parseConnectionString(connStr: string): {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
} {
  try {
    // Normalize mssql+pyodbc:// → mssql://
    const normalized = connStr
      .replace('mssql+pyodbc://', 'http://')
      .replace('mssql://', 'http://')
      .replace('postgresql://', 'http://')
      .replace('postgres://', 'http://')
      .replace('mongodb+srv://', 'http://')
      .replace('mongodb://', 'http://');
    const url = new URL(normalized);
    return {
      host: url.hostname || undefined,
      port: url.port ? parseInt(url.port, 10) : undefined,
      user: url.username || undefined,
      password: url.password || undefined,
      database: url.pathname.replace('/', '') || undefined,
    };
  } catch {
    log.warn('Failed to parse connection string, using as-is');
    return {};
  }
}

/**
 * Create a DatabaseConnector from a ConnectionConfig.
 */
export function createConnector(config: ConnectionConfig): DatabaseConnector {
  const parsed = config.connection_string
    ? parseConnectionString(config.connection_string)
    : {};

  const connConfig = {
    connectionString: config.connection_string,
    host: config.host ?? parsed.host,
    port: config.port ?? parsed.port,
    user: config.user ?? parsed.user,
    password: config.password ?? parsed.password,
    database: config.database ?? parsed.database,
    ssl: config.ssl,
  };

  switch (config.type) {
    case 'postgresql':
    case 'neon':
      log.info('Creating PostgreSQL connector', { host: connConfig.host, database: connConfig.database });
      return new PostgresConnector(connConfig);

    case 'mongodb':
      log.info('Creating MongoDB connector', { host: connConfig.host, database: connConfig.database });
      return new MongoDbConnector(connConfig);

    case 'sqlserver':
      log.info('Creating SQL Server connector', { host: connConfig.host, database: connConfig.database });
      return new SqlServerConnector(connConfig);

    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}
