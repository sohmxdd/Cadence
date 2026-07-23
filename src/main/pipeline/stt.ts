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
    this.whisperBinaryPath = options?.whisperBinaryPath || this.getDefaultBinaryPath();
    this.modelPath = options?.modelPath || this.getDefaultModelPath();
  }

  private getDefaultModelPath(): string {
    const isPackaged = app ? app.isPackaged : false;
    const baseDir = isPackaged ? process.resourcesPath : process.cwd();
    
    // Support multilingual models (e.g. ggml-base.bin, ggml-small.bin) with fallback to ggml-base.en.bin
    const candidateModels = [
      'ggml-base.bin',
      'ggml-small.bin',
      'ggml-medium.bin',
      'ggml-large-v3.bin',
      'ggml-base.en.bin'
    ];

    for (const modelName of candidateModels) {
      const modelP = path.join(baseDir, 'models', modelName);
      if (fs.existsSync(modelP)) return modelP;
    }

    return path.join(baseDir, 'models', 'ggml-base.en.bin');
  }

  private getDefaultBinaryPath(): string {
    const isPackaged = app ? app.isPackaged : false;
    if (isPackaged) {
      const pkgCliPath = path.join(process.resourcesPath, 'models', 'whisper-cli.exe');
      if (fs.existsSync(pkgCliPath)) return pkgCliPath;
      return path.join(process.resourcesPath, 'models', 'main.exe');
    }
    const cliPath = path.join(process.cwd(), 'models', 'whisper-cli.exe');
    if (fs.existsSync(cliPath)) return cliPath;
    const mainPath = path.join(process.cwd(), 'models', 'main.exe');
    if (fs.existsSync(mainPath)) return mainPath;
    return cliPath;
  }

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
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(chunkSize, 4);
    wavHeader.write('WAVE', 8);

    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);

    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    const fullWavBuffer = Buffer.concat([wavHeader, pcmData]);
    fs.writeFileSync(outputPath, fullWavBuffer);
  }

  public async transcribe(wavFilePath: string, language = 'auto'): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.whisperBinaryPath)) {
        console.warn(`[STT] Whisper binary not found at ${this.whisperBinaryPath}.`);
        return resolve('Whisper CLI executable missing.');
      }

      if (!fs.existsSync(this.modelPath)) {
        console.warn(`[STT] Whisper model not found at ${this.modelPath}.`);
        return resolve('Whisper model missing.');
      }

      const args = [
        '-m', this.modelPath,
        '-f', wavFilePath,
        '-nt',
        '--no-prints',
        '-l', language,
        '-sns',                    // Suppress non-speech tokens (post-pass, light filter)
        '--no-speech-thold', '0.9', // Only suppress if model is >90% sure there's no speech
        // NOTE: --vad removed — whisper.cpp's pre-pass VAD misreads real speech from
        // mic-to-buffer pipeline and silently drops entire segments with no stdout output
      ];

      console.log(`[STT] Spawning whisper.cpp: ${this.whisperBinaryPath} ${args.join(' ')}`);
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
        if (stderrText.trim()) {
          console.log(`[STT] whisper.cpp stderr: ${stderrText.trim().substring(0, 300)}`);
        }
        if (code !== 0) {
          console.warn(`[STT] Whisper process exited with code ${code}.`);
        }
        const cleaned = stdoutText.trim().replace(/\[\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}\.\d{3}\]/g, '').trim();
        console.log(`[STT] whisper.cpp stdout result: "${cleaned}"`);
        resolve(cleaned);
      });
    });
  }
}
