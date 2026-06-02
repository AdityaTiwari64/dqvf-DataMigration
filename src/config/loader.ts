/**
 * YAML configuration loader with environment variable interpolation.
 * Supports ${ENV_VAR} placeholders in config values.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { RunConfigSchema, type RunConfig } from './schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ConfigLoader');

/**
 * Interpolates ${ENV_VAR} placeholders in a string with process.env values.
 * Throws if a referenced env var is not set.
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envKey: string) => {
    const envValue = process.env[envKey.trim()];
    if (envValue === undefined) {
      throw new Error(`Environment variable "${envKey.trim()}" is not set (referenced in config)`);
    }
    return envValue;
  });
}

/**
 * Recursively walk an object/array and interpolate env vars in all string values.
 */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Load and validate a DQVF run configuration from a YAML file.
 *
 * @param configPath - Absolute or relative path to the YAML config file
 * @returns Validated and typed RunConfig
 * @throws Error on file not found, invalid YAML, or schema validation failure
 */
export function loadConfig(configPath: string): RunConfig {
  const resolvedPath = path.resolve(configPath);
  log.info(`Loading config from: ${resolvedPath}`);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const rawYaml = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(rawYaml);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML in config file: ${resolvedPath}`);
  }

  // Interpolate environment variables
  const interpolated = interpolateDeep(parsed);

  // Validate against Zod schema
  const result = RunConfigSchema.safeParse(interpolated);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  log.info('Config loaded and validated successfully', {
    runId: result.data.migration_run_id,
    tables: result.data.tables.length,
    sourceType: result.data.source.type,
    targetType: result.data.target.type,
  });

  return result.data;
}

/**
 * Load config from a raw YAML string (useful for MCP tool input).
 */
export function loadConfigFromString(yamlString: string): RunConfig {
  const parsed = yaml.load(yamlString);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML string');
  }

  const interpolated = interpolateDeep(parsed);
  const result = RunConfigSchema.safeParse(interpolated);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  return result.data;
}
