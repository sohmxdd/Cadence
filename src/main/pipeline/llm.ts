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
    this.dictationModel = config?.dictationModel || 'gemma2:2b';
    this.commandModel = config?.commandModel || 'gemma2:2b';
    this.timeoutMs = config?.timeoutMs || 60000; // 60s timeout — local Ollama on CPU can be slow
  }

  public async cleanDictation(rawTranscript: string, promptOverride?: string): Promise<string> {
    if (!rawTranscript || !rawTranscript.trim()) return '';

    const systemPrompt = promptOverride || 
      `You are Wispr Flow, an ultra-intelligent, production-grade voice dictation system. Transform raw speech transcripts into pristine, publication-ready written text.
Rules:
1. Strip all verbal fillers, stutters, throat clearings, false starts, and hesitation noises (e.g., 'um', 'uh', 'hm', 'like', 'you know', 'I mean', 'so yeah', repeated words).
2. Fix grammar, spelling, punctuation, capitalization, and sentence flow seamlessly while preserving 100% of original meaning.
3. Format numbers, technical terms, lists, and code symbols naturally.
4. Output ONLY the finalized clean text. Do NOT wrap in quotes, do NOT add greetings or conversational preamble.`;

    const userPrompt = `Raw speech transcript: "${rawTranscript}"`;

    try {
      const result = await this.queryOllama(this.dictationModel, systemPrompt, userPrompt);
      return result.trim() || rawTranscript;
    } catch (err) {
      console.warn('[LLM] Ollama cleanup failed or timed out. Falling back to raw transcript:', err);
      return rawTranscript;
    }
  }

  public async processCommand(spokenInstruction: string, selectedText: string): Promise<string> {
    if (!spokenInstruction || !spokenInstruction.trim()) return selectedText;

    const systemPrompt = `You are Wispr Flow Command Engine. Transform text based on the user's spoken instruction.
Rules:
1. Execute the spoken instruction precisely (e.g. rewrite, fix, format, summarize, edit tone).
2. Output ONLY the finalized transformed text. No preamble, no quotes, no markdown code blocks unless requested.`;

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

    console.log(`Calling Ollama at localhost:11434 with prompt: "${userPrompt}"`);

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
      const output = data.response || '';
      console.log(`Ollama returned: "${output.trim()}"`);
      return output;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}
