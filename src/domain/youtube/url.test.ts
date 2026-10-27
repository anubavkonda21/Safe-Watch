import { describeRejection, isYouTubeVideoId, MAX_YOUTUBE_URL_LENGTH, parseYouTubeUrl, type YouTubeUrlRejection } from './url';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeUrl: accepted forms', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, 'watch'],
    [`https://youtube.com/watch?v=${ID}`, 'watch'],
    [`https://m.youtube.com/watch?v=${ID}`, 'watch'],
    [`http://www.youtube.com/watch?v=${ID}`, 'watch'],
    [`https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123&index=2`, 'watch'],
    [`https://www.youtube.com/watch/?v=${ID}#frag`, 'watch'],
    [`https://youtu.be/${ID}`, 'short-link'],
    [`https://youtu.be/${ID}?t=10`, 'short-link'],
    [`https://youtu.be/${ID}/`, 'short-link'],
    [`https://www.youtube.com/shorts/${ID}`, 'shorts'],
    [`https://youtube.com/shorts/${ID}/`, 'shorts'],
    [`  https://www.YouTube.com/watch?v=${ID}  `, 'watch'],
    [`www.youtube.com/watch?v=${ID}`, 'watch'],
    [`youtu.be/${ID}`, 'short-link'],
    [`https://www.youtube.com/watch?v=-_-_-_-_-_-`, 'watch'],
  ])('%s', (input, kind) => {
    const r = parseYouTubeUrl(input);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.kind).toBe(kind); expect(r.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/); }
  });

  it('returns only the id, never any other part of the text', () => {
    const r = parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&redirect=https://evil.example&x=<script>`);
    expect(r).toEqual({ ok: true, videoId: ID, kind: 'watch' });
  });
});

