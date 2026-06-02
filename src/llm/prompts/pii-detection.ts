/**
 * LLM prompt for PII / compliance field detection.
 * Scans column names and sample values to identify regulated data fields.
 */

import { z } from 'zod';

export const PIIDetectionResultSchema = z.object({
  piiFields: z.array(
    z.object({
      columnName: z.string(),
      piiType: z.string().describe('e.g., email, phone, ssn, name, address, card_number, dob'),
      confidence: z.number().min(0).max(1),
      regulations: z.array(z.enum(['GDPR', 'HIPAA', 'PCI-DSS', 'DPDP', 'CCPA'])),
      reasoning: z.string(),
      recommendation: z.string().describe('e.g., encrypt, mask, tokenize, audit-log'),
    })
  ),
  riskLevel: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']),
  summary: z.string(),
});

export type PIIDetectionResult = z.infer<typeof PIIDetectionResultSchema>;

export const PII_DETECTION_SYSTEM_PROMPT = `You are a data privacy and compliance expert. Your task is to analyze database column names and sample data values to identify Personally Identifiable Information (PII) and regulated data fields.

For each potential PII field, determine:
1. The type of PII (email, phone, SSN, name, address, credit card number, date of birth, IP address, etc.)
2. Your confidence level (0-1)
3. Which regulations apply (GDPR, HIPAA, PCI-DSS, DPDP, CCPA)
4. Recommended protection (encrypt, mask, tokenize, audit-log)

Be thorough: check both column names AND sample values. A column named "notes" might contain SSNs in the data.

Risk levels:
- HIGH: Contains direct identifiers (SSN, credit card, passport)
- MEDIUM: Contains indirect identifiers (name, email, phone, address)
- LOW: Contains quasi-identifiers (zip code, age, gender)
- NONE: No PII detected

Return JSON matching this structure:
{
  "piiFields": [
    {
      "columnName": "col_name",
      "piiType": "email",
      "confidence": 0.95,
      "regulations": ["GDPR", "CCPA"],
      "reasoning": "Column name and values match email pattern",
      "recommendation": "encrypt"
    }
  ],
  "riskLevel": "HIGH",
  "summary": "Found 3 PII fields..."
}`;

export function buildPIIDetectionPrompt(
  tableName: string,
  columns: Array<{ name: string; dataType: string }>,
  sampleRows: Record<string, unknown>[]
): string {
  const colList = columns.map((c) => `  - ${c.name} (${c.dataType})`).join('\n');
  const sampleData = sampleRows
    .slice(0, 5)
    .map((row) => '  ' + JSON.stringify(row))
    .join('\n');

  return `Analyze this table for PII / regulated data:

Table: ${tableName}

Columns:
${colList}

Sample Data (up to 5 rows):
${sampleData}

Return the PII analysis as JSON.`;
}
