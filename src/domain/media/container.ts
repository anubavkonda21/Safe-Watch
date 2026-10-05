/**
 * Container detection from the first bytes of a file ("magic numbers").
 * This proves only that the header looks like the claimed format; it does not
 * prove the file is safe or fully valid.
 */
export type ContainerFormat = 'mp4' | 'quicktime' | 'matroska' | 'webm' | 'avi';

/** Number of leading bytes the application reads for sniffing. */
export const SNIFF_BYTES = 64;

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

const LEGACY_QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

export function detectContainer(head: Uint8Array): ContainerFormat | null {
  if (head.length < 12) return null;

  const atom = ascii(head, 4, 8);
  if (atom === 'ftyp') return ascii(head, 8, 12) === 'qt  ' ? 'quicktime' : 'mp4';
  if (LEGACY_QUICKTIME_ATOMS.has(atom)) return 'quicktime';

  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return ascii(head, 0, Math.min(head.length, SNIFF_BYTES)).includes('webm') ? 'webm' : 'matroska';
  }

  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'AVI ') return 'avi';
  return null;
}

export const CONTAINER_INFO: Record<ContainerFormat, { mimeType: string; label: string }> = {
  mp4: { mimeType: 'video/mp4', label: 'MP4 video' },
  quicktime: { mimeType: 'video/quicktime', label: 'QuickTime video' },
  matroska: { mimeType: 'video/x-matroska', label: 'Matroska video' },
  webm: { mimeType: 'video/webm', label: 'WebM video' },
  avi: { mimeType: 'video/x-msvideo', label: 'AVI video' },
};
