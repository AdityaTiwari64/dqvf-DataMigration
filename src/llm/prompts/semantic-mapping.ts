/**
 * LLM prompt for AI semantic schema mapping.
 * Detects equivalent fields with different names between source and target schemas.
 */

import { z } from 'zod';

export const SemanticMappingResultSchema = z.object({
  mappings: z.array(
    z.object({
      sourceColumn: z.string(),
      targetColumn: z.string(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
      typeCompatible: z.boolean(),
    })
  ),
  unmappedSource: z.array(z.string()).describe('Source columns with no target equivalent'),
  unmappedTarget: z.array(z.string()).describe('Target columns with no source equivalent'),
  warnings: z.array(z.string()).optional(),
});

export type SemanticMappingResult = z.infer<typeof SemanticMappingResultSchema>;

export const SEMANTIC_MAPPING_SYSTEM_PROMPT = `You are a database schema expert. Your task is to analyze two database table schemas (source and target) and identify column-level mappings between them.

For each mapping, determine:
1. Which source column maps to which target column (even if names differ)
2. Your confidence level (0-1) in the mapping
3. Why you believe they are equivalent (semantic reasoning)
4. Whether the data types are compatible

Consider:
- Column names may use different conventions (snake_case vs camelCase, abbreviations vs full names)
- Common equivalences: id/identifier, cust/customer, amt/amount, dt/date, num/number, addr/address
- Data type compatibility (VARCHAR→TEXT is ok, VARCHAR(100)→VARCHAR(30) is a problem)
- Column positions and surrounding context

Return a JSON object matching this exact structure:
{
  "mappings": [
    {
      "sourceColumn": "column_name",
      "targetColumn": "column_name",
      "confidence": 0.95,
      "reason": "explanation",
      "typeCompatible": true
    }
  ],
  "unmappedSource": ["col1", "col2"],
  "unmappedTarget": ["col1"],
  "warnings": ["any concerns"]
}`;

export function buildSemanticMappingPrompt(sourceDDL: string, targetDDL: string): string {
  return `Analyze these two table schemas and identify column mappings:

--- SOURCE SCHEMA ---
${sourceDDL}

--- TARGET SCHEMA ---
${targetDDL}

Return the semantic mapping as JSON.`;
}
