import type { LLMClient } from '../llm/client.js';
import type { RunConfig } from '../config/schema.js';
import type { AgentName } from '../types/report.js';
import {
  ParsedIntentSchema,
  type ParsedIntent,
  INTENT_PARSER_SYSTEM_PROMPT,
  buildIntentParserPrompt,
} from '../llm/prompts/intent-parser.js';
import { createLogger } from '../utils/logger.js';

export type { ParsedIntent } from '../llm/prompts/intent-parser.js';

const log = createLogger('IntentParser');

function buildFullRunIntent(instruction: string): ParsedIntent {
  return {
    agentsToRun: ['table_profiling', 'column_profiling', 'pattern_analysis', 'reconciliation', 'semantic', 'freshness'],
    focusTables: [],
    urgency: 'normal',
    intentSummary: `Full validation run — ${instruction || 'all checks across all tables'}`,
  };
}

export class IntentParser {
  private llm: LLMClient | null;

  constructor(llm: LLMClient | null) {
    this.llm = llm;
  }

  async parse(instruction: string, config: RunConfig): Promise<ParsedIntent> {
    const availableTables = config.tables.map((t) => t.name);

    if (!instruction.trim()) {
      log.info('No instruction provided — defaulting to full run');
      return buildFullRunIntent('');
    }

    if (!this.llm?.isAvailable) {
      log.warn('LLM not available — using heuristic fallback');
      return this.heuristicParse(instruction, config);
    }

    log.info('Parsing instruction via LLM', { instruction });

    try {
      const prompt = buildIntentParserPrompt(
        instruction,
        availableTables,
        config.agents as Partial<Record<AgentName, boolean>>
      );

      const parsed = await this.llm.chatStructured(INTENT_PARSER_SYSTEM_PROMPT, prompt, ParsedIntentSchema);

      if (!parsed) {
        log.warn('LLM returned invalid intent — falling back to heuristic');
        return this.heuristicParse(instruction, config);
      }

      const filtered = parsed.agentsToRun.filter(
        (a) => config.agents[a as keyof typeof config.agents] !== false
      );

      const result: ParsedIntent = {
        ...parsed,
        agentsToRun: filtered.length > 0 ? filtered : (parsed.agentsToRun as AgentName[]),
        focusTables: (parsed.focusTables ?? []).filter((t) => availableTables.includes(t)),
        urgency: parsed.urgency ?? 'normal',
      };

      log.info('Intent parsed', {
        agents: result.agentsToRun,
        tables: result.focusTables.length > 0 ? result.focusTables : 'all',
        urgency: result.urgency,
      });

      return result;
    } catch (error) {
      log.error('Intent parsing failed', { error: error instanceof Error ? error.message : String(error) });
      return this.heuristicParse(instruction, config);
    }
  }

  // Keyword-based fallback when LLM is unavailable
  private heuristicParse(instruction: string, config: RunConfig): ParsedIntent {
    const lower = instruction.toLowerCase();
    const allAgents: AgentName[] = [
      'table_profiling', 'column_profiling', 'pattern_analysis',
      'reconciliation', 'semantic', 'freshness',
    ];

    const enabledAgents = allAgents.filter(
      (a) => config.agents[a as keyof typeof config.agents] !== false
    );

    let agentsToRun: AgentName[] = enabledAgents;
    let urgency: ParsedIntent['urgency'] = 'normal';
    let intentSummary = 'Full validation run (heuristic fallback)';

    if (lower.includes('quick') || lower.includes('fast') || lower.includes('brief')) {
      agentsToRun  = enabledAgents.filter((a) => ['table_profiling', 'column_profiling'].includes(a));
      intentSummary = 'Quick table and column profiling check';
    } else if (lower.includes('pii') || lower.includes('compliance') || lower.includes('business rule')) {
      agentsToRun  = enabledAgents.filter((a) => ['table_profiling', 'semantic'].includes(a));
      intentSummary = 'PII and business rule compliance check';
    } else if (lower.includes('freshness') || lower.includes('cdc') || lower.includes('pipeline')) {
      agentsToRun  = enabledAgents.filter((a) => ['table_profiling', 'freshness'].includes(a));
      intentSummary = 'Data freshness and pipeline lag check';
    } else if (lower.includes('duplicate') || lower.includes('anomaly') || lower.includes('drift')) {
      agentsToRun  = enabledAgents.filter((a) => ['table_profiling', 'column_profiling', 'pattern_analysis'].includes(a));
      intentSummary = 'Pattern analysis and anomaly detection';
    } else if (lower.includes('reconcil') || lower.includes('record match') || lower.includes('delta')) {
      agentsToRun  = enabledAgents.filter((a) => ['table_profiling', 'column_profiling', 'reconciliation'].includes(a));
      intentSummary = 'Record reconciliation and delta analysis';
    }

    if (lower.includes('critical') || lower.includes('urgent') || lower.includes('block')) {
      urgency = 'critical';
    } else if (lower.includes('audit') || lower.includes('report only') || lower.includes('no block')) {
      urgency = 'audit';
    }

    log.info('Heuristic intent parsed', { agents: agentsToRun, urgency });

    return { agentsToRun, focusTables: [], urgency, intentSummary };
  }
}
