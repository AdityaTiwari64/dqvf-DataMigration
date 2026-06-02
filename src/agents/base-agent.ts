import type { IValidationAgent, AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { AgentResult, RuleCheckResult } from '../types/report.js';
import { aggregateRuleResults, createSkippedAgentResult } from '../types/report.js';
import { createLogger, type Logger } from '../utils/logger.js';

export abstract class BaseAgent implements IValidationAgent {
  abstract readonly name: string;
  abstract readonly description: string;
  protected log: Logger;

  constructor() {
    // Logger will be properly initialized in subclass constructors
    this.log = createLogger('BaseAgent');
  }

  /**
   * Run validation against all configured tables.
   */
  async run(ctx: AgentContext): Promise<AgentResult> {
    this.log.info(`Starting ${this.name} agent`);
    const startTime = Date.now();

    try {
      const allResults: RuleCheckResult[] = [];

      for (const table of ctx.config.tables) {
        this.log.info(`Validating table: ${table.name}`);
        try {
          const tableResults = await this.validateTable(ctx, table);
          allResults.push(...tableResults);

          const failures = tableResults.filter((r) => r.status === 'FAIL');
          if (failures.length > 0) {
            this.log.warn(`${failures.length} failures in table ${table.name}`, {
              rules: failures.map((f) => f.rule),
            });
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.log.error(`Error validating table ${table.name}`, { error: errMsg });
          allResults.push({
            rule: 'agent_execution',
            status: 'FAIL',
            severity: 'HIGH',
            table: table.name,
            detail: `Agent error: ${errMsg}`,
            remediation: 'Check agent logs for details and retry',
          });
        }
      }

      const result = aggregateRuleResults(allResults);
      result.durationMs = Date.now() - startTime;

      this.log.info(`${this.name} agent completed`, {
        status: result.status,
        rulesChecked: result.rulesChecked,
        rulesFailed: result.rulesFailed,
        durationMs: result.durationMs,
      });

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`Fatal error in ${this.name} agent`, { error: errMsg });
      const result = createSkippedAgentResult(`Agent error: ${errMsg}`);
      result.durationMs = Date.now() - startTime;
      return result;
    }
  }

  /**
   * Run validation against a single table (debugging/CLI mode).
   */
  async runSingle(ctx: AgentContext, table: TableConfig): Promise<AgentResult> {
    this.log.info(`Running ${this.name} on single table: ${table.name}`);
    const startTime = Date.now();

    try {
      const results = await this.validateTable(ctx, table);
      const agentResult = aggregateRuleResults(results);
      agentResult.durationMs = Date.now() - startTime;
      return agentResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`Error in single-table validation for ${table.name}`, { error: errMsg });
      const result = createSkippedAgentResult(`Agent error: ${errMsg}`);
      result.durationMs = Date.now() - startTime;
      return result;
    }
  }

  /**
   * Validate a single table. Must be implemented by each agent.
   */
  protected abstract validateTable(
    ctx: AgentContext,
    table: TableConfig
  ): Promise<RuleCheckResult[]>;

  /**
   * Helper to create a PASS result.
   */
  protected pass(rule: string, table: string, detail: string, column?: string): RuleCheckResult {
    return { rule, status: 'PASS', severity: 'HIGH', table, column, detail };
  }

  /**
   * Helper to create a FAIL result.
   */
  protected fail(
    rule: string,
    table: string,
    detail: string,
    severity: RuleCheckResult['severity'] = 'HIGH',
    remediation?: string,
    column?: string,
    metadata?: Record<string, unknown>
  ): RuleCheckResult {
    return { rule, status: 'FAIL', severity, table, column, detail, remediation, metadata };
  }

  /**
   * Helper to create a WARN result.
   */
  protected warn(
    rule: string,
    table: string,
    detail: string,
    severity: RuleCheckResult['severity'] = 'MEDIUM',
    column?: string
  ): RuleCheckResult {
    return { rule, status: 'WARN', severity, table, column, detail };
  }

  /**
   * Helper to create a SKIPPED result.
   */
  protected skip(rule: string, table: string, detail: string, column?: string): RuleCheckResult {
    return { rule, status: 'SKIPPED', severity: 'MEDIUM', table, column, detail };
  }

  /**
   * Timed execution wrapper for individual rules.
   */
  protected async timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
    const start = Date.now();
    const result = await fn();
    return { result, durationMs: Date.now() - start };
  }
}
