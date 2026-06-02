/**
 * Agent interface and context types.
 */

import type { DatabaseConnector } from '../connectors/base-connector.js';
import type { LLMClient } from '../llm/client.js';
import type { RunConfig, TableConfig } from '../config/schema.js';
import type { AgentResult } from './report.js';

// Agent Context

export interface AgentContext {
  /** Source database connector */
  sourceDb: DatabaseConnector;
  /** Target database connector */
  targetDb: DatabaseConnector;
  /** Parsed and validated run configuration */
  config: RunConfig;
  /** LLM client (may be null if no API key configured) */
  llm: LLMClient | null;
}

// Validation Agent Interface

export interface IValidationAgent {
  /** Unique agent name matching AgentName type */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;

  /**
   * Run validation against all configured tables.
   * @returns Aggregated agent result
   */
  run(ctx: AgentContext): Promise<AgentResult>;

  /**
   * Run validation against a single table (debugging mode).
   * @param ctx Agent context
   * @param table Table configuration to validate
   * @returns Agent result for that single table
   */
  runSingle(ctx: AgentContext, table: TableConfig): Promise<AgentResult>;
}
