import type { AgentName } from '../types/report.js';
import type { ParsedIntent } from './intent-parser.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ExecutionPlan');

export interface ExecutionStage {
  name: string;
  agents: AgentName[];
  runParallel: boolean;
  // If true and any agent returns HIGH FAIL, all subsequent stages are skipped
  blockOnHighFail: boolean;
}

export interface ExecutionPlan {
  stages: ExecutionStage[];
  intent: ParsedIntent;
  createdAt: string;
}

// Canonical stage ordering
const STAGE_MAP: ExecutionStage[] = [
  { name: 'Stage 1: Table Profiling',                     agents: ['table_profiling'],               runParallel: false, blockOnHighFail: true  },
  { name: 'Stage 2: Column Profiling',                    agents: ['column_profiling'],              runParallel: false, blockOnHighFail: true  },
  { name: 'Stage 3: Pattern Analysis + Reconciliation',   agents: ['pattern_analysis', 'reconciliation'], runParallel: true, blockOnHighFail: false },
  { name: 'Stage 4: Semantic Validation + Freshness',     agents: ['semantic', 'freshness'],         runParallel: true,  blockOnHighFail: false },
];

export function buildExecutionPlan(intent: ParsedIntent): ExecutionPlan {
  const selected = new Set<AgentName>(intent.agentsToRun as AgentName[]);

  const stages: ExecutionStage[] = STAGE_MAP
    .map((stage) => ({ ...stage, agents: stage.agents.filter((a) => selected.has(a)) }))
    .filter((stage) => stage.agents.length > 0);

  if (stages.length === 0) {
    log.warn('No agents selected — falling back to table_profiling');
    stages.push({ name: 'Stage 1: Table Profiling (fallback)', agents: ['table_profiling'], runParallel: false, blockOnHighFail: true });
  }

  log.info('Execution plan built', {
    stages: stages.map((s) => `${s.name} [${s.agents.join(', ')}]`),
  });

  return { stages, intent, createdAt: new Date().toISOString() };
}

export function summarizePlan(plan: ExecutionPlan): string {
  return plan.stages
    .map((s) => `${s.name}: [${s.agents.join(', ')}] (${s.runParallel ? 'parallel' : 'sequential'})`)
    .join('\n');
}
