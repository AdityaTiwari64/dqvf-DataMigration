/**
 * Core report types for the DQVF validation framework.
 * Matches the specified JSON report schema.
 */

// Severity & Status Enums

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export type RuleStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIPPED';
export type OverallStatus = 'PASS' | 'FAIL' | 'WARN';

// Validation Failure

export interface ValidationFailure {
  table: string;
  column?: string;
  rule: string;
  severity: Severity;
  detail: string;
  remediation?: string;
  metadata?: Record<string, unknown>;
}

// Rule Check Result

export interface RuleCheckResult {
  rule: string;
  status: RuleStatus;
  severity: Severity;
  table: string;
  column?: string;
  detail: string;
  remediation?: string;
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

// Agent Result

export interface AgentResult {
  status: OverallStatus;
  rulesChecked: number;
  rulesPassed: number;
  rulesFailed: number;
  rulesWarned: number;
  rulesSkipped: number;
  failures: ValidationFailure[];
  results: RuleCheckResult[];
  durationMs: number;
  skippedReason?: string;
}

// Agent Names

export type AgentName =
  | 'table_profiling'
  | 'column_profiling'
  | 'pattern_analysis'
  | 'reconciliation'
  | 'semantic'
  | 'freshness';

// Validation Report

export interface ValidationReport {
  runId: string;
  timestamp: string;
  overallStatus: OverallStatus;
  goLiveBlocked: boolean;
  summary: string;
  agents: Partial<Record<AgentName, AgentResult>>;
  rootCauseAnalysis?: string;
  recommendedActions?: string[];
  config: {
    sourcetype: string;
    targetType: string;
    tablesValidated: string[];
  };
  durationMs: number;
}

// Supervisor Report
// Extends ValidationReport with supervisor-level metadata

export interface ExecutionStageRecord {
  name: string;
  agents: AgentName[];
  runParallel: boolean;
  blockOnHighFail: boolean;
}

export interface SupervisorReport extends ValidationReport {
  /** Original user instruction that triggered this run */
  userInstruction: string;
  /** Human-readable summary of what the supervisor understood */
  intentSummary: string;
  /** Urgency level parsed from the instruction */
  urgency: 'critical' | 'normal' | 'audit';
  /** The execution plan that was built and dispatched */
  executionPlan: ExecutionStageRecord[];
  /** Stages that were skipped due to blocking failures */
  skippedStages: string[];
  /** Whether execution was stopped early by a blocking failure */
  blockedEarly: boolean;
  /** Go-live recommendation from LLM analysis */
  goLiveRecommendation?: 'PROCEED' | 'PROCEED_WITH_CAUTION' | 'BLOCK';
  /** LLM risk assessment */
  riskAssessment?: string;
}

// Helper: Create empty agent result

export function createSkippedAgentResult(reason: string): AgentResult {
  return {
    status: 'WARN',
    rulesChecked: 0,
    rulesPassed: 0,
    rulesFailed: 0,
    rulesWarned: 0,
    rulesSkipped: 0,
    failures: [],
    results: [],
    durationMs: 0,
    skippedReason: reason,
  };
}

export function aggregateRuleResults(results: RuleCheckResult[]): AgentResult {
  const failures: ValidationFailure[] = results
    .filter((r) => r.status === 'FAIL')
    .map((r) => ({
      table: r.table,
      column: r.column,
      rule: r.rule,
      severity: r.severity,
      detail: r.detail,
      remediation: r.remediation,
      metadata: r.metadata,
    }));

  const rulesFailed = results.filter((r) => r.status === 'FAIL').length;
  const rulesWarned = results.filter((r) => r.status === 'WARN').length;
  const rulesSkipped = results.filter((r) => r.status === 'SKIPPED').length;
  const rulesPassed = results.filter((r) => r.status === 'PASS').length;

  const hasHighFail = failures.some((f) => f.severity === 'HIGH');
  const hasMediumFail = failures.some((f) => f.severity === 'MEDIUM');

  let status: OverallStatus = 'PASS';
  if (hasHighFail) status = 'FAIL';
  else if (hasMediumFail || rulesWarned > 0) status = 'WARN';

  return {
    status,
    rulesChecked: results.length,
    rulesPassed,
    rulesFailed,
    rulesWarned,
    rulesSkipped,
    failures,
    results,
    durationMs: results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
  };
}
