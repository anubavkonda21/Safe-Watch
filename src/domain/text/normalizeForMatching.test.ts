import { normalizeForMatching, tokenize } from './normalizeForMatching';

describe('normalizeForMatching', () => {
  it('applies NFKC, so compatibility forms and decomposed accents compare equal', () => {
    expect(normalizeForMatching('ＳａｆｅＷａｔｃｈ')).toBe('SafeWatch');
    expect(normalizeForMatching('ﬁne')).toBe('fine');
    expect(normalizeForMatching('Café')).toBe(normalizeForMatching('Café'));
  });
  it('folds case only when asked', () => {
    expect(normalizeForMatching('SafeWatch')).toBe('SafeWatch');
    expect(normalizeForMatching('SafeWatch', { fold: true })).toBe('safewatch');
  });
  it('unifies curly apostrophes and quotes', () => {
    expect(normalizeForMatching('don’t “quote”')).toBe('don\'t "quote"');
  });
  it('removes control, zero-width and bidi characters and collapses whitespace', () => {
    expect(normalizeForMatching('  a​b ‮c\u0000\t\n d ')).toBe('ab c d');
  });
  it('does not corrupt legitimate words: diacritics and non-Latin scripts survive', () => {
    expect(normalizeForMatching('résumé', { fold: true })).toBe('résumé');
    expect(normalizeForMatching('नमस्ते दुनिया')).toBe('नमस्ते दुनिया');
  });
  it('is idempotent', () => {
    const once = normalizeForMatching('Ｈello  “world” ​', { fold: true });
    expect(normalizeForMatching(once, { fold: true })).toBe(once);
  });
});

describe('tokenize', () => {
  it('splits on punctuation but keeps inner apostrophes and combining marks', () => {
    expect(tokenize("Hello, don't stop-me! 3.14")).toEqual(['Hello', "don't", 'stop', 'me', '3', '14']);
    expect(tokenize('नमस्ते, दुनिया!')).toEqual(['नमस्ते', 'दुनिया']);
  });
  it('returns nothing for punctuation-only text', () => expect(tokenize('?! … --')).toEqual([]));
});
