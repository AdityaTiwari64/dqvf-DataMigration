/**
 * LLM prompt for parsing user natural-language instructions into a
 * structured execution intent that the Supervisor Agent acts on.
 */

import { z } from 'zod';
import type { AgentName } from '../../types/report.js';

// Parsed Intent Schema

export const ParsedIntentSchema = z.object({
  /**
   * Which worker agents to include in the execution plan.
   * If the user says "full validation" or is ambiguous, include all agents.
   */
  agentsToRun: z
    .array(
      z.enum([
        'table_profiling',
        'column_profiling',
        'pattern_analysis',
        'reconciliation',
        'semantic',
        'freshness',
      ])
    )
    .min(1)
    .describe('List of agents to execute'),

  /**
   * Specific tables to focus on. Empty array means validate all configured tables.
   */
  focusTables: z
    .array(z.string())
    .default([])
    .describe('Tables to scope the run to (empty = all tables)'),

  /**
   * Urgency level affects strictness of blocking thresholds.
   * - critical: block on any MEDIUM or HIGH failure
   * - normal:   block only on HIGH failures
   * - audit:    never block, report-only
   */
  urgency: z
    .enum(['critical', 'normal', 'audit'])
    .default('normal')
    .describe('How strictly to apply go-live blocking'),

  /**
   * Optional overrides to thresholds parsed from the instruction.
   */
  thresholdOverrides: z
    .object({
      row_count_tolerance_pct: z.number().optional(),
      null_rate_delta_pct: z.number().optional(),
      cdc_lag_max_minutes: z.number().optional(),
    })
    .optional()
    .describe('Partial threshold overrides parsed from the user instruction'),

  /**
   * Plain-English summary of what the supervisor understood.
   */
  intentSummary: z
    .string()
    .describe('One-sentence summary of what will be validated and why'),
});

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

// System Prompt

export const INTENT_PARSER_SYSTEM_PROMPT = `You are the Supervisor Agent for a Database Migration Quality Validation Framework (DQVF).
Your role is to parse a user's natural-language instruction and produce a structured execution plan.

Available worker agents and what they check:
- table_profiling:    Row counts, schema shape, primary keys, foreign keys. Always run first.
- column_profiling:   Data types, nullability, value ranges, cardinality, format patterns.
- pattern_analysis:   Data drift, anomalies, duplicate detection, fuzzy matches.
- reconciliation:     Record-by-record matching between source and target, delta analysis, CDC lag.
- semantic:           Schema mapping accuracy, PII detection, business rule compliance.
- freshness:          SLA compliance, temporal ordering, pipeline lag.

Rules for deciding which agents to run:
1. "Full validation" or "complete check" → all agents
2. "Quick check" or "fast scan" → table_profiling + column_profiling only
3. "Row counts" / "schema" → table_profiling only
4. "PII" / "compliance" / "business rules" → semantic agent (+ table_profiling)
5. "Freshness" / "CDC lag" / "pipeline" → freshness + table_profiling
6. "Duplicates" / "anomalies" → pattern_analysis + table_profiling
7. "Reconciliation" / "record matching" → reconciliation + table_profiling + column_profiling
8. When in doubt, run all agents.

Always include table_profiling unless user is very explicit about skipping it.
Return ONLY a JSON object matching the specified schema — no markdown, no explanation.`;

// Prompt Builder

export function buildIntentParserPrompt(
  userInstruction: string,
  availableTables: string[],
  configuredAgents: Partial<Record<AgentName, boolean>>
): string {
  const enabledAgents = Object.entries(configuredAgents)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');

  return `User instruction: "${userInstruction}"

Available tables in config: ${availableTables.join(', ')}
Agents enabled in config: ${enabledAgents || 'all'}

Parse the user's intent and return a JSON object with these fields:
{
  "agentsToRun": ["table_profiling", ...],
  "focusTables": [],
  "urgency": "normal",
  "thresholdOverrides": {},
  "intentSummary": "..."
}`;
}
