/**
 * Great Expectations integration — subprocess wrapper.
 * Runs GE profiler against a database and returns structured results.
 */

import { execSync } from 'node:child_process';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('GreatExpectations');

export interface GEProfileResult {
  success: boolean;
  expectations: number;
  validationsPassed: number;
  validationsFailed: number;
  results: Record<string, unknown>[];
}

/**
 * Run Great Expectations profiler against a database.
 *
 * Prerequisites:
 *   - Python 3.8+ installed
 *   - pip install great_expectations
 *   - GE context initialized in the working directory
 *
 * @param connectionString Database connection string
 * @param tableName Table to profile
 * @param geProjectDir Path to Great Expectations project directory
 */
export function runGEProfiler(
  connectionString: string,
  tableName: string,
  geProjectDir: string = '.'
): GEProfileResult {
  log.info(`Running Great Expectations profiler for table: ${tableName}`);

  try {
    const script = `
import json
import great_expectations as gx

context = gx.get_context(project_root_dir="${geProjectDir.replace(/\\/g, '/')}")

datasource = context.sources.add_or_update_sql(
    name="migration_source",
    connection_string="${connectionString}"
)

asset = datasource.add_table_asset(name="${tableName}", table_name="${tableName}")
batch_request = asset.build_batch_request()

profiler = gx.rule_based_profiler.RuleBasedProfiler(
    name="migration_profiler",
    config_version=1.0,
    data_context=context
)

result = context.run_profiler_with_dynamic_arguments(
    profiler=profiler,
    batch_request=batch_request
)

print(json.dumps({
    "success": True,
    "expectations": len(result.expectation_suite.expectations),
    "results": [e.to_json_dict() for e in result.expectation_suite.expectations[:20]]
}))
`;

    const output = execSync(`python -c "${script.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
      cwd: geProjectDir,
      timeout: 120000,
      encoding: 'utf-8',
    });

    const parsed = JSON.parse(output.trim());
    log.info(`Great Expectations profiler completed: ${parsed.expectations} expectations generated`);

    return {
      success: parsed.success,
      expectations: parsed.expectations,
      validationsPassed: 0,
      validationsFailed: 0,
      results: parsed.results ?? [],
    };
  } catch (error) {
    log.error('Great Expectations profiler failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      expectations: 0,
      validationsPassed: 0,
      validationsFailed: 0,
      results: [],
    };
  }
}
