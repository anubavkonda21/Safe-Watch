import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawSegment, RawTranscription, RawWord } from '@/domain/speech/normalize';
import type { SpeechInput, SpeechRequest, SpeechToTextProvider } from '../../application/speechPorts';
import { SpeechError } from '../../application/speechPorts';
import { ProcessError, runBinary } from '../ffmpeg/processRunner';

export interface WhisperCppOptions {
  binaryPath: string;
  modelPath: string;
  /** Label for transcripts, e.g. "ggml-base". */
  modelName: string;
  threads: number;
  /** `alignment` (DTW, default) gives far better word start times than the decoder's own timestamps. */
  wordTiming?: 'alignment' | 'decoder';
  /** Directory for the engine's short-lived output files. Defaults to the OS temp directory. */
  tempRoot?: string;
  maxOutputBytes?: number;
}

/** Upper bound for the last word of a segment when only alignment start times are reliable. */
const MAX_LAST_WORD_SECONDS = 1.0;

/** The abort reason distinguishes a deadline (`timeout`) from an intentional stop (`cancelled`). */
const abortError = (signal: AbortSignal) => new SpeechError(signal.reason === 'timeout' ? 'timeout' : 'cancelled');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Special tokens such as "[_BEG_]", "[_TT_550]" or "<|en|>" carry no speech. */
const isSpecialToken = (text: string) => /^\[_[A-Z]+_?\d*\]$/.test(text.trim()) || /^<\|.*\|>$/.test(text.trim());

/**
 * Maps whisper.cpp's `--output-json-full` document to a RawTranscription.
 * Pure and defensive: anything unexpected is simply absent, and the domain
 * normaliser decides what is usable.
 *  - segment times come from `offsets` (milliseconds → seconds);
 *  - words are rebuilt from tokens: a token whose text starts with a space begins a new word;
 *    decoder timing: a word spans its first token's start to its last token's end;
 *    alignment timing (DTW): a word STARTS at its first token's aligned time (`t_dtw`, centiseconds) and ENDS at the
 *    next word's start; the last word of a segment ends at the segment end but at most `MAX_LAST_WORD_SECONDS`
 *    after its start (an upper bound, not a measurement);
 *  - confidence is the arithmetic mean of the token probabilities (`p`) of the word / segment
 *    (a model probability, not a calibrated confidence).
 * Throws SpeechError('invalid-response') only if the document has no `transcription` array.
 */
export function parseWhisperCppJson(json: unknown, options: { wordTiming?: 'alignment' | 'decoder' } = {}): RawTranscription {
  const alignment = options.wordTiming === 'alignment';
  if (!isObject(json) || !Array.isArray(json.transcription)) throw new SpeechError('invalid-response');
  const result = isObject(json.result) ? json.result : {};
  const segments: RawSegment[] = [];
  for (const seg of json.transcription) {
    if (!isObject(seg) || !isObject(seg.offsets)) { segments.push({ start: undefined, end: undefined, text: seg && (seg as Record<string, unknown>).text }); continue; }
    const words: RawWord[] = [];
    const probabilities: number[] = [];
    let current: { start: number; end: number; text: string; p: number[] } | null = null;
    const flush = () => {
      if (current) words.push({ start: current.start / 1000, end: current.end / 1000, text: current.text.trim(), confidence: current.p.length ? current.p.reduce((a, b) => a + b, 0) / current.p.length : undefined });
      current = null;
    };
    const segEndMs = typeof seg.offsets.to === 'number' ? seg.offsets.to : NaN;
    for (const tok of Array.isArray(seg.tokens) ? seg.tokens : []) {
      if (!isObject(tok) || typeof tok.text !== 'string' || isSpecialToken(tok.text)) continue;
      const off = isObject(tok.offsets) ? tok.offsets : null;
      const decoderFrom = off && typeof off.from === 'number' ? off.from : NaN;
      const decoderTo = off && typeof off.to === 'number' ? off.to : NaN;
      const dtw = typeof tok.t_dtw === 'number' && tok.t_dtw >= 0 ? tok.t_dtw * 10 : NaN; // centiseconds → ms
      const from = alignment && Number.isFinite(dtw) ? dtw : decoderFrom;
      const to = decoderTo;
      const p = typeof tok.p === 'number' ? tok.p : null;
      if (p !== null) probabilities.push(p);
      if (current === null || tok.text.startsWith(' ')) {
        flush();
        current = { start: from, end: to, text: tok.text, p: p === null ? [] : [p] };
      } else {
        current.text += tok.text;
        current.end = to;
        if (p !== null) current.p.push(p);
      }
    }
    flush();
    if (alignment) {
      // End of a word = start of the next one; the last word is capped (see above).
      words.forEach((w, i) => {
        const next = words[i + 1];
        const start = w.start as number;
        const nextStart = next ? (next.start as number) : NaN;
        const cap = start + MAX_LAST_WORD_SECONDS;
        w.end = next && nextStart >= start ? nextStart : Math.min(Number.isFinite(segEndMs) ? segEndMs / 1000 : cap, cap);
        if ((w.end as number) < start) w.end = start;
      });
    }
    segments.push({
      start: typeof seg.offsets.from === 'number' ? seg.offsets.from / 1000 : undefined,
      end: typeof seg.offsets.to === 'number' ? seg.offsets.to / 1000 : undefined,
      text: seg.text,
      confidence: probabilities.length ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length : undefined,
      words: words.length > 0 ? words : undefined,
    });
  }
  return { language: result.language, wordTiming: alignment ? 'alignment' : 'decoder', segments };
}

