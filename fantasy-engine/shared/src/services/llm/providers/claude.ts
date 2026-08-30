import Anthropic from '@anthropic-ai/sdk';
import { BaseLLMProvider } from './base.js';
import { LLMMessage, LLMTool, LLMResponse, LLMConfig } from '../types.js';

export class ClaudeProvider extends BaseLLMProvider {
  private client: Anthropic;
  
  constructor(config: LLMConfig) {
    super(config);
    this.client = new Anthropic({
      apiKey: config.api_key,
      baseURL: config.base_url
    });
  }
  
  get name(): string {
    return 'Claude (Anthropic)';
  }
  
  get models(): string[] {
    return [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5-20251001'
    ];
  }
  
  async chat(
    messages: LLMMessage[],
    options?: {
      tools?: LLMTool[];
      max_tokens?: number;
      temperature?: number;
      tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    }
  ): Promise<LLMResponse> {
    return this.withRetry(async () => {
      const startTime = Date.now();
      
      // Convert messages to Anthropic format
      const anthropicMessages = this.standardizeMessages(messages).map(msg => ({
        role: msg.role === 'system' ? 'user' : msg.role,
        content: msg.content
      }));
      
      // Handle system message separately
      const systemMessage = messages.find(m => m.role === 'system')?.content;
      const nonSystemMessages = anthropicMessages.filter(m => 
        !(messages.find(orig => orig.content === m.content)?.role === 'system')
      );
      
      // Note: current Claude models (Sonnet 5 / Opus 5 / Fable 5) reject the
      // temperature parameter with a 400, so it is intentionally not sent.
      const requestOptions: any = {
        model: this.config.model,
        max_tokens: options?.max_tokens || this.config.max_tokens || 4000,
        messages: nonSystemMessages
      };
      
      if (systemMessage) {
        requestOptions.system = systemMessage;
      }
      
      // Add tools if provided
      if (options?.tools && options.tools.length > 0) {
        requestOptions.tools = options.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema
        }));
        
        if (options.tool_choice && options.tool_choice !== 'auto') {
          if (options.tool_choice === 'none') {
            requestOptions.tool_choice = { type: 'any' };
          } else if (typeof options.tool_choice === 'object') {
            requestOptions.tool_choice = {
              type: 'tool',
              name: options.tool_choice.function.name
            };
          }
        }
      }
      
      const response = await this.client.messages.create(requestOptions);
      const responseTime = Date.now() - startTime;
      
      // Extract content and tool calls
      let content = '';
      const tool_calls: any[] = [];
      
      for (const contentBlock of response.content) {
        if (contentBlock.type === 'text') {
          content += contentBlock.text;
        } else if (contentBlock.type === 'tool_use') {
          tool_calls.push({
            name: contentBlock.name,
            arguments: contentBlock.input
          });
        }
      }
      
      return {
        content: content.trim(),
        tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens
        },
        finish_reason: response.stop_reason as any,
        metadata: {
          provider: this.name,
          model: this.config.model,
          response_time_ms: responseTime
        }
      };
    });
  }
  
  getPricing(): { input_cost_per_token: number; output_cost_per_token: number; currency: string } {
    // Pricing as of mid 2026 (in USD per million tokens, converted to per token)
    const pricingMap: Record<string, any> = {
      'claude-sonnet-5': { input: 2.00, output: 10.00 },
      'claude-opus-5': { input: 5.00, output: 25.00 },
      'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 }
    };

    const pricing = pricingMap[this.config.model] || pricingMap['claude-sonnet-5'];
    
    return {
      input_cost_per_token: pricing.input / 1000000,
      output_cost_per_token: pricing.output / 1000000,
      currency: 'USD'
    };
  }
}