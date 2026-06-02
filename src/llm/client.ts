/**
 * Unified LLM client supporting Anthropic Claude and OpenAI GPT.
 * Provides both text and structured (Zod-validated) completion methods.
 * All errors are caught and logged — never throws, never blocks go-live.
 */

import { z, type ZodSchema } from 'zod';
import type { LLMConfig } from '../config/schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('LLMClient');

export class LLMClient {
  private provider: 'anthropic' | 'openai' | 'openrouter';
  private model: string;
  private baseUrl?: string;
  private maxTokens: number;
  private temperature: number;
  private anthropicClient: unknown | null = null;
  private openaiClient: unknown | null = null;

  constructor(config: LLMConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.baseUrl = config.base_url;
    this.maxTokens = config.max_tokens;
    this.temperature = config.temperature;
  }

  /**
   * Initialize the underlying SDK client.
   * Must be called before using chat methods.
   * Returns false if the required API key is missing.
   */
  async initialize(): Promise<boolean> {
    try {
      if (this.provider === 'anthropic') {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          log.warn('ANTHROPIC_API_KEY not set — LLM features will be skipped');
          return false;
        }
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        this.anthropicClient = new Anthropic({ apiKey });
        log.info('Anthropic client initialized', { model: this.model });
        return true;
      } else {
        const apiKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY;
        if (!apiKey) {
          log.warn('OPENAI_API_KEY/LLM_API_KEY not set — LLM features will be skipped');
          return false;
        }
        const { default: OpenAI } = await import('openai');
        const baseURL = this.baseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL;
        this.openaiClient = new OpenAI({ apiKey, baseURL });
        log.info('OpenAI-compatible client initialized', {
          model: this.model,
          baseURL: baseURL ?? 'default',
        });
        return true;
      }
    } catch (error) {
      log.error('Failed to initialize LLM client', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if the client is ready to make API calls.
   */
  get isAvailable(): boolean {
    return this.anthropicClient !== null || this.openaiClient !== null;
  }

  /**
   * Send a chat completion request and return the raw text response.
   * Returns null on any failure (timeout, API error, etc.).
   */
  async chat(systemPrompt: string, userPrompt: string): Promise<string | null> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (this.provider === 'anthropic' && this.anthropicClient) {
          const client = this.anthropicClient as {
            messages: {
              create: (params: {
                model: string;
                max_tokens: number;
                temperature: number;
                system: string;
                messages: Array<{ role: string; content: string }>;
              }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
            };
          };

          const response = await client.messages.create({
            model: this.model,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          });

          const textBlock = response.content.find((c) => c.type === 'text');
          return textBlock?.text ?? null;
        } else if ((this.provider === 'openai' || this.provider === 'openrouter') && this.openaiClient) {
          const client = this.openaiClient as {
            chat: {
              completions: {
                create: (params: {
                  model: string;
                  max_tokens: number;
                  temperature: number;
                  messages: Array<{ role: string; content: string }>;
                }) => Promise<{ choices: Array<{ message: { content: string } }> }>;
              };
            };
          };

          const response = await client.chat.completions.create({
            model: this.model,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          });

          return response.choices[0]?.message?.content ?? null;
        }

        log.warn('No LLM client available');
        return null;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const msg = lastError.message;

        // Fail fast on rate limits (429) and model-not-found (404) — do NOT retry.
        // The OpenAI SDK respects Retry-After headers from OpenRouter (up to 60s),
        // which makes retrying rate-limit errors extremely slow.
        if (msg.includes('429') || msg.includes('rate') || msg.includes('404') || msg.includes('No endpoints')) {
          log.warn('LLM request failed — not retrying (rate limit or model error)', { error: msg });
          break;
        }

        log.warn(`LLM request failed (attempt ${attempt}/${maxRetries})`, { error: msg });

        if (attempt < maxRetries) {
          // Short fixed delay for transient errors only (not rate limits)
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    log.error('LLM request failed after all retries', { error: lastError?.message });
    return null;
  }


  /**
   * Send a chat request and parse the response as structured JSON,
   * validated against a Zod schema.
   *
   * Returns null if the response is invalid or the LLM is unavailable.
   */
  async chatStructured<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: ZodSchema<T>
  ): Promise<T | null> {
    const enhancedSystem =
      systemPrompt +
      '\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanation — just the raw JSON object.';

    const rawResponse = await this.chat(enhancedSystem, userPrompt);
    if (!rawResponse) return null;

    try {
      // Try to extract JSON from the response (handle markdown code fences)
      let jsonString = rawResponse.trim();
      const jsonMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonString = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(jsonString);
      const result = schema.safeParse(parsed);

      if (!result.success) {
        log.warn('LLM response failed Zod validation', {
          errors: result.error.issues.map((i) => i.message),
        });
        return null;
      }

      return result.data;
    } catch (error) {
      log.warn('Failed to parse LLM response as JSON', {
        error: error instanceof Error ? error.message : String(error),
        responsePreview: rawResponse.substring(0, 200),
      });
      return null;
    }
  }
}

/**
 * Create an LLM client from config. Returns null if initialization fails.
 */
export async function createLLMClient(config: LLMConfig): Promise<LLMClient | null> {
  const client = new LLMClient(config);
  const success = await client.initialize();
  return success ? client : null;
}
