import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { ValidationReport, AgentResult, ValidationFailure } from '../types/report.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PDFReporter');

const MARGIN = 50;
const PAGE_W = 595; // A4 width in points
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 40;
const PAD = 4;       // cell padding
const ROW_MIN = 14;  // minimum row height

const AGENT_LABELS: Record<string, string> = {
  table_profiling:  'Table Profiling',
  column_profiling: 'Column Profiling',
  pattern_analysis: 'Pattern Analysis',
  reconciliation:   'Reconciliation',
  semantic:         'Semantic Validation',
  freshness:        'Freshness',
};

// Column definitions — widths must sum to CONTENT_W (495)
const AGENT_COLS = [
  { key: 'agent',    label: 'Agent',    w: 160 },
  { key: 'status',   label: 'Status',   w: 60  },
  { key: 'checked',  label: 'Checked',  w: 55  },
  { key: 'passed',   label: 'Passed',   w: 55  },
  { key: 'failed',   label: 'Failed',   w: 55  },
  { key: 'duration', label: 'Duration', w: 110 },
];

const FAIL_COLS = [
  { key: 'severity', label: 'Severity',    w: 55  },
  { key: 'location', label: 'Location',    w: 105 },
  { key: 'rule',     label: 'Rule',        w: 115 },
  { key: 'detail',   label: 'Detail',      w: 170 },
  { key: 'remed',    label: 'Remediation', w: 50  },
];

// Core table row primitive
// Draws a single row. Cells that overflow their column are clipped.
// doc.y is set to rowY + rowH after drawing so the caller controls flow.

function drawRow(
  doc: PDFKit.PDFDocument,
  cols: { w: number }[],
  cells: string[],
  rowY: number,
  rowH: number,
  isHeader: boolean
): void {
  // Background + outer border
  if (isHeader) {
    doc.rect(MARGIN, rowY, CONTENT_W, rowH).fillAndStroke('#e0e0e0', '#999999');
    doc.fillColor('#000000');
  } else {
    doc.rect(MARGIN, rowY, CONTENT_W, rowH).stroke('#cccccc');
    doc.fillColor('#000000');
  }

  let x = MARGIN;
  const font = isHeader ? 'Helvetica-Bold' : 'Helvetica';

  for (let i = 0; i < cols.length; i++) {
    const cellW = cols[i].w;
    const text = cells[i] ?? '';
    const textW = cellW - PAD * 2;

    doc.font(font).fontSize(8).fillColor('#000000');
    // Explicit x, y so PDFKit places text exactly here regardless of cursor
    doc.text(text, x + PAD, rowY + PAD, {
      width: textW,
      height: rowH - PAD * 2,
      lineBreak: true,
      ellipsis: true,
    });

    // Draw right-side divider for all columns except the last
    if (i < cols.length - 1) {
      doc.moveTo(x + cellW, rowY).lineTo(x + cellW, rowY + rowH).stroke('#cccccc');
    }

    x += cellW;
  }

  // After drawing all cells, fix doc.y to the bottom of this row
  doc.y = rowY + rowH;
}

// Pre-calculate the height a row needs based on its tallest cell content
function rowHeight(
  doc: PDFKit.PDFDocument,
  cols: { w: number }[],
  cells: string[]
): number {
  let maxH = ROW_MIN;
  for (let i = 0; i < cols.length; i++) {
    const textW = cols[i].w - PAD * 2;
    const h = (doc as PDFKit.PDFDocument & { heightOfString(t: string, o?: object): number })
      .heightOfString(cells[i] ?? '', { width: textW, fontSize: 8 });
    const needed = h + PAD * 2;
    if (needed > maxH) maxH = needed;
  }
  return Math.ceil(maxH);
}

function checkPageBreak(doc: PDFKit.PDFDocument, neededH: number): void {
  if (doc.y + neededH > doc.page.height - FOOTER_H) {
    doc.addPage();
  }
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  checkPageBreak(doc, 30);
  doc.moveDown(0.4);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text(title, MARGIN, doc.y);
  doc.moveDown(0.25);
}

function divider(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.3);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).stroke('#cccccc');
  doc.moveDown(0.4);
}

// Agent table

function drawAgentTable(doc: PDFKit.PDFDocument, agents: ValidationReport['agents']): void {
  // Header
  const headerCells = AGENT_COLS.map((c) => c.label);
  const hH = rowHeight(doc, AGENT_COLS, headerCells);
  checkPageBreak(doc, hH);
  drawRow(doc, AGENT_COLS, headerCells, doc.y, hH, true);

  for (const [name, result] of Object.entries(agents)) {
    if (!result) continue;
    const label = AGENT_LABELS[name] ?? name;
    const skip  = result.skippedReason ? ` — ${result.skippedReason}` : '';
    const dur   = result.durationMs > 0 ? `${result.durationMs}ms` : '-';
    const cells = [
      label + skip,
      result.status,
      String(result.rulesChecked),
      String(result.rulesPassed),
      String(result.rulesFailed),
      dur,
    ];
    const rH = rowHeight(doc, AGENT_COLS, cells);
    checkPageBreak(doc, rH);
    drawRow(doc, AGENT_COLS, cells, doc.y, rH, false);
  }
}

// Failures table

