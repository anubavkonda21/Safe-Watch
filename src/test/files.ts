/** Builds Files whose first bytes are a real container signature. */
const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export const HEADERS = {
  mp4: new Uint8Array([0, 0, 0, 0x18, ...enc('ftyp'), ...enc('mp42'), 0, 0, 0, 0, ...enc('mp42isom')]),
  quicktime: new Uint8Array([0, 0, 0, 0x14, ...enc('ftyp'), ...enc('qt  '), 0, 0, 0, 0, ...enc('qt  ')]),
  matroska: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, ...enc('matroska'), 0, 0, 0, 0]),
  webm: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, ...enc('webm'), 0, 0, 0, 0, 0, 0]),
  avi: new Uint8Array([...enc('RIFF'), 0, 0, 0, 0, ...enc('AVI '), ...enc('LIST')]),
  html: new Uint8Array(enc('<!doctype html><html><body>not a video at all</body></html>')),
} as const;

export function makeFile(name: string, header: Uint8Array, type = 'video/mp4', size?: number): File {
  const file = new File([header as BlobPart], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}
