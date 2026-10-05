import type { MediaExtraction } from './extraction';

/**
 * Checks the invariants future consumers rely on. Returns human-readable
 * problems (empty when valid). Used before an extraction is marked
 * completed, so a bug in an adapter cannot publish an inconsistent manifest.
 */
export function validateExtraction(e: MediaExtraction, mediaDurationSeconds: number | null): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const unique = (id: string, what: string) => {
    if (ids.has(id)) problems.push(`duplicate ${what} id ${id}`);
    ids.add(id);
  };

  for (const a of e.audio) {
    unique(a.id, 'audio');
    if (!(a.durationSeconds >= 0) || !(a.sizeBytes >= 0)) problems.push(`audio ${a.id}: invalid duration or size`);
    if (a.duplicateOf === null && a.artifact === null) problems.push(`audio ${a.id}: missing artifact`);
    if (a.duplicateOf !== null && !e.audio.some((o) => o.id === a.duplicateOf)) problems.push(`audio ${a.id}: unknown duplicateOf`);
  }

  for (const t of e.subtitles) {
    unique(t.id, 'subtitle');
    if (t.textExtraction === 'extracted' && t.kind !== 'text') problems.push(`subtitle ${t.id}: extracted text from a non-text track`);
    if (t.textExtraction !== 'extracted' && t.cues.length > 0) problems.push(`subtitle ${t.id}: cues present without extraction`);
    if (t.cueCount !== t.cues.length) problems.push(`subtitle ${t.id}: cueCount mismatch`);
    let prevStart = -1;
    for (const c of t.cues) {
      if (!(c.endSeconds > c.startSeconds) || c.startSeconds < 0) problems.push(`subtitle ${t.id}: cue ${c.index} has invalid timing`);
      if (c.startSeconds < prevStart) problems.push(`subtitle ${t.id}: cues out of order at ${c.index}`);
      if (c.text === '') problems.push(`subtitle ${t.id}: empty cue ${c.index}`);
      prevStart = c.startSeconds;
    }
  }

  if (e.frames) {
    const { frames, config } = e.frames;
    if (frames.length > config.maxFrames) problems.push('more frames than maxFrames');
    let total = 0;
    frames.forEach((f, i) => {
      unique(f.id, 'frame');
      if (f.index !== i) problems.push(`frame ${f.id}: index ${f.index} is not ${i}`);
      if (i > 0 && f.timestampSeconds <= (frames[i - 1]?.timestampSeconds ?? -1)) problems.push(`frame ${f.id}: timestamps not strictly increasing`);
      if (f.width < 1 || f.height < 1 || f.width > config.maxWidth || f.height > config.maxHeight) problems.push(`frame ${f.id}: size ${f.width}x${f.height} outside limits`);
      if (mediaDurationSeconds !== null && f.timestampSeconds > mediaDurationSeconds + 0.001) problems.push(`frame ${f.id}: timestamp beyond media duration`);
      total += f.sizeBytes;
    });
    if (total !== e.frames.totalSizeBytes) problems.push('totalSizeBytes mismatch');
  }
  return problems;
}
