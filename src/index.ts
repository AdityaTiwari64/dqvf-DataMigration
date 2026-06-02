// Load .env before anything else
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { loadConfig } from './config/loader.js';
import { SupervisorAgent } from './supervisor/supervisor-agent.js';
import { createLogger, setLogLevel } from './utils/logger.js';
import type { AgentName } from './types/report.js';

// Single-agent debug mode imports
import { createConnector } from './connectors/connector-factory.js';
import { createLLMClient } from './llm/client.js';
import { TableProfilingAgent } from './agents/table-profiling.agent.js';
import { ColumnProfilingAgent } from './agents/column-profiling.agent.js';
import { PatternAnalysisAgent } from './agents/pattern-analysis.agent.js';
import { ReconciliationAgent } from './agents/reconciliation.agent.js';
import { SemanticValidationAgent } from './agents/semantic-validation.agent.js';
import { FreshnessAgent } from './agents/freshness.agent.js';

const log = createLogger('CLI');

interface CliArgs {
  config?: string;
  instruction: string;
  reportDir?: string;
  skipReports: boolean;
  agent?: AgentName;
  table?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { instruction: '', skipReports: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--config':   case '-c': args.config      = argv[++i]; break;
      case '--instruction': case '-i': args.instruction = argv[++i] ?? ''; break;
      case '--report-dir':  case '-o': args.reportDir   = argv[++i]; break;
      case '--skip-reports': args.skipReports = true; break;
      case '--agent':    case '-a': args.agent  = argv[++i] as AgentName; break;
      case '--table':    case '-t': args.table  = argv[++i]; break;
      case '--help':     case '-h': args.help   = true; break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
DQVF — Data Quality Validation Framework

USAGE:
  npx tsx src/index.ts --config <path> [options]

OPTIONS:
  -c, --config <path>        YAML config file (required)
  -i, --instruction <text>   Natural-language instruction for the supervisor
  -o, --report-dir <path>    Output directory for reports (default: ./reports)
      --skip-reports         Skip writing report files

DEBUG (single agent):
  -a, --agent <name>         Run one agent only
  -t, --table <name>         Scope to one table
  AGENT NAMES: table_profiling, column_profiling, pattern_analysis,
               reconciliation, semantic, freshness

  -h, --help                 Show this help

EXAMPLES:
  npx tsx src/index.ts --config configs/prod.yml
  npx tsx src/index.ts --config configs/prod.yml \\
    --instruction "Quick freshness check on the orders table"
  npx tsx src/index.ts --config configs/prod.yml \\
    --agent reconciliation --table orders
`);
}

async function runSingleAgent(
  configPath: string,
  agentName: AgentName,
  tableName?: string
): Promise<void> {
  const config = loadConfig(configPath);

  const agentMap = {
    table_profiling:  () => new TableProfilingAgent(),
    column_profiling: () => new ColumnProfilingAgent(),
    pattern_analysis: () => new PatternAnalysisAgent(),
    reconciliation:   () => new ReconciliationAgent(),
    semantic:         () => new SemanticValidationAgent(),
    freshness:        () => new FreshnessAgent(),
  } as const;

  const factory = agentMap[agentName];
  if (!factory) {
    console.error(`Unknown agent: ${agentName}`);
    process.exit(1);
  }

  const sourceDb = createConnector(config.source);
  const targetDb = createConnector(config.target);

  try {
    await sourceDb.testConnection();
    await targetDb.testConnection();

    const llm = await createLLMClient(config.llm);
    const ctx = { sourceDb, targetDb, config, llm };
    const agent = factory();

    let result;
    if (tableName) {
      const tableConfig = config.tables.find((t) => t.name === tableName);
      if (!tableConfig) {
        console.error(`Table not found in config: ${tableName}`);
        process.exit(1);
      }
      result = await agent.runSingle(ctx, tableConfig);
    } else {
      result = await agent.run(ctx);
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sourceDb.disconnect();
    await targetDb.disconnect();
  }
}

async function main(): Promise<void> {
  const logLevel = process.env.DQVF_LOG_LEVEL?.toUpperCase();
  if (logLevel === 'DEBUG' || logLevel === 'INFO' || logLevel === 'WARN' || logLevel === 'ERROR') {
    setLogLevel(logLevel);
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.help) { printHelp(); process.exit(0); }

  if (!args.config) {
    console.error('Error: --config <path> is required\n');
    printHelp();
    process.exit(1);
  }

  if (args.agent) {
    log.info(`Single-agent mode: ${args.agent}`);
    await runSingleAgent(args.config, args.agent, args.table);
    return;
  }

  log.info('Starting DQVF Supervisor Agent');

  const config = loadConfig(args.config);
  const supervisor = new SupervisorAgent(config, {
    skipReports: args.skipReports,
    reportDir: args.reportDir,
  });

  const instruction = args.instruction || 'Run full validation on all configured tables';
  const report = await supervisor.run(instruction);

  // Print summary
  const line = '─'.repeat(60);
  console.log('\n' + '═'.repeat(60));
  console.log('  DQVF VALIDATION REPORT');
  console.log('═'.repeat(60));
  console.log(`  Run ID:         ${report.runId}`);
  console.log(`  Timestamp:      ${report.timestamp}`);
  console.log(`  Instruction:    ${report.userInstruction}`);
  console.log(`  Intent:         ${report.intentSummary}`);
  console.log(`  Urgency:        ${report.urgency}`);
  console.log(line);
  console.log(`  Overall Status: ${report.overallStatus}`);
  console.log(`  Go-Live:        ${report.goLiveBlocked ? '[BLOCKED]' : '[CLEAR]'}`);
  console.log(`  Recommendation: ${report.goLiveRecommendation ?? 'N/A'}`);
  console.log(`  Duration:       ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(line);

  const agentEntries = Object.entries(report.agents);
  if (agentEntries.length > 0) {
    console.log('  Agent Results:');
    for (const [name, result] of agentEntries) {
      if (result) {
        const icon = result.status === 'PASS' ? '+' : result.status === 'FAIL' ? 'x' : '~';
        console.log(
          `    [${icon}] ${name.padEnd(20)} ${result.status.padEnd(5)} ` +
          `(${result.rulesChecked} checked, ${result.rulesFailed} failed)`
        );
      }
    }
  }

  if (report.skippedStages.length > 0) {
    console.log(line);
    console.log('  Skipped Stages:');
    for (const s of report.skippedStages) {
      console.log(`    - ${s}`);
    }
  }

  if (report.rootCauseAnalysis) {
    console.log(line);
    console.log('  Root Cause Analysis:');
    console.log(`  ${report.rootCauseAnalysis.split('\n').join('\n  ')}`);
  }

  if (report.recommendedActions && report.recommendedActions.length > 0) {
    console.log(line);
    console.log('  Recommended Actions:');
    report.recommendedActions.forEach((action, i) => {
      console.log(`    ${i + 1}. ${action}`);
    });
  }

  console.log('═'.repeat(60));
  console.log(`  Summary: ${report.summary}`);
  console.log('═'.repeat(60) + '\n');

  if (report.goLiveBlocked) process.exit(2);
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  if (process.env.DQVF_LOG_LEVEL === 'DEBUG') console.error(error);
  process.exit(1);
});
