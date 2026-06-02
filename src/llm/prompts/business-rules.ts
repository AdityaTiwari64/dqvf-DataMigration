/**
 * LLM prompt for business rule preservation validation.
 * Verifies that derived metrics produce identical results on target data.
 */

import { z } from 'zod';

export const BusinessRuleResultSchema = z.object({
  results: z.array(
    z.object({
      ruleName: z.string(),
      status: z.enum(['PASS', 'FAIL', 'WARN', 'SKIPPED']),
      sourceValue: z.string().optional(),
      targetValue: z.string().optional(),
      drift: z.string().optional().describe('e.g., "5.2% difference"'),
      explanation: z.string(),
      recommendation: z.string().optional(),
    })
  ),
  overallStatus: z.enum(['PASS', 'FAIL', 'WARN']),
  summary: z.string(),
});

export type BusinessRuleResult = z.infer<typeof BusinessRuleResultSchema>;

export const BUSINESS_RULES_SYSTEM_PROMPT = `You are a data validation expert. Your task is to analyze business rule expressions and compare their results between a source and target database.

For each business rule:
1. Evaluate whether the rule produces the same result on source and target data
2. If the results differ, compute the drift percentage
3. Provide an explanation of the discrepancy
4. Recommend a fix if the rule fails

Business rules can include:
- Revenue calculations (SUM, AVG of monetary columns)
- SLA metrics (percentage computations)
- Derived fields (formulas involving multiple columns)
- Data integrity rules (conditional dependencies between fields)

Return JSON matching this structure:
{
  "results": [
    {
      "ruleName": "total_revenue",
      "status": "FAIL",
      "sourceValue": "1234567.89",
      "targetValue": "1234000.00",
      "drift": "0.046% difference",
      "explanation": "567.89 in revenue was lost, likely due to rounding during migration",
      "recommendation": "Check decimal precision in target column"
    }
  ],
  "overallStatus": "FAIL",
  "summary": "1 of 3 business rules failed..."
}`;

export function buildBusinessRulesPrompt(
  tableName: string,
  rules: Array<{ name: string; expression: string; description?: string }>,
  sourceResults: Record<string, unknown>,
  targetResults: Record<string, unknown>
): string {
  const ruleList = rules
    .map(
      (r) =>
        `  - ${r.name}: ${r.expression}${r.description ? ` (${r.description})` : ''}`
    )
    .join('\n');

  return `Validate these business rules for table "${tableName}":

Rules:
${ruleList}

Source Results:
${JSON.stringify(sourceResults, null, 2)}

Target Results:
${JSON.stringify(targetResults, null, 2)}

Compare the results and return the validation as JSON.`;
}