describe('parseYouTubeUrl: rejections', () => {
  const cases: Array<[string, unknown, YouTubeUrlRejection]> = [
    ['empty', '', 'empty'], ['blank', '   ', 'empty'],
    ['not a string', 42, 'malformed'], ['null', null, 'malformed'], ['an object', { v: ID }, 'malformed'],
    ['plain text', 'hello there', 'malformed'], ['a bare id', ID, 'malformed'],
    ['ftp', `ftp://www.youtube.com/watch?v=${ID}`, 'unsupported-scheme'],
    ['javascript:', 'javascript:alert(1)', 'unsupported-scheme'],
    ['data:', 'data:text/html,<script>alert(1)</script>', 'unsupported-scheme'],
    ['file:', 'file:///etc/passwd', 'unsupported-scheme'],
    ['other host', `https://vimeo.com/watch?v=${ID}`, 'unsupported-host'],
    ['look-alike host', `https://www.youtube.com.evil.example/watch?v=${ID}`, 'unsupported-host'],
    ['look-alike prefix', `https://evilyoutube.com/watch?v=${ID}`, 'unsupported-host'],
    ['look-alike suffix', `https://notyoutu.be/${ID}`, 'unsupported-host'],
    ['subdomain trick', `https://youtube.com.attacker.test/watch?v=${ID}`, 'unsupported-host'],
    ['trailing-dot host', `https://www.youtube.com./watch?v=${ID}`, 'unsupported-host'],
    ['unicode look-alike', `https://www.yoütube.com/watch?v=${ID}`, 'unsupported-host'],
    ['cyrillic look-alike', `https://www.уoutube.com/watch?v=${ID}`, 'unsupported-host'],
    ['music subdomain', `https://music.youtube.com/watch?v=${ID}`, 'unsupported-host'],
    ['nocookie embed host', `https://www.youtube-nocookie.com/embed/${ID}`, 'unsupported-host'],
    ['credentials', `https://user:pass@www.youtube.com/watch?v=${ID}`, 'credentials'],
    ['credentials trick', `https://www.youtube.com@evil.example/watch?v=${ID}`, 'credentials'],
    ['port', `https://www.youtube.com:8443/watch?v=${ID}`, 'port'],
    ['embed path', `https://www.youtube.com/embed/${ID}`, 'unsupported-path'],
    ['iframe API url', 'https://www.youtube.com/iframe_api', 'unsupported-path'],
    ['playlist', 'https://www.youtube.com/playlist?list=PL1234567890', 'unsupported-path'],
    ['channel', 'https://www.youtube.com/@someone', 'unsupported-path'],
    ['live page', `https://www.youtube.com/live/${ID}`, 'unsupported-path'],
    ['home', 'https://www.youtube.com/', 'unsupported-path'],
    ['watch with extra path', `https://www.youtube.com/watch/x?v=${ID}`, 'unsupported-path'],
    ['shorts with extra path', `https://www.youtube.com/shorts/${ID}/extra`, 'unsupported-path'],
    ['youtu.be with extra path', `https://youtu.be/${ID}/x`, 'unsupported-path'],
    ['youtu.be without id', 'https://youtu.be/', 'no-video-id'],
    ['watch without v', 'https://www.youtube.com/watch', 'no-video-id'],
    ['watch with empty v', 'https://www.youtube.com/watch?v=', 'no-video-id'],
    ['two v', `https://www.youtube.com/watch?v=${ID}&v=aaaaaaaaaaa`, 'ambiguous'],
    ['short id', 'https://www.youtube.com/watch?v=abc', 'invalid-video-id'],
    ['long id', `https://www.youtube.com/watch?v=${ID}x`, 'invalid-video-id'],
    ['bad characters in id', 'https://www.youtube.com/watch?v=abc$%^&*()_', 'invalid-video-id'],
    ['id with script', 'https://www.youtube.com/watch?v=<script>a', 'invalid-video-id'],
    ['id with quote', `https://www.youtube.com/watch?v="onload=a`, 'invalid-video-id'],
    ['percent-encoded separator in id', 'https://www.youtube.com/watch?v=abc%2F..%2Fxyz', 'invalid-video-id'],
    ['percent-encoded id on youtu.be', 'https://youtu.be/dQw4w9WgXc%51', 'invalid-video-id'],
    ['path traversal id', 'https://youtu.be/..%2F..%2Fx', 'invalid-video-id'],
    ['inner whitespace', `https://www.youtube.com/watch?v=${ID} x`, 'malformed'],
    ['newline injection', `https://www.youtube.com/watch?v=${ID}\nhttps://evil.example`, 'malformed'],
    ['tab', `https://www.youtube.com/watch?v=${ID}\t`.replace(/\t$/, '\tx'), 'malformed'],
    ['null byte', `https://www.youtube.com/watch?v=${ID}\u0000`, 'malformed'],
    ['backslash', `https://www.youtube.com\\@evil.example/watch?v=${ID}`, 'malformed'],
    ['too long', `https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(MAX_YOUTUBE_URL_LENGTH)}`, 'too-long'],
  ];
  it.each(cases)('%s', (_name, input, reason) => {
    expect(parseYouTubeUrl(input)).toEqual({ ok: false, reason });
  });

  it('every rejection reason has plain text that never echoes the input', () => {
    const reasons: YouTubeUrlRejection[] = ['empty', 'too-long', 'malformed', 'unsupported-scheme', 'unsupported-host', 'credentials', 'port', 'unsupported-path', 'no-video-id', 'invalid-video-id', 'ambiguous'];
    for (const r of reasons) { expect(describeRejection(r).length).toBeGreaterThan(10); expect(describeRejection(r)).not.toMatch(/<|>|\$\{/); }
  });
});

describe('isYouTubeVideoId', () => {
  it('accepts exactly eleven url-safe characters', () => {
    expect(isYouTubeVideoId(ID)).toBe(true);
    for (const bad of ['', 'a', `${ID}x`, 'dQw4w9WgXc ', 'dQw4w9WgXc/', 'dQw4w9WgXc.', null, undefined, 5]) expect(isYouTubeVideoId(bad)).toBe(false);
  });
});
