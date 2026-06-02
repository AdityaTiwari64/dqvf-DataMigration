import { BaseAgent } from './base-agent.js';
import type { AgentContext } from '../types/agent.js';
import type { TableConfig } from '../config/schema.js';
import type { RuleCheckResult } from '../types/report.js';
import { createLogger } from '../utils/logger.js';
import {
  SEMANTIC_MAPPING_SYSTEM_PROMPT,
  SemanticMappingResultSchema,
  buildSemanticMappingPrompt,
} from '../llm/prompts/semantic-mapping.js';
import {
  PII_DETECTION_SYSTEM_PROMPT,
  PIIDetectionResultSchema,
  buildPIIDetectionPrompt,
} from '../llm/prompts/pii-detection.js';
import {
  BUSINESS_RULES_SYSTEM_PROMPT,
  BusinessRuleResultSchema,
  buildBusinessRulesPrompt,
} from '../llm/prompts/business-rules.js';

export class SemanticValidationAgent extends BaseAgent {
  readonly name = 'semantic';
  readonly description = 'LLM-powered semantic reasoning for schema mapping, PII detection, and business rule validation';

  constructor() {
    super();
    this.log = createLogger('SemanticValidationAgent');
  }

  protected async validateTable(
    ctx: AgentContext,
    table: TableConfig
  ): Promise<RuleCheckResult[]> {
    const results: RuleCheckResult[] = [];
    const { sourceDb, targetDb, llm } = ctx;

    if (!llm || !llm.isAvailable) {
      this.log.warn('LLM not available — all semantic rules will be SKIPPED');
      results.push(this.skip('semantic_schema_mapping', table.name, 'LLM unavailable'));
      results.push(this.skip('business_rule_preservation', table.name, 'LLM unavailable'));
      results.push(this.skip('cross_column_consistency', table.name, 'LLM unavailable'));
      results.push(this.skip('pii_detection', table.name, 'LLM unavailable'));
      return results;
    }

    // Rule 1: AI Semantic Schema Mapping
    try {
      const sourceDDL = await sourceDb.getTableDDL(table.name, table.schema);
      const targetDDL = await targetDb.getTableDDL(table.name, table.schema);

      const prompt = buildSemanticMappingPrompt(sourceDDL, targetDDL);
      const mapping = await llm.chatStructured(
        SEMANTIC_MAPPING_SYSTEM_PROMPT,
        prompt,
        SemanticMappingResultSchema
      );

      if (!mapping) {
        results.push(this.skip('semantic_schema_mapping', table.name, 'LLM returned no valid response'));
      } else {
        // Check for low-confidence mappings and unmapped columns
        const lowConfidence = mapping.mappings.filter((m) => m.confidence < 0.7);
        const incompatibleTypes = mapping.mappings.filter((m) => !m.typeCompatible);

        if (mapping.unmappedSource.length > 0) {
          results.push(
            this.fail('semantic_schema_mapping', table.name,
              `${mapping.unmappedSource.length} source columns have no target equivalent: ${mapping.unmappedSource.join(', ')}`,
              'HIGH',
              'Review unmapped columns — they may represent data loss')
          );
        } else if (incompatibleTypes.length > 0) {
          const details = incompatibleTypes
            .map((m) => `${m.sourceColumn} → ${m.targetColumn}: ${m.reason}`)
            .join('; ');
          results.push(
            this.fail('semantic_schema_mapping', table.name,
              `${incompatibleTypes.length} type-incompatible mappings: ${details}`,
              'HIGH',
              'Adjust target column types to match source semantics')
          );
        } else if (lowConfidence.length > 0) {
          results.push(
            this.warn('semantic_schema_mapping', table.name,
              `${lowConfidence.length} low-confidence schema mappings detected`,
              'MEDIUM')
          );
        } else {
          results.push(
            this.pass('semantic_schema_mapping', table.name,
              `All ${mapping.mappings.length} columns mapped with high confidence`)
          );
        }

        if (mapping.warnings && mapping.warnings.length > 0) {
          for (const warning of mapping.warnings) {
            results.push(
              this.warn('semantic_schema_mapping', table.name, `LLM warning: ${warning}`, 'MEDIUM')
            );
          }
        }
      }
    } catch (error) {
      results.push(this.skip('semantic_schema_mapping', table.name,
        `Error: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 2: Business Rule Preservation
    const businessRules = table.business_rules ?? [];
    if (businessRules.length > 0) {
      try {
        // Execute each business rule expression on both databases
        const sourceResults: Record<string, unknown> = {};
        const targetResults: Record<string, unknown> = {};

        for (const rule of businessRules) {
          try {
            const srcResult = await sourceDb.executeRaw(rule.expression);
            const tgtResult = await targetDb.executeRaw(rule.expression);
            sourceResults[rule.name] = srcResult[0] ?? null;
            targetResults[rule.name] = tgtResult[0] ?? null;
          } catch {
            sourceResults[rule.name] = 'ERROR';
            targetResults[rule.name] = 'ERROR';
          }
        }

        const prompt = buildBusinessRulesPrompt(table.name, businessRules, sourceResults, targetResults);
        const ruleResult = await llm.chatStructured(
          BUSINESS_RULES_SYSTEM_PROMPT,
          prompt,
          BusinessRuleResultSchema
        );

        if (!ruleResult) {
          results.push(this.skip('business_rule_preservation', table.name, 'LLM returned no valid response'));
        } else {
          for (const r of ruleResult.results) {
            if (r.status === 'FAIL') {
              results.push(
                this.fail('business_rule_preservation', table.name,
                  `Rule "${r.ruleName}" failed: ${r.explanation}${r.drift ? ` (${r.drift})` : ''}`,
                  'HIGH',
                  r.recommendation ?? 'Review business rule implementation')
              );
            } else if (r.status === 'WARN') {
              results.push(
                this.warn('business_rule_preservation', table.name,
                  `Rule "${r.ruleName}": ${r.explanation}`, 'MEDIUM')
              );
            } else {
              results.push(
                this.pass('business_rule_preservation', table.name,
                  `Rule "${r.ruleName}" passed: ${r.explanation}`)
              );
            }
          }
        }
      } catch (error) {
        results.push(this.skip('business_rule_preservation', table.name,
          `Error: ${error instanceof Error ? error.message : String(error)}`));
      }
    } else {
      results.push(
        this.skip('business_rule_preservation', table.name, 'No business rules configured')
      );
    }

    // Rule 3: Cross-Column Semantic Consistency
    try {
      const sampleRows = await targetDb.getSampleRows(table.name, 100, table.schema);
      const columns = await targetDb.getColumns(table.name, table.schema);

      // Check common semantic rules
      const dateColumns = columns.filter((c) =>
        c.dataType.toLowerCase().includes('date') || c.dataType.toLowerCase().includes('time')
      );

      if (dateColumns.length >= 2) {
        // Check for temporal ordering (e.g., created_at <= updated_at)
        const createdCol = dateColumns.find((c) =>
          c.name.toLowerCase().includes('creat') || c.name.toLowerCase().includes('insert')
        );
        const updatedCol = dateColumns.find((c) =>
          c.name.toLowerCase().includes('updat') || c.name.toLowerCase().includes('modif')
        );

        if (createdCol && updatedCol) {
          let violations = 0;
          for (const row of sampleRows) {
            const created = row[createdCol.name];
            const updated = row[updatedCol.name];
            if (created && updated && new Date(created as string) > new Date(updated as string)) {
              violations++;
            }
          }

          if (violations > 0) {
            results.push(
              this.fail('cross_column_consistency', table.name,
                `${violations} rows where ${createdCol.name} > ${updatedCol.name} (temporal order violation)`,
                'MEDIUM',
                `UPDATE "${table.name}" SET "${updatedCol.name}" = "${createdCol.name}" WHERE "${createdCol.name}" > "${updatedCol.name}"`,
                `${createdCol.name}, ${updatedCol.name}`)
            );
          } else {
            results.push(
              this.pass('cross_column_consistency', table.name,
                `Temporal ordering correct: ${createdCol.name} ≤ ${updatedCol.name}`)
            );
          }
        }
      }
    } catch (error) {
      results.push(this.skip('cross_column_consistency', table.name,
        `Error: ${error instanceof Error ? error.message : String(error)}`));
    }

    // Rule 5: PII / Compliance Detection
    try {
      const columns = await targetDb.getColumns(table.name, table.schema);
      const sampleRows = await targetDb.getSampleRows(table.name, 10, table.schema);

      const prompt = buildPIIDetectionPrompt(
        table.name,
        columns.map((c) => ({ name: c.name, dataType: c.fullType })),
        sampleRows
      );

      const piiResult = await llm.chatStructured(
        PII_DETECTION_SYSTEM_PROMPT,
        prompt,
        PIIDetectionResultSchema
      );

      if (!piiResult) {
        results.push(this.skip('pii_detection', table.name, 'LLM returned no valid response'));
      } else {
        if (piiResult.piiFields.length === 0) {
          results.push(
            this.pass('pii_detection', table.name, 'No PII fields detected')
          );
        } else {
          for (const field of piiResult.piiFields) {
            const regs = field.regulations.join(', ');
            results.push(
              this.fail('pii_detection', table.name,
                `PII detected: "${field.columnName}" is ${field.piiType} (confidence=${(field.confidence * 100).toFixed(0)}%, regulations: ${regs})`,
                'HIGH',
                `${field.recommendation}: Apply ${field.recommendation} to column "${field.columnName}" for ${regs} compliance`,
                field.columnName,
                { piiType: field.piiType, regulations: field.regulations, confidence: field.confidence })
            );
          }
        }
      }
    } catch (error) {
      results.push(this.skip('pii_detection', table.name,
        `Error: ${error instanceof Error ? error.message : String(error)}`));
    }

    return results;
  }
}
