import type { RunConfig } from '../config/schema.js';
import type { AgentName, AgentResult, SupervisorReport } from '../types/report.js';
import { createConnector } from '../connectors/connector-factory.js';
import { createLLMClient, type LLMClient } from '../llm/client.js';
import { createLogger } from '../utils/logger.js';

import { IntentParser } from './intent-parser.js';
import { buildExecutionPlan, summarizePlan } from './execution-plan.js';
import { AgentDispatcher } from './agent-dispatcher.js';

import {
  ROOT_CAUSE_SYSTEM_PROMPT,
  RootCauseResultSchema,
  buildRootCausePrompt,
} from '../llm/prompts/root-cause.js';

import { generateJSONReport } from '../reporters/json-reporter.js';
import { generatePDFReport } from '../reporters/pdf-reporter.js';
import { sendSlackNotification } from '../reporters/slack-notifier.js';

import type { ValidationFailure } from '../types/report.js';

const log = createLogger('SupervisorAgent');

export interface SupervisorOptions {
  skipReports?: boolean;
  reportDir?: string;
}

export class SupervisorAgent {
  private config: RunConfig;
  private options: SupervisorOptions;

  constructor(config: RunConfig, options: SupervisorOptions = {}) {
    this.config = config;
    this.options = options;
  }

  async run(instruction: string): Promise<SupervisorReport> {
    const startTime = Date.now();
    const config = this.config;

    log.info('Supervisor Agent starting', {
      runId: config.migration_run_id,
      instruction: instruction || '(none)',
    });

    // 1. Initialize DB connections
    const sourceDb = createConnector(config.source);
    const targetDb = createConnector(config.target);

    try {
      log.info('Testing database connections...');
      await sourceDb.testConnection();
      await targetDb.testConnection();
      log.info('Database connections verified ✓');

      // 2. Initialize LLM
      let llm: LLMClient | null = null;
      try {
        llm = await createLLMClient(config.llm);
        if (!llm) {
          log.warn('LLM client not available — using heuristic fallback for intent parsing');
        }
      } catch {
        log.warn('LLM initialization failed — continuing without LLM features');
      }

      // 3. Parse Intent
      log.info('═══ Parsing user intent ═══');
      const intentParser = new IntentParser(llm);
      const intent = await intentParser.parse(instruction, config);

      log.info('Intent resolved', {
        summary: intent.intentSummary,
        agents: intent.agentsToRun,
        urgency: intent.urgency,
        focusTables: intent.focusTables.length > 0 ? intent.focusTables : 'all',
      });

      // 4. Build Execution Plan
      log.info('═══ Building execution plan ═══');
      const plan = buildExecutionPlan(intent);
      log.info('Execution plan:\n' + summarizePlan(plan));

      // Apply focus table filter to config if specified
      const scopedConfig =
        intent.focusTables.length > 0
          ? {
              ...config,
              tables: config.tables.filter((t) => intent.focusTables.includes(t.name)),
            }
          : config;

      const ctx = { sourceDb, targetDb, config: scopedConfig, llm };

      // 5. Dispatch Worker Agents
      log.info('═══ Dispatching worker agents ═══');
      const dispatcher = new AgentDispatcher();
      const { agentResults, skippedStages, blockedEarly } = await dispatcher.dispatch(
        plan,
        ctx,
        intent
      );

      // 6. Build Report
      log.info('═══ Building validation report ═══');
      const report = await this.buildSupervisorReport(
        config,
        agentResults,
        instruction,
        intent.intentSummary,
        intent.urgency,
        plan.stages.map((s) => ({
          name: s.name,
          agents: s.agents,
          runParallel: s.runParallel,
          blockOnHighFail: s.blockOnHighFail,
        })),
        skippedStages,
        blockedEarly,
        startTime,
        llm
      );

      // 7. Publish Reports
      if (!this.options.skipReports) {
        await this.publishReports(report, config);
      }

      log.info('Supervisor Agent completed ✓', {
        runId: report.runId,
        overallStatus: report.overallStatus,
        goLiveBlocked: report.goLiveBlocked,
        goLiveRecommendation: report.goLiveRecommendation,
        durationMs: report.durationMs,
      });

      return report;
    } finally {
      await sourceDb.disconnect();
      await targetDb.disconnect();
    }
  }

  // Build report

