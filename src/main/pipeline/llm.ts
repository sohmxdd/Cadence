import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_FILE = path.join(os.tmpdir(), 'cadence-app.log');
function logLLM(msg: string) {
  const line = `[${new Date().toISOString()}] [LLMEngine] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

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
    this.dictationModel = config?.dictationModel || 'gemma3:4b';
    this.commandModel = config?.commandModel || 'gemma3:4b';
    this.timeoutMs = config?.timeoutMs || 60000; // 60s timeout for local Ollama inference
  }

  /**
   * Refines raw voice dictation into polished, publication-ready text.
   */
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
      `You are a strict text cleanup tool. Your ONLY task is to take spoken speech transcripts and output clean, polished text.

STRICT RULES:
1. REMOVE ALL FILLER WORDS AND HESITATIONS: Completely delete words like "um", "uh", "like", "you know", "I mean", "so yeah", and repeated words.
2. FIX GRAMMAR & PUNCTUATION: Correct typos, capitalization, and sentence punctuation.
3. OUTPUT ONLY THE FINAL CLEANED TEXT: Do NOT output conversational chatter, explanations, markdown, or quote marks.`;

    const userPrompt = `Spoken transcript:\n${cleanInput}`;

    try {
      logLLM(`[Dictation Prompt Sent]\n--- SYSTEM ---\n${systemPrompt}\n--- USER ---\n${userPrompt}`);
      const result = await this.queryOllama(this.dictationModel, systemPrompt, userPrompt, 0.1);
      logLLM(`[Dictation Raw Ollama Response]\n"${result}"`);
      const sanitized = this.sanitizeOutput(result, cleanInput);
      logLLM(`[Dictation Sanitized Output]\n"${sanitized}"`);
      return sanitized;
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
      `You are a text generation and editing tool operating on the user's behalf. When given an instruction, produce ONLY the final requested text as if the user wrote it themselves. Never present multiple options, commentary, tips, or markdown formatting. If the instruction requires specific information you don't have (such as a name, date, link, or detail not provided), write the sentence in a natural way that doesn't require it — do NOT invent placeholder names (like "Friend's Name", "John", "Your Name"), fake dates, or bracketed text. Output exactly what should be inserted into the document, nothing else.`;

    const userPrompt = selectedText && selectedText.trim()
      ? `Instruction: ${spokenInstruction}\n\nTarget Text:\n${selectedText}`
      : `Instruction: ${spokenInstruction}`;

    try {
      logLLM(`[Command Prompt Sent]\n--- SYSTEM ---\n${systemPrompt}\n--- USER ---\n${userPrompt}`);
      const result = await this.queryOllama(this.commandModel, systemPrompt, userPrompt, 0.2);
      logLLM(`[Command Raw Ollama Response]\n"${result}"`);
      const sanitized = this.sanitizeOutput(result, selectedText);
      logLLM(`[Command Sanitized Output]\n"${sanitized}"`);
      return sanitized;
    } catch (err) {
      console.warn('[LLM] Ollama command execution failed:', err);
      return selectedText;
    }
  }

  /**
   * Sanitizes LLM output to strip meta-talk, markdown syntax, quotes, and preambles.
   */
  private sanitizeOutput(llmResult: string, rawInput: string): string {
    if (!llmResult || !llmResult.trim()) return this.deduplicateBlocks(rawInput.trim());

    let cleaned = llmResult.trim();

    // 1. Strip code block markers
    cleaned = cleaned.replace(/^```[a-z]*\n?/gi, '').replace(/\n?```$/gi, '').trim();

    // 2. Strip enclosing quote characters using explicit Unicode codepoints so curly/smart
    //    quotes are reliably matched regardless of source file encoding.
    //    \u201C = LEFT DOUBLE QUOTATION MARK, \u201D = RIGHT DOUBLE QUOTATION MARK
    //    \u2018 = LEFT SINGLE QUOTATION MARK, \u2019 = RIGHT SINGLE QUOTATION MARK
    cleaned = cleaned.replace(/^[\u201C\u201D\u2018\u2019"'`]+/, '').replace(/[\u201C\u201D\u2018\u2019"'`]+$/, '').trim();

    // 2. Remove assistant meta-chatter sentences & preambles
    const metaPatterns = [
      /^(Here is the (cleaned|refined|final|transformed) (text|output|dictation|transcript|instruction|email|document):?\s*)/gi,
      /^(Here's the (cleaned|refined|final|transformed) (text|output|dictation|transcript|instruction|email|document):?\s*)/gi,
      /^(Sure,?\s*(here is|here's|below is|I have)?\s*)/gi,
      /^(Certainly,?\s*(here is|here's|below is|I have)?\s*)/gi,
      /^(Option \d+:?\s*)/gi,
      /^(Please provide|I am ready|As an AI|Here's the|I will|Below is|I'm ready|How can I help|What would you like)[^.!?\n]*[.!?\n]+\s*/gi,
    ];

    for (const pattern of metaPatterns) {
      cleaned = cleaned.replace(pattern, '').trim();
    }

    // 3. Strip markdown headers (# ## ###)
    cleaned = cleaned.replace(/^#+\s+/gm, '');

    // 4. Strip bold and italic markdown markup, in strict order:
    //    a. **bold** pairs first
    cleaned = cleaned.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    //    b. *italic* pairs (safe to run after bold — ** already consumed)
    cleaned = cleaned.replace(/\*([^*\n]+)\*/g, '$1');
    //    c. Lone unpaired ** or * left over (e.g. opening **Subject: with no closing)
    cleaned = cleaned.replace(/\*\*/g, '').replace(/\*/g, '');
    //    d. __bold__ and _italic_ underscore variants
    cleaned = cleaned.replace(/__([^_\n]+)__/g, '$1');
    cleaned = cleaned.replace(/_([^_\n]+)_/g, '$1');

    // 5. Deduplicate repeated blocks & sentences
    cleaned = this.deduplicateBlocks(cleaned);

    // 6. Fix missing spaces after punctuation — runs LAST, after all stripping and dedup,
    //    so it catches any adjacencies introduced by the strip operations above.
    cleaned = cleaned.replace(/([.!?])([A-Za-z])/g, '$1 $2');

    return cleaned.trim();
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
