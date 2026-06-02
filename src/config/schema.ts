import { z } from 'zod';

export const TableConfigSchema = z.object({
  name: z.string().min(1),
  pk: z.string().min(1).describe('Primary key column name'),
  sla_freshness_hours: z.number().positive().optional().default(24),
  schema: z.string().optional().default('public'),
  /** Optional: columns to skip during validation */
  skip_columns: z.array(z.string()).optional().default([]),
  /** Optional: business rule expressions */
  business_rules: z
    .array(
      z.object({
        name: z.string(),
        expression: z.string(),
        description: z.string().optional(),
      })
    )
    .optional()
    .default([]),
});

export type TableConfig = z.infer<typeof TableConfigSchema>;

// Connection Configuration

export const ConnectionConfigSchema = z.object({
  type: z.enum(['postgresql', 'neon', 'sqlserver', 'mysql', 'mongodb']),
  connection_string: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  ssl: z.boolean().optional(),
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

// Threshold Configuration

export const ThresholdConfigSchema = z.object({
  row_count_tolerance_pct: z.number().min(0).default(0),
  null_rate_delta_pct: z.number().min(0).default(1),
  distribution_drift_pvalue: z.number().min(0).max(1).default(0.05),
  cardinality_change_pct: z.number().min(0).default(10),
  chunk_size: z.number().positive().default(100000),
  cdc_lag_max_minutes: z.number().positive().default(15),
  hash_algorithm: z.enum(['md5', 'sha256']).default('md5'),
  volume_baseline_pct: z.number().min(0).default(10),
  fuzzy_duplicate_threshold: z.number().min(0).max(1).default(0.85),
  levenshtein_max_distance: z.number().min(0).default(3),
  parallel_chunk_workers: z.number().positive().default(4),
});

export type ThresholdConfig = z.infer<typeof ThresholdConfigSchema>;

// Agent Toggles

export const AgentToggleSchema = z.object({
  table_profiling: z.boolean().default(true),
  column_profiling: z.boolean().default(true),
  pattern_analysis: z.boolean().default(true),
  reconciliation: z.boolean().default(true),
  semantic: z.boolean().default(true),
  freshness: z.boolean().default(true),
});

export type AgentToggle = z.infer<typeof AgentToggleSchema>;

// LLM Configuration

export const LLMConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openrouter']).default('anthropic'),
  model: z.string().default('claude-sonnet-4-20250514'),
  base_url: z.string().url().optional(),
  max_tokens: z.number().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

// Notification Configuration

export const NotificationConfigSchema = z.object({
  slack_webhook: z.string().url().optional(),
  alert_on: z.array(z.enum(['HIGH', 'MEDIUM', 'LOW'])).default(['HIGH', 'MEDIUM']),
});

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

// Full Run Configuration

export const RunConfigSchema = z.object({
  migration_run_id: z.string().min(1),
  source: ConnectionConfigSchema,
  target: ConnectionConfigSchema,
  tables: z.array(TableConfigSchema).min(1),
  thresholds: ThresholdConfigSchema.optional().default({}),
  agents: AgentToggleSchema.optional().default({}),
  llm: LLMConfigSchema.optional().default({}),
  notifications: NotificationConfigSchema.optional().default({}),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;