  private async buildSupervisorReport(
    config: RunConfig,
    agentResults: Partial<Record<AgentName, AgentResult>>,
    userInstruction: string,
    intentSummary: string,
    urgency: 'critical' | 'normal' | 'audit',
    executionPlan: SupervisorReport['executionPlan'],
    skippedStages: string[],
    blockedEarly: boolean,
    startTime: number,
    llm: LLMClient | null
  ): Promise<SupervisorReport> {
    const allResults = Object.values(agentResults);
    const allFailures: ValidationFailure[] = allResults.flatMap((r) => r.failures ?? []);

    const hasHighFail = allFailures.some((f) => f.severity === 'HIGH');
    const hasMediumFail = allFailures.some((f) => f.severity === 'MEDIUM');
    const hasFail = allResults.some((r) => r.status === 'FAIL');
    const hasWarn = allResults.some((r) => r.status === 'WARN');

    let overallStatus: 'PASS' | 'FAIL' | 'WARN' = 'PASS';
    if (hasFail) overallStatus = 'FAIL';
    else if (hasWarn) overallStatus = 'WARN';

    // In audit mode, never block go-live
    const goLiveBlocked = urgency !== 'audit' && hasHighFail;

    // Build summary
    const highCount = allFailures.filter((f) => f.severity === 'HIGH').length;
    const medCount = allFailures.filter((f) => f.severity === 'MEDIUM').length;
    const totalChecked = allResults.reduce((sum, r) => sum + (r.rulesChecked ?? 0), 0);

    let summary = `[${config.migration_run_id}] ${intentSummary}. `;
    summary += `${totalChecked} rules checked across ${config.tables.length} table(s). `;

    if (overallStatus === 'PASS') {
      summary += 'All checks passed. Go-live is recommended.';
    } else {
      summary += `${highCount} HIGH and ${medCount} MEDIUM severity failures detected.`;
      if (goLiveBlocked) summary += ' Go-live is BLOCKED.';
      else if (urgency === 'audit') summary += ' Running in audit mode — go-live not blocked.';
    }

    // LLM root cause analysis
    let rootCauseAnalysis: string | undefined;
    let recommendedActions: string[] | undefined;
    let goLiveRecommendation: SupervisorReport['goLiveRecommendation'];
    let riskAssessment: string | undefined;

    if (allFailures.length > 0 && llm?.isAvailable) {
      try {
        const agentSummaries: Record<string, { status: string; rulesChecked: number; rulesFailed: number }> = {};
        for (const [name, result] of Object.entries(agentResults)) {
          if (result) {
            agentSummaries[name] = {
              status: result.status,
              rulesChecked: result.rulesChecked,
              rulesFailed: result.rulesFailed,
            };
          }
        }

        const prompt = buildRootCausePrompt(config.migration_run_id, allFailures, agentSummaries);
        const rootCause = await llm.chatStructured(
          ROOT_CAUSE_SYSTEM_PROMPT,
          prompt,
          RootCauseResultSchema
        );

        if (rootCause) {
          rootCauseAnalysis = rootCause.rootCauseAnalysis;
          recommendedActions = rootCause.recommendedActions;
          goLiveRecommendation = rootCause.goLiveRecommendation;
          riskAssessment = rootCause.riskAssessment;
        }
      } catch (error) {
        log.warn('Root cause analysis failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback if LLM unavailable
    if (!goLiveRecommendation) {
      if (goLiveBlocked) goLiveRecommendation = 'BLOCK';
      else if (hasMediumFail || hasWarn) goLiveRecommendation = 'PROCEED_WITH_CAUTION';
      else goLiveRecommendation = 'PROCEED';
    }

    return {
      // ValidationReport fields
      runId: config.migration_run_id,
      timestamp: new Date().toISOString(),
      overallStatus,
      goLiveBlocked,
      summary,
      agents: agentResults,
      rootCauseAnalysis,
      recommendedActions,
      config: {
        sourcetype: config.source.type,
        targetType: config.target.type,
        tablesValidated: config.tables.map((t) => t.name),
      },
      durationMs: Date.now() - startTime,

      // SupervisorReport-specific fields
      userInstruction,
      intentSummary,
      urgency,
      executionPlan,
      skippedStages,
      blockedEarly,
      goLiveRecommendation,
      riskAssessment,
    };
  }

  // Publish reports

  private async publishReports(
    report: SupervisorReport,
    config: RunConfig
  ): Promise<void> {
    const reportDir = this.options.reportDir ?? process.env.REPORT_OUTPUT_DIR ?? './reports';

    try {
      await generateJSONReport(report, reportDir);
      log.info('JSON report written', { dir: reportDir });
    } catch (error) {
      log.error('Failed to write JSON report', { error: String(error) });
    }

    try {
      await generatePDFReport(report, reportDir);
      log.info('PDF report written', { dir: reportDir });
    } catch (error) {
      log.error('Failed to write PDF report', { error: String(error) });
    }

    const webhookUrl = config.notifications.slack_webhook;
    if (webhookUrl) {
      try {
        const alertSeverities = config.notifications.alert_on;
        const relevantFailures = Object.values(report.agents)
          .flatMap((a) => a?.failures ?? [])
          .filter((f) => alertSeverities.includes(f.severity));

        if (relevantFailures.length > 0 || report.overallStatus === 'FAIL') {
          await sendSlackNotification(report, webhookUrl);
          log.info('Slack notification sent');
        }
      } catch (error) {
        log.error('Failed to send Slack notification', { error: String(error) });
      }
    }
  }
}
