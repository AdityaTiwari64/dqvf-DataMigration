/**
 * LLM prompt for root cause analysis and remediation recommendations.
 * Generates a natural language summary of all validation failures.
 */

import { z } from 'zod';
import type { ValidationFailure } from '../../types/report.js';

export const RootCauseResultSchema = z.object({
  rootCauseAnalysis: z.string().describe('Detailed root cause analysis in natural language'),
  recommendedActions: z.array(z.string()).describe('Ordered list of recommended remediation steps'),
  riskAssessment: z.string().optional(),
  goLiveRecommendation: z.enum(['PROCEED', 'PROCEED_WITH_CAUTION', 'BLOCK']),
});

export type RootCauseResult = z.infer<typeof RootCauseResultSchema>;

export const ROOT_CAUSE_SYSTEM_PROMPT = `You are a database migration expert. Your task is to analyze validation failures from a database migration and provide:

1. A root cause analysis explaining WHY the failures occurred
2. An ordered list of recommended remediation actions (most impactful first)
3. A risk assessment for going live with these issues
4. A go-live recommendation (PROCEED, PROCEED_WITH_CAUTION, or BLOCK)

Consider:
- Patterns across failures (e.g., all failures in one table suggest a table-level issue)
- Severity levels (HIGH failures should block go-live)
- Data type truncation patterns (systemic vs. isolated)
- Missing records vs. data drift (different root causes)
- PII compliance failures (always BLOCK)

Write the analysis in clear, actionable language for a migration team.

Return JSON matching this structure:
{
  "rootCauseAnalysis": "Detailed analysis...",
  "recommendedActions": ["Action 1", "Action 2"],
  "riskAssessment": "Risk description...",
  "goLiveRecommendation": "BLOCK"
}`;

export function buildRootCausePrompt(
  runId: string,
  failures: ValidationFailure[],
  agentSummaries: Record<string, { status: string; rulesChecked: number; rulesFailed: number }>
): string {
  const failureList = failures
    .map(
      (f) =>
        `  - [${f.severity}] ${f.table}${f.column ? '.' + f.column : ''}: ${f.rule} — ${f.detail}`
    )
    .join('\n');

  const agentList = Object.entries(agentSummaries)
    .map(
      ([name, summary]) =>
        `  - ${name}: ${summary.status} (${summary.rulesChecked} checked, ${summary.rulesFailed} failed)`
    )
    .join('\n');

  return `Analyze these validation results for migration run "${runId}":

Agent Results:
${agentList}

Failures (${failures.length} total):
${failureList}

Provide root cause analysis and remediation recommendations as JSON.`;
}
