import fs from 'node:fs';
import path from 'node:path';
import type { ValidationReport } from '../types/report.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('JSONReporter');

export async function generateJSONReport(
  report: ValidationReport,
  outputDir: string
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });

  const filename = `${report.runId}.json`;
  const filePath = path.join(outputDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
  log.info(`JSON report written to: ${filePath}`);
  return filePath;
}

export function readJSONReport(reportDir: string, runId: string): ValidationReport | null {
  const filePath = path.join(reportDir, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ValidationReport;
}

export function listReportRunIds(reportDir: string): string[] {
  if (!fs.existsSync(reportDir)) return [];
  return fs
    .readdirSync(reportDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}
