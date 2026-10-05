import { spawn } from 'node:child_process';

export class ProcessError extends Error {
  readonly kind: 'spawn-failed' | 'aborted' | 'output-too-large';
  constructor(kind: ProcessError['kind']) {
    super(kind);
    this.name = 'ProcessError';
    this.kind = kind;
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Hard cap on captured stdout; the process is killed beyond it. */
  maxStdoutBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
}

/**
 * Runs an external binary safely: arguments are passed as an array (never
 * through a shell), stdin is closed, the environment is minimal, output is
 * capped, and the process is killed on abort. stderr is drained and
 * discarded so it can never reach a client or a log.
 */
export function runBinary(binary: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const maxStdout = options.maxStdoutBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new ProcessError('aborted'));
    const child = spawn(binary, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { PATH: process.env.PATH ?? '' },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => { child.kill('SIGKILL'); finish(() => reject(new ProcessError('aborted'))); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxStdout) { child.kill('SIGKILL'); finish(() => reject(new ProcessError('output-too-large'))); return; }
      chunks.push(c);
    });
    child.stderr.resume();
    child.on('error', () => finish(() => reject(new ProcessError('spawn-failed'))));
    child.on('close', (code) => finish(() => resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') })));
  });
}
