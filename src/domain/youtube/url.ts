/**
 * Strict YouTube URL parsing. The ONLY thing taken from a URL is an 11-character video id; the embed address is always built
 * from that id by the player code, never from the user's text. Anything that is not clearly a YouTube watch, youtu.be or
 * Shorts link is rejected with a reason: other hosts, embed/iframe/script URLs, credentials, ports, ambiguous or malformed ids.
 */
export type YouTubeUrlKind = 'watch' | 'short-link' | 'shorts';

export type YouTubeUrlRejection =
  | 'empty' | 'too-long' | 'malformed' | 'unsupported-scheme' | 'unsupported-host' | 'credentials' | 'port'
  | 'unsupported-path' | 'no-video-id' | 'invalid-video-id' | 'ambiguous';

export type ParsedYouTubeUrl = { ok: true; videoId: string; kind: YouTubeUrlKind } | { ok: false; reason: YouTubeUrlRejection };

export const MAX_YOUTUBE_URL_LENGTH = 2048;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_HOST = 'youtu.be';
// Control characters, whitespace inside the URL, and backslashes (a common parser-confusion trick).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000- \u007f-\u009f\\]/;
// A pasted link without a scheme is accepted only for the exact hosts this module supports.
const SCHEMELESS = /^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i;

export const isYouTubeVideoId = (v: unknown): v is string => typeof v === 'string' && VIDEO_ID.test(v);

const fail = (reason: YouTubeUrlRejection): ParsedYouTubeUrl => ({ ok: false, reason });

export function parseYouTubeUrl(input: unknown): ParsedYouTubeUrl {
  if (typeof input !== 'string') return fail('malformed');
  const text = input.trim();
  if (text === '') return fail('empty');
  if (text.length > MAX_YOUTUBE_URL_LENGTH) return fail('too-long');
  if (FORBIDDEN.test(text)) return fail('malformed');

  let url: URL;
  try { url = new URL(SCHEMELESS.test(text) ? `https://${text}` : text); } catch { return fail('malformed'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('unsupported-scheme');
  if (url.username !== '' || url.password !== '') return fail('credentials');
  if (url.port !== '') return fail('port');

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter((s) => s !== ''); // a trailing slash is ignored
  const idIn = (candidate: string | undefined, kind: YouTubeUrlKind): ParsedYouTubeUrl => {
    if (candidate === undefined || candidate === '') return fail('no-video-id');
    // Ids never need percent-encoding: an encoded id is either a trick or a mistake, so it is simply "not valid".
    if (!isYouTubeVideoId(candidate)) return fail('invalid-video-id');
    return { ok: true, videoId: candidate, kind };
  };

  if (host === SHORT_HOST) {
    if (parts.length !== 1) return fail(parts.length === 0 ? 'no-video-id' : 'unsupported-path');
    return idIn(parts[0], 'short-link');
  }
  if (!WATCH_HOSTS.has(host)) return fail('unsupported-host');

  if (parts[0] === 'watch' && parts.length === 1) {
    const ids = url.searchParams.getAll('v');
    if (ids.length === 0) return fail('no-video-id');
    if (ids.length > 1) return fail('ambiguous');
    return idIn(ids[0], 'watch');
  }
  if (parts[0] === 'shorts' && parts.length === 2) return idIn(parts[1], 'shorts');
  return fail('unsupported-path');
}

/** Plain-language reason for the interface. Never echoes the user's text. */
export function describeRejection(reason: YouTubeUrlRejection): string {
  switch (reason) {
    case 'empty': return 'Paste a YouTube link first.';
    case 'too-long': return 'That link is too long to be a YouTube video link.';
    case 'unsupported-scheme': return 'Only web links (https://) are supported.';
    case 'unsupported-host': return 'That is not a YouTube video link. Use a youtube.com watch link, a youtu.be link or a YouTube Shorts link.';
    case 'credentials': return 'Links that contain a user name or password are not accepted.';
    case 'port': return 'Links with a port number are not accepted.';
    case 'unsupported-path': return 'That YouTube link is not a single video. Playlists, channels, embed links and live pages are not supported.';
    case 'no-video-id': return 'The link has no video id.';
    case 'invalid-video-id': return 'The video id in the link is not valid.';
    case 'ambiguous': return 'The link names more than one video.';
    case 'malformed': return 'That does not look like a link.';
  }
}
