import { LLMManager } from '../services/llm/manager.js';
import { LLMConfig } from '../services/llm/types.js';

let llmManager: LLMManager | null = null;

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

export class LLMConfigManager {
  private async detectAndCreateConfig(): Promise<LLMConfig> {
    const claudeKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (!claudeKey) {
      throw new Error('No Claude API key found in environment variables (CLAUDE_API_KEY or ANTHROPIC_API_KEY)');
    }

    return {
      provider: 'claude',
      model: process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
      api_key: claudeKey,
      max_tokens: 1000
    };
  }

  private async getLLMManager(): Promise<LLMManager> {
    if (!llmManager) {
      llmManager = new LLMManager();
      const config = await this.detectAndCreateConfig();
      console.log(`🤖 Initializing LLM with provider: ${config.provider}`);
      const success = await llmManager.initialize(config);
      if (!success) {
        throw new Error(`Failed to initialize LLM manager with ${config.provider}`);
      }
    }
    return llmManager;
  }

  async initializeLLM(): Promise<boolean> {
    try {
      await this.getLLMManager();
      return true;
    } catch (error) {
      console.error('Failed to initialize LLM:', error);
      return false;
    }
  }

  getCurrentInfo(): any {
    if (!llmManager) {
      return { provider: 'none', initialized: false };
    }
    const pricing = llmManager.getCurrentPricing();
    return {
      provider: pricing?.provider || 'unknown',
      model: pricing?.model || 'unknown',
      initialized: true
    };
  }

  async testConfiguration(): Promise<{ success: boolean; response?: string; error?: string }> {
    try {
      const manager = await this.getLLMManager();
      const testPrompt = 'Say "LLM test successful" if you can read this.';
      const response = await manager.analyzeFantasyData({
        context: {
          week: 1,
          day_of_week: 'Monday',
          action_type: 'analysis',
          priority: 'low'
        },
        data: {
          rosters: [],
          injuries: [],
          waiver_targets: [],
          league_info: [{ test_prompt: testPrompt }]
        }
      });

      return {
        success: true,
        response: response.summary
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async generateResponse(prompt: string): Promise<{ content: string; cost?: number }> {
    const manager = await this.getLLMManager();

    try {
      const provider = manager.getCurrentProvider();
      if (!provider) {
        throw new Error('No LLM provider initialized');
      }

      const response = await provider.chat([
        { role: 'user', content: prompt }
      ], {
        max_tokens: 1000
      });

      return {
        content: response.content || 'No response generated',
        cost: response.usage?.total_tokens ? response.usage.total_tokens * 0.000001 : 0.001 // Rough estimate
      };
    } catch (directError: any) {
      console.warn('Direct LLM call failed, trying fantasy analysis method:', directError.message);

      const response = await manager.analyzeFantasyData({
        context: {
          week: 1,
          day_of_week: 'Monday',
          action_type: 'analysis',
          priority: 'medium'
        },
        data: {
          rosters: [],
          injuries: [],
          waiver_targets: [],
          league_info: [{ custom_prompt: prompt }]
        }
      });

      return {
        content: response.summary || 'Analysis completed',
        cost: response.cost_estimate?.estimated_cost
      };
    }
  }
}

export const llmConfig = new LLMConfigManager();