/**
 * whisper.cpp (local, native, no Python) behind the SpeechToTextProvider port.
 * Audio never leaves the machine: the process reads the WAV and writes a JSON
 * file into a private temp directory that is always removed. Arguments are an
 * argv array (no shell); the only inputs are server-generated paths, the
 * configured model path and a validated language code: no user text reaches
 * the command line. Engine output (stdout/stderr) is discarded.
 */
export class WhisperCppProvider implements SpeechToTextProvider {
  readonly info: { name: string; model: string };
  private available: Promise<boolean> | null = null;

  constructor(private readonly options: WhisperCppOptions) {
    this.info = { name: 'whisper.cpp', model: options.modelName };
  }

  /** DTW preset derived from the model file name (`ggml-base.bin` → `base`); null when it cannot be derived. */
  private dtwPreset(): string | null {
    const m = /^ggml-(tiny|base|small|medium|large-v1|large-v2|large-v3|large-v3-turbo)(\.en)?(?:-q\d.*)?$/.exec(this.options.modelName);
    return m ? `${m[1]}${m[2] ?? ''}` : null;
  }

  private useAlignment(): boolean {
    return (this.options.wordTiming ?? 'alignment') === 'alignment' && this.dtwPreset() !== null;
  }

  /**
   * Removes engine temp directories left behind by a crash (they hold transcript JSON). Called at startup.
   * Only directories created by this class (prefix `sw-whisper-`) and older than `olderThanMs` are touched.
   */
  async cleanupStale(olderThanMs = 60 * 60_000): Promise<number> {
    const root = this.options.tempRoot ?? tmpdir();
    let removed = 0;
    try {
      for (const name of await readdir(root)) {
        if (!name.startsWith('sw-whisper-')) continue;
        const path = join(root, name);
        const info = await stat(path).catch(() => null);
        if (info?.isDirectory() && Date.now() - info.mtimeMs > olderThanMs) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      }
    } catch {
      // Best effort.
    }
    return removed;
  }

  isAvailable(): Promise<boolean> {
    this.available ??= (async () => {
      try {
        await access(this.options.modelPath);
        return (await runBinary(this.options.binaryPath, ['--help'], { maxStdoutBytes: 256 * 1024 })).exitCode === 0;
      } catch {
        return false;
      }
    })();
    return this.available;
  }

  async transcribe(input: SpeechInput, request: SpeechRequest): Promise<RawTranscription> {
    if (!(await this.isAvailable())) throw new SpeechError('unavailable');
    if (request.signal.aborted) throw abortError(request.signal);
    if (request.language !== null && !/^[a-z]{2,3}$/.test(request.language)) throw new SpeechError('unsupported-language');

    const dir = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'sw-whisper-'));
    const outBase = join(dir, 'out');
    try {
      const args = [
        '-m', this.options.modelPath, '-f', input.file.path, '-l', request.language ?? 'auto',
        '-ojf', '-of', outBase, '-np', '-t', String(this.options.threads),
        ...(this.useAlignment() ? ['-dtw', this.dtwPreset()!, '-nfa'] : []),
      ];
      let result;
      try {
        result = await runBinary(this.options.binaryPath, args, { signal: request.signal, maxStdoutBytes: 1024 * 1024 });
      } catch (e) {
        if (e instanceof ProcessError && e.kind === 'aborted') throw abortError(request.signal);
        throw new SpeechError('provider-failed');
      }
      if (result.exitCode === 2) throw new SpeechError('unsupported-audio'); // whisper.cpp: audio file could not be read
      if (result.exitCode !== 0) throw new SpeechError('provider-failed');

      const jsonPath = `${outBase}.json`;
      const info = await stat(jsonPath).catch(() => null);
      // whisper.cpp exits 0 without writing output when it cannot decode the audio.
      if (!info) throw new SpeechError('unsupported-audio');
      if (info.size > (this.options.maxOutputBytes ?? 64 * 1024 * 1024)) throw new SpeechError('resource-limit');
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(jsonPath, 'utf8')); } catch { throw new SpeechError('invalid-response'); }
      return parseWhisperCppJson(parsed, { wordTiming: this.useAlignment() ? 'alignment' : 'decoder' });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
