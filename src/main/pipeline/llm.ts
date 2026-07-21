export interface LLMConfig {
  ollamaUrl?: string;
  dictationModel?: string;
  commandModel?: string;
  timeoutMs?: number;
}

export class LLMEngine {
  private ollamaUrl: string;
  private dictationModel: string;
  private commandModel: string;
  private timeoutMs: number;

  constructor(config?: LLMConfig) {
    this.ollamaUrl = config?.ollamaUrl || 'http://localhost:11434';
    this.dictationModel = config?.dictationModel || 'gemma3:1b';
    this.commandModel = config?.commandModel || 'gemma3:1b';
    this.timeoutMs = config?.timeoutMs || 5000;
  }

  /**
   * Clean up raw dictation transcript (grammar, casing, punctuation, remove stutters/fillers)
   */
  public async cleanDictation(rawTranscript: string, promptOverride?: string): Promise<string> {
    if (!rawTranscript || !rawTranscript.trim()) return '';

    const systemPrompt = promptOverride || 
      `You are a precise voice dictation assistant. Clean up the provided raw speech transcript into polished, natural written text.
Rules:
1. Fix grammar, punctuation, and capitalization.
2. Remove verbal filler words (e.g., 'um', 'uh', 'like', 'you know', 'stutters').
3. Keep the original wording, tone, and intended meaning intact.
4. Output ONLY the finalized text. Do NOT add quotes, greetings, or conversational commentary.`;

    const userPrompt = `Raw transcript: "${rawTranscript}"`;

    try {
      const result = await this.queryOllama(this.dictationModel, systemPrompt, userPrompt);
      return result.trim() || rawTranscript;
    } catch (err) {
      console.warn('[LLM] Ollama cleanup failed or timed out. Falling back to raw transcript:', err);
      return rawTranscript;
    }
  }

  /**
   * Apply spoken command instruction to existing text (Command Mode)
   */
  public async processCommand(spokenInstruction: string, selectedText: string): Promise<string> {
    if (!spokenInstruction || !spokenInstruction.trim()) return selectedText;

    const systemPrompt = `You are a text transformation assistant. Apply the user's spoken instruction to the target text.
Rules:
1. Execute the instruction precisely (e.g. rewrite, reformat, summarize, translate, change tone).
2. Output ONLY the resulting transformed text. No conversational preamble, explanation, or markdown wrappers.`;

    const userPrompt = `Instruction: ${spokenInstruction}\nTarget Text:\n${selectedText}`;

    try {
      const result = await this.queryOllama(this.commandModel, systemPrompt, userPrompt);
      return result.trim() || selectedText;
    } catch (err) {
      console.warn('[LLM] Ollama command execution failed:', err);
      return selectedText;
    }
  }

  private async queryOllama(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          prompt: userPrompt,
          stream: false,
          options: {
            temperature: 0.2,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Ollama returned status ${response.status}`);
      }

      const data = await response.json();
      return data.response || '';
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}
