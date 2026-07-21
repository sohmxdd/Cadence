import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

export interface STTOptions {
  whisperBinaryPath?: string;
  modelPath?: string;
}

export class STTEngine {
  private whisperBinaryPath: string;
  private modelPath: string;

  constructor(options?: STTOptions) {
    // Resolve whisper binary path
    this.whisperBinaryPath = options?.whisperBinaryPath || this.getDefaultBinaryPath();
    this.modelPath = options?.modelPath || path.join(process.cwd(), 'models', 'ggml-base.en.bin');
  }

  private getDefaultBinaryPath(): string {
    const isPackaged = app ? app.isPackaged : false;
    if (isPackaged) {
      return path.join(process.resourcesPath, 'whisper', 'whisper-cli.exe');
    }
    return path.join(process.cwd(), 'models', 'whisper-cli.exe');
  }

  /**
   * Save PCM 16-bit 16kHz mono Buffer chunks to a standard WAV file header
   */
  public saveWavFile(pcmChunks: Buffer[], outputPath: string): void {
    const pcmData = Buffer.concat(pcmChunks);
    const numChannels = 1;
    const sampleRate = 16000;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const chunkSize = 36 + dataSize;

    const wavHeader = Buffer.alloc(44);
    // RIFF chunk descriptor
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(chunkSize, 4);
    wavHeader.write('WAVE', 8);

    // fmt sub-chunk
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    wavHeader.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    const fullWavBuffer = Buffer.concat([wavHeader, pcmData]);
    fs.writeFileSync(outputPath, fullWavBuffer);
  }

  /**
   * Run whisper.cpp CLI binary to transcribe WAV audio file
   */
  public async transcribe(wavFilePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.whisperBinaryPath)) {
        console.warn(`[STT] Whisper binary not found at ${this.whisperBinaryPath}. Returning mock/raw indicator.`);
        return resolve('Whisper CLI executable missing. Please download whisper-cli.exe into models/');
      }

      if (!fs.existsSync(this.modelPath)) {
        console.warn(`[STT] Whisper model not found at ${this.modelPath}.`);
        return resolve('Whisper model missing. Please download ggml-base.en.bin into models/');
      }

      const args = [
        '-m', this.modelPath,
        '-f', wavFilePath,
        '-nt', // No timestamps
        '--no-prints',
        '-language', 'en',
      ];

      console.log(`[STT] Running whisper command: ${this.whisperBinaryPath} ${args.join(' ')}`);
      const child = spawn(this.whisperBinaryPath, args);

      let stdoutText = '';
      let stderrText = '';

      child.stdout.on('data', (chunk) => {
        stdoutText += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        console.error('[STT] Failed to spawn whisper CLI:', err);
        reject(err);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          console.warn(`[STT] Whisper process exited with code ${code}. Stderr: ${stderrText}`);
        }
        const cleaned = stdoutText.trim().replace(/\[\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}\.\d{3}\]/g, '').trim();
        resolve(cleaned);
      });
    });
  }
}
