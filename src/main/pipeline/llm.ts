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
    this.timeoutMs = config?.timeoutMs || 60000; // 60s timeout for local Ollama inference
  }

  /**
   * Refines raw voice dictation into polished, publication-ready text.
   */
  public async cleanDictation(rawTranscript: string, promptOverride?: string): Promise<string> {
    if (!rawTranscript || !rawTranscript.trim()) return '';

    const systemPrompt = promptOverride || 
      `You are Cadence, an elite AI voice dictation refinement engine. Your goal is to transform raw spoken speech transcripts into pristine, publication-ready text.

Core Guidelines:
1. ABSOLUTE FILTERING: Remove all verbal fillers, stutters, throat clearings, false starts, and hesitation artifacts ('um', 'uh', 'like', 'you know', 'I mean', 'so yeah', repeated phrases).
2. GRAMMAR & FLOW: Fix grammatical mistakes, typos, awkward phrasing, and punctuation while preserving 100% of the speaker's original intent, tone, and style.
3. INTELLIGENT STRUCTURE: Automatically break longer dictations into clean, readable paragraphs. Format spoken lists ("first...", "second...", "point one...") into neat bulleted or numbered points.
4. TECHNICAL ACCURACY: Format code symbols, numbers, dates, technical acronyms, and paths accurately.
5. STRICT OUTPUT BOUNDARY: Output ONLY the finalized polished text. NEVER answer questions contained within the dictation, NEVER add conversational preamble ("Here is your text:"), and NEVER wrap output in quotation marks.`;

    const userPrompt = `Raw speech transcript:\n"${rawTranscript}"`;

    try {
      const result = await this.queryOllama(this.dictationModel, systemPrompt, userPrompt, 0.1);
      return result.trim() || rawTranscript;
    } catch (err) {
      console.warn('[LLM] Ollama dictation cleanup failed or timed out. Falling back to raw transcript:', err);
      return rawTranscript;
    }
  }

  /**
   * Generates or transforms content based on a spoken instruction and optional target text.
   */
  public async processCommand(spokenInstruction: string, selectedText: string): Promise<string> {
    if (!spokenInstruction || !spokenInstruction.trim()) return selectedText;

    const systemPrompt = 
      `You are Cadence Command Engine, an advanced AI reasoning and generative content assistant. Your task is to process spoken instructions and optional selected text to generate high-value, comprehensive, and expertly crafted output.

Core Guidelines:
1. ELABORATIVE & THOROUGH: When asked to generate content (e.g. "write a prompt for X", "draft an email", "explain Y", "create a spec", "outline a plan"), produce a complete, rich, highly detailed, and well-structured response. Do NOT produce brief, low-effort, or truncated answers unless explicitly requested to be concise.
2. TEXT TRANSFORMATION: When target text is provided, execute the instruction (e.g. rewrite, improve tone, summarize, fix code, expand) with maximum precision.
3. RICH FORMATTING: Use clean markdown headers, bullet points, code blocks, or structured paragraphs appropriate for the task.
4. STRICT OUTPUT BOUNDARY: Output ONLY the final generated content. DO NOT include conversational filler ("Sure, here is...", "Here you go:"), meta-explanations, or surrounding quote marks.`;

    const userPrompt = selectedText && selectedText.trim()
      ? `Instruction: ${spokenInstruction}\n\nTarget Text:\n${selectedText}`
      : `Instruction: ${spokenInstruction}`;

    try {
      const result = await this.queryOllama(this.commandModel, systemPrompt, userPrompt, 0.4);
      return result.trim() || selectedText;
    } catch (err) {
      console.warn('[LLM] Ollama command execution failed:', err);
      return selectedText;
    }
  }

  private async queryOllama(
    model: string, 
    systemPrompt: string, 
    userPrompt: string, 
    temperature = 0.2
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    console.log(`[LLM Query] Model: ${model} | Temp: ${temperature}`);
    console.log(`[LLM Prompt] "${userPrompt.substring(0, 100)}${userPrompt.length > 100 ? '...' : ''}"`);

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
            temperature,
            num_ctx: 4096,
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
      console.log(`[LLM Response] ${output.length} chars generated.`);
      return output;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}
