import { MediaIngestionError } from '@/domain/media/errors';
import type { ProcessOptions } from '@/application/mediaProcessor';
import type { MediaInput, ServerMediaProcessor } from '../../application/ports';
import { buildDecodeCheckArgs, buildFfprobeArgs, summarizeProbe, summaryToMetadata } from './ffprobe';
import { ProcessError, runBinary } from './processRunner';

export interface FfmpegPaths {
  ffmpegPath: string;
  ffprobePath: string;
}

/**
 * The only place in the server that knows about FFmpeg. Everything above it
 * depends on the `ServerMediaProcessor` port.
 *
 * Current scope (Checkpoint 2): metadata via FFprobe and a decode smoke test
 * via FFmpeg. Audio, subtitle and frame extraction are later checkpoints and
 * will be added here.
 */
export class FfmpegMediaProcessor implements ServerMediaProcessor {
  constructor(private readonly paths: FfmpegPaths) {}

  async extractMetadata(input: MediaInput, options: ProcessOptions = {}) {
    const result = await this.run(this.paths.ffprobePath, buildFfprobeArgs(input.path, input.container), options);
    if (result.exitCode !== 0) throw new MediaIngestionError('invalid-media');
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new MediaIngestionError('invalid-media'); }
    const summary = summarizeProbe(parsed);
    const metadata = summary && summaryToMetadata(summary);
    if (!metadata || metadata.availability === 'unavailable') throw new MediaIngestionError('invalid-media');
    return metadata;
  }

  async verifyDecodable(input: MediaInput, options: ProcessOptions = {}): Promise<void> {
    const result = await this.run(this.paths.ffmpegPath, buildDecodeCheckArgs(input.path, input.container), options);
    if (result.exitCode !== 0) throw new MediaIngestionError('invalid-media');
  }

  /** Startup check: are both binaries runnable? */
  static async checkTools(paths: FfmpegPaths): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
    const ok = async (bin: string) => {
      try { return (await runBinary(bin, ['-version'], { maxStdoutBytes: 64 * 1024 })).exitCode === 0; } catch { return false; }
    };
    const [ffmpeg, ffprobe] = await Promise.all([ok(paths.ffmpegPath), ok(paths.ffprobePath)]);
    return { ffmpeg, ffprobe };
  }

  private async run(binary: string, args: string[], options: ProcessOptions) {
    try {
      return await runBinary(binary, args, { signal: options.signal });
    } catch (e) {
      if (e instanceof ProcessError && e.kind === 'aborted') throw e; // the service maps this to a timeout
      throw new MediaIngestionError('processing-failed');
    }
  }
}
