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
    this.timeoutMs = config?.timeoutMs || 60000; // 60s timeout for local Ollama inference
  }

  /**
   * Refines raw voice dictation into polished, publication-ready text.
   */
  /**
   * Refines raw voice dictation into polished, publication-ready text.
   */
  public async cleanDictation(rawTranscript: string, promptOverride?: string): Promise<string> {
    if (!rawTranscript || !rawTranscript.trim()) return '';

    const cleanInput = this.deduplicateBlocks(rawTranscript);

    const systemPrompt = promptOverride || 
      `You are a strict speech transcript cleaner and grammar editor. Your ONLY function is to take raw spoken audio transcript text and output pristine, clean text.

MANDATORY RULES:
1. Output ONLY the cleaned transcript.
2. ABSOLUTELY ZERO CONVERSATIONAL FILLER or META-TALK: NEVER output introductory phrases such as "Please provide...", "I am ready...", "Here is the cleaned...", "Sure!", "Certainly!", "I can help with that...", or "As an AI...".
3. DO NOT ANSWER QUESTIONS: If the spoken transcript contains questions (e.g. "How have you been? Did you eat something?"), DO NOT answer them. Simply output the questions cleanly formatted as transcribed text.
4. DO NOT REPEAT TEXT: Never duplicate sentences, paragraphs, or blocks of text.
5. PRESERVE ORIGINAL LANGUAGE: Output in the exact language spoken by the user (English, Spanish, Hindi, French, German, etc.).`;

    const userPrompt = `Spoken transcript:\n${cleanInput}`;

    try {
      const result = await this.queryOllama(this.dictationModel, systemPrompt, userPrompt, 0.1);
      return this.sanitizeOutput(result, cleanInput);
    } catch (err) {
      console.warn('[LLM] Ollama dictation cleanup failed or timed out. Falling back to raw transcript:', err);
      return this.sanitizeOutput('', cleanInput);
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
      return this.sanitizeOutput(result, selectedText);
    } catch (err) {
      console.warn('[LLM] Ollama command execution failed:', err);
      return selectedText;
    }
  }

  /**
   * Sanitizes LLM output to strip meta-talk, fix punctuation spacing, and deduplicate repeated blocks.
   */
  private sanitizeOutput(llmResult: string, rawInput: string): string {
    if (!llmResult || !llmResult.trim()) return this.deduplicateBlocks(rawInput.trim());

    let cleaned = llmResult.trim();

    // 1. Strip enclosing quotes
    const quotePairs = [
      ['"', '"'],
      ["'", "'"],
      ['“', '”'],
      ['‘', '’'],
      ['`', '`']
    ];

    for (const [start, end] of quotePairs) {
      if (cleaned.startsWith(start) && cleaned.endsWith(end) && cleaned.length >= 2) {
        cleaned = cleaned.substring(start.length, cleaned.length - end.length).trim();
      }
    }

    // 2. Remove assistant meta-chatter sentences
    const metaPatterns = [
      /^(Please provide|I am ready|Certainly|Here is|Sure|As an AI|Here's the|I will|Below is|I'm ready|How can I help|What would you like|Feel free to|Let me know|Transform your dictation|Apply my filtering)[^.!?\n]*[.!?\n]+\s*/gi,
      /^(I understand|Sure thing|Here's your|Here is your|Below is your|This is the)[^.!?\n]*[.!?\n]+\s*/gi
    ];

    for (const pattern of metaPatterns) {
      cleaned = cleaned.replace(pattern, '').trim();
    }

    // 3. Fix missing spaces after punctuation marks (e.g. "while.Please" -> "while. Please")
    cleaned = cleaned.replace(/([.!?])([A-Za-z])/g, '$1 $2');

    // 4. Deduplicate repeated blocks & sentences
    cleaned = this.deduplicateBlocks(cleaned);

    // 5. Fallback safety: If LLM output was pure meta-chatter and became empty, use deduplicated raw input
    if (!cleaned || cleaned.length < 2) {
      return this.deduplicateBlocks(rawInput.trim());
    }

    return cleaned;
  }

  /**
   * Removes repeated adjacent sentences or repeated block duplicates.
   */
  private deduplicateBlocks(text: string): string {
    if (!text) return '';
    let trimmed = text.trim();

    // Check if the whole string is duplicated (e.g. "ABC. ABC.")
    const half = Math.floor(trimmed.length / 2);
    for (let len = half; len >= 8; len--) {
      const part1 = trimmed.substring(0, len).trim();
      const part2 = trimmed.substring(len).trim();
      if (part2 === part1 || part2.startsWith(part1)) {
        trimmed = part1;
        break;
      }
    }

    // Check consecutive duplicate sentences
    const sentences = trimmed.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [trimmed];
    const uniqueSentences: string[] = [];

    for (const s of sentences) {
      const t = s.trim();
      if (!t) continue;
      if (uniqueSentences.length === 0 || uniqueSentences[uniqueSentences.length - 1].trim().toLowerCase() !== t.toLowerCase()) {
        uniqueSentences.push(t);
      }
    }

    return uniqueSentences.join(' ').trim();
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