function drawFailuresTable(doc: PDFKit.PDFDocument, failures: ValidationFailure[]): void {
  const headerCells = FAIL_COLS.map((c) => c.label);
  const hH = rowHeight(doc, FAIL_COLS, headerCells);
  checkPageBreak(doc, hH);
  drawRow(doc, FAIL_COLS, headerCells, doc.y, hH, true);

  for (const f of failures) {
    const location = f.column ? `${f.table}.${f.column}` : f.table;
    const cells = [
      f.severity,
      location,
      f.rule,
      f.detail,
      f.remediation ? 'Yes' : '-',
    ];
    const rH = rowHeight(doc, FAIL_COLS, cells);
    checkPageBreak(doc, rH);
    drawRow(doc, FAIL_COLS, cells, doc.y, rH, false);
  }
}

// Main export

export async function generatePDFReport(
  report: ValidationReport,
  outputDir: string
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });

  const filePath = path.join(outputDir, `${report.runId}.pdf`);

  // bufferPages: true lets us go back and stamp footers after all pages are done
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4', bufferPages: true });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const totalChecked  = Object.values(report.agents).reduce((s, a) => s + (a?.rulesChecked ?? 0), 0);
  const totalPassed   = Object.values(report.agents).reduce((s, a) => s + (a?.rulesPassed  ?? 0), 0);
  const totalFailures = Object.values(report.agents).reduce((s, a) => s + (a?.rulesFailed  ?? 0), 0);

  // Title block
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000')
    .text('Data Quality Validation Report', MARGIN, MARGIN);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#444444')
    .text(`Run ID:     ${report.runId}`)
    .text(`Generated:  ${new Date(report.timestamp).toLocaleString()}`)
    .text(`Duration:   ${(report.durationMs / 1000).toFixed(1)}s`);

  divider(doc);

  // Summary key-value block
  section(doc, 'Summary');

  const sup = report as unknown as Record<string, unknown>;
  const summaryRows: [string, string][] = [
    ['Overall Status',    report.overallStatus],
    ['Go-Live',           report.goLiveBlocked ? 'BLOCKED' : 'CLEAR'],
    ['Rules Checked',     String(totalChecked)],
    ['Rules Passed',      String(totalPassed)],
    ['Rules Failed',      String(totalFailures)],
    ['Tables Validated',  report.config.tablesValidated.join(', ')],
    ['Source',            report.config.sourcetype],
    ['Target',            report.config.targetType],
  ];
  if (sup.userInstruction)    summaryRows.push(['Instruction',     String(sup.userInstruction)]);
  if (sup.urgency)            summaryRows.push(['Urgency',         String(sup.urgency)]);
  if (sup.goLiveRecommendation) summaryRows.push(['Recommendation', String(sup.goLiveRecommendation)]);

  const labelW = 140;
  const valW   = CONTENT_W - labelW - 10;

  for (const [label, value] of summaryRows) {
    const rowY = doc.y;
    // Label
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
      .text(label + ':', MARGIN, rowY, { width: labelW, lineBreak: false });
    // Value — explicit y so it sits on the same line
    doc.fontSize(9).font('Helvetica').fillColor('#222222')
      .text(value, MARGIN + labelW + 10, rowY, { width: valW });
    // Ensure doc.y advances at least one line even for short values
    if (doc.y < rowY + 12) doc.y = rowY + 14;
  }

  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#333333')
    .text(report.summary, MARGIN, doc.y, { width: CONTENT_W });

  divider(doc);

  // Agent results
  section(doc, 'Agent Results');
  drawAgentTable(doc, report.agents);

  divider(doc);

  // Failures
  const agentsWithFailures = Object.entries(report.agents).filter(([, r]) => r && r.failures.length > 0);

  if (agentsWithFailures.length > 0) {
    section(doc, 'Failures');

    for (const [name, result] of agentsWithFailures) {
      if (!result) continue;

      checkPageBreak(doc, 30);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(AGENT_LABELS[name] ?? name, MARGIN, doc.y);
      doc.moveDown(0.2);

      drawFailuresTable(doc, result.failures);
      doc.moveDown(0.5);
    }

    divider(doc);
  }

  // Skipped stages
  const skipped = sup.skippedStages as string[] | undefined;
  if (skipped && skipped.length > 0) {
    section(doc, 'Skipped Stages');
    for (const s of skipped) {
      checkPageBreak(doc, 14);
      doc.fontSize(9).font('Helvetica').fillColor('#444444').text(`- ${s}`, MARGIN, doc.y, { width: CONTENT_W });
    }
    divider(doc);
  }

  // Root cause analysis
  if (report.rootCauseAnalysis) {
    section(doc, 'Root Cause Analysis');
    doc.fontSize(9).font('Helvetica').fillColor('#222222')
      .text(report.rootCauseAnalysis, MARGIN, doc.y, { width: CONTENT_W });
    divider(doc);
  }

  if (report.recommendedActions && report.recommendedActions.length > 0) {
    section(doc, 'Recommended Actions');
    report.recommendedActions.forEach((action, i) => {
      checkPageBreak(doc, 14);
      doc.fontSize(9).font('Helvetica').fillColor('#222222')
        .text(`${i + 1}. ${action}`, MARGIN, doc.y, { width: CONTENT_W });
    });
    divider(doc);
  }

  if (sup.riskAssessment) {
    section(doc, 'Risk Assessment');
    doc.fontSize(9).font('Helvetica').fillColor('#222222')
      .text(String(sup.riskAssessment), MARGIN, doc.y, { width: CONTENT_W });
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    const footerY = doc.page.height - 30;
    doc.fontSize(7.5).font('Helvetica').fillColor('#888888')
      .text(
        `DQVF - Data Quality Validation Framework   |   Page ${i + 1} of ${total}   |   ${report.runId}`,
        MARGIN, footerY,
        { width: CONTENT_W, align: 'center' }
      );
  }

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  log.info(`PDF report written to: ${filePath}`);
  return filePath;
}
