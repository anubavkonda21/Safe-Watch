import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class ProcessError extends Error {
  readonly kind: 'spawn-failed' | 'aborted' | 'output-too-large';
  constructor(kind: ProcessError['kind']) {
    super(kind);
    this.name = 'ProcessError';
    this.kind = kind;
  }
}

/** What an invocation may touch when an OS sandbox is active. Everything not listed is denied. */
export interface SandboxPolicy {
  /** Directories the process may write to (server-generated). Reads are not restricted: the tools must read media, libraries and models. */
  writeDirs?: readonly string[];
  /**
   * Allow writing the per-user Metal shader cache (`<user cache dir>/com.apple.metal`, nothing else in that directory).
   * whisper.cpp compiles GPU kernels on every start; without the cache a transcription takes 14 s instead of 0.3 s.
   */
  gpuShaderCache?: boolean;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Hard cap on captured stdout; the process is killed beyond it. */
  maxStdoutBytes?: number;
  sandbox?: SandboxPolicy;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
}

export type SandboxMode = 'none' | 'seatbelt';

let sandboxMode: SandboxMode = 'none';
/** Process-wide setting, chosen once at startup (and by tests). */
export const configureSandbox = (mode: SandboxMode): void => { sandboxMode = mode; };
export const currentSandbox = (): SandboxMode => sandboxMode;

let killGraceMs = 1000;
export const configureKillGrace = (ms: number): void => { killGraceMs = ms; };

const live = new Set<ChildProcess>();
/** Number of child processes started by this module that have not exited yet. */
export const liveProcessCount = (): number => live.size;

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
};

/**
 * Stops every child this module started: SIGTERM to its process group, SIGKILL after the grace period.
 * Resolves when all have exited (or after `timeoutMs`, whichever is first). Used at shutdown.
 */
export async function terminateAllProcesses(timeoutMs = killGraceMs + 4000): Promise<number> {
  const children = [...live];
  if (children.length === 0) return 0;
  const done = Promise.all(children.map((c) => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once('close', () => r()); })));
  for (const c of children) signalGroup(c, 'SIGTERM');
  const hard = setTimeout(() => { for (const c of children) signalGroup(c, 'SIGKILL'); }, killGraceMs);
  const give = new Promise<void>((r) => setTimeout(r, timeoutMs).unref());
  await Promise.race([done, give]);
  clearTimeout(hard);
  for (const c of children) if (c.exitCode === null && c.signalCode === null) signalGroup(c, 'SIGKILL');
  return children.length;
}

// Last resort if the server process itself exits while a tool is still running.
process.on('exit', () => { for (const c of live) signalGroup(c, 'SIGKILL'); });

let shaderCacheDir: string | null | undefined;
/** `<DARWIN_USER_CACHE_DIR>/com.apple.metal`, or null if it cannot be determined. */
function metalCacheDir(): string | null {
  if (shaderCacheDir === undefined) {
    try {
      const base = execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim();
      shaderCacheDir = real(join(base, 'com.apple.metal')) ?? null;
    } catch { shaderCacheDir = null; }
  }
  return shaderCacheDir;
}

const SCHEME_UNSAFE = /["\\\0\n\r]/;
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/**
 * macOS Seatbelt profile: allow everything the tool needs to READ and run, but deny all network access, process
 * creation (fork) and every file write outside the listed directories. Paths are resolved to their real location
 * (Seatbelt matches real paths) and refused if they contain characters that could alter the profile.
 */
export function seatbeltProfile(policy: SandboxPolicy = {}): string {
  const dirs = (policy.writeDirs ?? []).map(real).filter((d): d is string => d !== null);
  const gpu = policy.gpuShaderCache ? metalCacheDir() : null;
  if (gpu) dirs.push(gpu);
  for (const d of dirs) if (SCHEME_UNSAFE.test(d)) throw new ProcessError('spawn-failed');
  const writable = ['(literal "/dev/null")', ...dirs.map((d) => `(subpath "${d}")`)].join(' ');
  return `(version 1)(allow default)(deny network*)(deny process-fork)(deny file-write*)(allow file-write* ${writable})`;
}

/** True if the Seatbelt sandbox can actually be applied on this machine (a real probe, not a platform guess). */
export async function probeSeatbelt(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const previous = sandboxMode;
  try {
    sandboxMode = 'seatbelt';
    const r = await runBinary('/usr/bin/true', []);
    return r.exitCode === 0;
  } catch {
    return false;
  } finally {
    sandboxMode = previous;
  }
}

/**
 * Runs an external binary safely: arguments are passed as an array (never
 * through a shell), stdin is closed, the environment is minimal, the working
 * directory is neutral, output is capped, and the process is started in its own
 * process group so a timeout or shutdown stops it and anything it spawned
 * (SIGTERM, then SIGKILL after a grace period). The promise settles only after
 * the process has exited, so callers can safely delete its output afterwards.
 * With the Seatbelt sandbox enabled the tool also has no network and can write
 * only where the policy says. stderr is drained and discarded so it can never
 * reach a client or a log.
 */
export function runBinary(binary: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const maxStdout = options.maxStdoutBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new ProcessError('aborted'));
    let command = binary;
    let argv = [...args];
    if (sandboxMode === 'seatbelt') {
      try { argv = ['-p', seatbeltProfile(options.sandbox), binary, ...args]; command = '/usr/bin/sandbox-exec'; } catch (e) { return reject(e); }
    }
    const child = spawn(command, argv, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '' },
    });
    live.add(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let failure: ProcessError | null = null;
    let hardTimer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      options.signal?.removeEventListener('abort', onAbort);
      live.delete(child);
      fn();
    };
    const stop = (error: ProcessError) => {
      if (failure) return;
      failure = error;
      signalGroup(child, 'SIGTERM');
      hardTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        // If even SIGKILL is not reported, do not hang the caller forever.
        hardTimer = setTimeout(() => settle(() => reject(error)), 3000);
      }, killGraceMs);
    };
    const onAbort = () => stop(new ProcessError('aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer) => {
      if (failure) return;
      size += c.length;
      if (size > maxStdout) { stop(new ProcessError('output-too-large')); return; }
      chunks.push(c);
    });
    child.stderr.resume();
    child.on('error', () => settle(() => reject(new ProcessError('spawn-failed'))));
    child.on('close', (code) => settle(() => (failure ? reject(failure) : resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') }))));
  });
}
