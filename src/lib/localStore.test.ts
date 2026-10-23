import { createLocalStore } from './localStore';

const KEY = 'test.localStore';
const make = () => createLocalStore<{ n: number }>({ key: KEY, parse: (raw) => (typeof raw === 'object' && raw !== null && typeof (raw as { n?: unknown }).n === 'number' ? { n: (raw as { n: number }).n } : { n: 0 }) });
beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe('createLocalStore', () => {
  it('reads defaults, persists writes, and restores them after a reload', () => {
    const s = make();
    expect(s.getSnapshot()).toEqual({ n: 0 });
    s.set({ n: 5 });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ n: 5 });
    s.reload();
    expect(s.getSnapshot()).toEqual({ n: 5 });
  });
  it('validates everything it reads: corrupt, hostile and non-JSON data fall back', () => {
    for (const raw of ['{ nope', '"x"', '[]', 'null', '{"n":"5"}']) {
      window.localStorage.setItem(KEY, raw);
      const s = make();
      expect(s.getSnapshot()).toEqual({ n: 0 });
    }
  });
  it('keeps working in memory when storage throws (private windows, quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const s = make();
    expect(s.getSnapshot()).toEqual({ n: 0 });
    expect(() => s.set({ n: 3 })).not.toThrow();
    expect(s.getSnapshot()).toEqual({ n: 3 });
  });
  it('notifies subscribers on every change, and stops after unsubscribe', () => {
    const s = make();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    s.set({ n: 1 }); s.reload();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    s.set({ n: 2 });
    expect(seen).toHaveBeenCalledTimes(2);
  });
  it('never touches the network', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const s = make(); s.set({ n: 1 }); s.getSnapshot();
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
