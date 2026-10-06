export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Compact elapsed time: "85 ms", "1.2 s", "2 min 5 s". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number(s.toFixed(1))} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Media time as m:ss.cc (h:mm:ss.cc from one hour), for transcript and match timestamps. */
export function formatTimecode(totalSeconds: number): string {
  const cs = Math.round(Math.max(0, totalSeconds) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const frac = String(cs % 100).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}` : `${m}:${String(s).padStart(2, '0')}.${frac}`;
}
