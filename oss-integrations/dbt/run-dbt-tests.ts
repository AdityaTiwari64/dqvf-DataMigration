/**
 * dbt integration — subprocess wrapper for running dbt tests.
 * Parses dbt test results JSON and returns structured output.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../src/utils/logger.js';

const log = createLogger('dbtIntegration');

export interface DbtTestResult {
  success: boolean;
  totalTests: number;
  passed: number;
  failed: number;
  errors: number;
  failures: Array<{
    name: string;
    status: string;
    message: string;
  }>;
}

/**
 * Run dbt tests and parse results.
 *
 * Prerequisites:
 *   - dbt-core installed (pip install dbt-core dbt-postgres)
 *   - dbt project configured with profiles.yml
 *   - dbt-expectations package installed (for advanced tests)
 *
 * @param dbtProjectDir Path to dbt project root
 * @param target dbt target/profile to use
 */
export function runDbtTests(
  dbtProjectDir: string,
  target = 'default'
): DbtTestResult {
  log.info(`Running dbt tests in: ${dbtProjectDir}`);

  try {
    // Run dbt test with JSON output
    execSync(`dbt test --target ${target} --no-use-colors`, {
      cwd: dbtProjectDir,
      timeout: 300000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse run_results.json
    const resultsPath = path.join(dbtProjectDir, 'target', 'run_results.json');

    if (!fs.existsSync(resultsPath)) {
      log.warn('dbt run_results.json not found');
      return { success: false, totalTests: 0, passed: 0, failed: 0, errors: 0, failures: [] };
    }

    const resultsJson = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    const results = resultsJson.results ?? [];

    const passed = results.filter((r: { status: string }) => r.status === 'pass').length;
    const failed = results.filter((r: { status: string }) => r.status === 'fail').length;
    const errors = results.filter((r: { status: string }) => r.status === 'error').length;

    const failures = results
      .filter((r: { status: string }) => r.status === 'fail' || r.status === 'error')
      .map((r: { unique_id: string; status: string; message?: string }) => ({
        name: r.unique_id,
        status: r.status,
        message: r.message ?? 'No message',
      }));

    log.info(`dbt tests completed: ${passed} passed, ${failed} failed, ${errors} errors`);

    return {
      success: failed === 0 && errors === 0,
      totalTests: results.length,
      passed,
      failed,
      errors,
      failures,
    };
  } catch (error) {
    log.error('dbt test execution failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      totalTests: 0,
      passed: 0,
      failed: 0,
      errors: 1,
      failures: [{
        name: 'dbt_execution',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}
