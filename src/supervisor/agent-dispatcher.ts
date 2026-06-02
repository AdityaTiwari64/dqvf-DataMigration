import type { AgentContext } from '../types/agent.js';
import type { AgentName, AgentResult } from '../types/report.js';
import { createSkippedAgentResult } from '../types/report.js';
import type { ExecutionPlan, ExecutionStage } from './execution-plan.js';
import type { ParsedIntent } from './intent-parser.js';

import { TableProfilingAgent } from '../agents/table-profiling.agent.js';
import { ColumnProfilingAgent } from '../agents/column-profiling.agent.js';
import { PatternAnalysisAgent } from '../agents/pattern-analysis.agent.js';
import { ReconciliationAgent } from '../agents/reconciliation.agent.js';
import { SemanticValidationAgent } from '../agents/semantic-validation.agent.js';
import { FreshnessAgent } from '../agents/freshness.agent.js';

import { createLogger } from '../utils/logger.js';

const log = createLogger('AgentDispatcher');

const AGENT_REGISTRY = {
  table_profiling:  () => new TableProfilingAgent(),
  column_profiling: () => new ColumnProfilingAgent(),
  pattern_analysis: () => new PatternAnalysisAgent(),
  reconciliation:   () => new ReconciliationAgent(),
  semantic:         () => new SemanticValidationAgent(),
  freshness:        () => new FreshnessAgent(),
} as const satisfies Record<AgentName, () => { run(ctx: AgentContext): Promise<AgentResult> }>;

export interface DispatchResult {
  agentResults: Partial<Record<AgentName, AgentResult>>;
  skippedStages: string[];
  blockedEarly: boolean;
}

export class AgentDispatcher {
  async dispatch(
    plan: ExecutionPlan,
    ctx: AgentContext,
    intent: ParsedIntent
  ): Promise<DispatchResult> {
    const agentResults: Partial<Record<AgentName, AgentResult>> = {};
    const skippedStages: string[] = [];
    let blockedEarly = false;

    for (const stage of plan.stages) {
      if (blockedEarly) {
        this.skipStage(stage, agentResults, 'Skipped: previous stage reported HIGH severity failure');
        skippedStages.push(stage.name);
        continue;
      }

      log.info(`${stage.name}`, { agents: stage.agents, parallel: stage.runParallel });
      await this.runStage(stage, ctx, agentResults);

      if (stage.blockOnHighFail) {
        const blocked = stage.agents.some((agentName) => {
          const result = agentResults[agentName];
          return (
            result?.status === 'FAIL' &&
            result.failures.some((f) => {
              // In critical mode, MEDIUM also blocks
              if (intent.urgency === 'critical') return f.severity === 'HIGH' || f.severity === 'MEDIUM';
              return f.severity === 'HIGH';
            })
          );
        });

        if (blocked) {
          log.error(`${stage.name} produced a blocking failure — skipping downstream stages`);
          blockedEarly = true;
        }
      }
    }

    log.info('Dispatch complete', {
      agentsRun: Object.keys(agentResults).length,
      skipped: skippedStages.length,
      blockedEarly,
    });

    return { agentResults, skippedStages, blockedEarly };
  }

  private async runStage(
    stage: ExecutionStage,
    ctx: AgentContext,
    agentResults: Partial<Record<AgentName, AgentResult>>
  ): Promise<void> {
    if (stage.runParallel) {
      await Promise.all(stage.agents.map(async (name) => {
        agentResults[name] = await this.runAgent(name, ctx);
        log.info(`${name} completed`, { status: agentResults[name]!.status });
      }));
    } else {
      for (const name of stage.agents) {
        agentResults[name] = await this.runAgent(name, ctx);
        log.info(`${name} completed`, { status: agentResults[name]!.status });
      }
    }
  }

  private async runAgent(agentName: AgentName, ctx: AgentContext): Promise<AgentResult> {
    const factory = AGENT_REGISTRY[agentName];
    if (!factory) {
      log.error(`Unknown agent: ${agentName}`);
      return createSkippedAgentResult(`Unknown agent: ${agentName}`);
    }

    try {
      return await factory().run(ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Agent ${agentName} threw an error`, { error: msg });
      return createSkippedAgentResult(`Agent crashed: ${msg}`);
    }
  }

  private skipStage(
    stage: ExecutionStage,
    agentResults: Partial<Record<AgentName, AgentResult>>,
    reason: string
  ): void {
    for (const name of stage.agents) {
      agentResults[name] = createSkippedAgentResult(reason);
    }
  }
}
