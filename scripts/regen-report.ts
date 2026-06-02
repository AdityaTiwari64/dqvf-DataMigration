// Regenerate the PDF report from the existing JSON report
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import fs from 'node:fs';
import path from 'node:path';
import { generatePDFReport } from '../src/reporters/pdf-reporter.js';
import type { ValidationReport } from '../src/types/report.js';

const reportDir = path.resolve('reports');
const jsonPath  = path.join(reportDir, '2026-05-25-prod-migration.json');

if (!fs.existsSync(jsonPath)) {
  console.error('JSON report not found:', jsonPath);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ValidationReport;

const outPath = await generatePDFReport(report, reportDir);
console.log('PDF report written to:', outPath);
