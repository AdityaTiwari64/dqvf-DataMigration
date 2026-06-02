import type { ValidationReport } from '../types/report.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SlackNotifier');

export async function sendSlackNotification(
  report: ValidationReport,
  webhookUrl: string
): Promise<void> {
  const statusEmoji = report.overallStatus === 'PASS' ? '[OK]' : report.overallStatus === 'FAIL' ? '[FAIL]' : '[WARN]';

  const allFailures = Object.values(report.agents).flatMap((a) => a?.failures ?? []);
  const highCount = allFailures.filter((f) => f.severity === 'HIGH').length;
  const medCount  = allFailures.filter((f) => f.severity === 'MEDIUM').length;

  const topFailures = allFailures
    .sort((a, b) => (a.severity === 'HIGH' ? 0 : 1) - (b.severity === 'HIGH' ? 0 : 1))
    .slice(0, 3)
    .map((f) => `- [${f.severity}] \`${f.table}${f.column ? '.' + f.column : ''}\`: ${f.rule} — ${f.detail}`)
    .join('\n');

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${statusEmoji} DQVF Validation: ${report.overallStatus}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Run ID:*\n\`${report.runId}\`` },
          { type: 'mrkdwn', text: `*Go-Live:*\n${report.goLiveBlocked ? 'BLOCKED' : 'CLEAR'}` },
          { type: 'mrkdwn', text: `*HIGH Failures:*\n${highCount}` },
          { type: 'mrkdwn', text: `*MEDIUM Failures:*\n${medCount}` },
          { type: 'mrkdwn', text: `*Duration:*\n${(report.durationMs / 1000).toFixed(1)}s` },
          { type: 'mrkdwn', text: `*Tables:*\n${report.config.tablesValidated.length}` },
        ],
      },
    ],
  };

  if (topFailures) {
    payload.blocks.push({
      type: 'section',
      // @ts-expect-error Slack block types
      text: { type: 'mrkdwn', text: `*Top Failures:*\n${topFailures}` },
    });
  }

  if (report.summary) {
    payload.blocks.push({
      type: 'section',
      // @ts-expect-error Slack block types
      text: { type: 'mrkdwn', text: `*Summary:*\n${report.summary}` },
    });
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }

  log.info('Slack notification sent');
}
