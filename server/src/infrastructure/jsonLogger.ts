import type { Logger } from '../application/ports';

const ORDER = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof ORDER;

/**
 * One JSON object per line. Callers pass only operational fields (request id,
 * media id, operation, status, duration). Filenames, file contents and
 * secrets must never be logged.
 */
export function createJsonLogger(level: LogLevel, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const emit = (lvl: Exclude<LogLevel, 'silent'>) => (msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...fields }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
