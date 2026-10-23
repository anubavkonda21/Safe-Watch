/**
 * Gives a jsdom <video> the behaviour the coordinator relies on (a playhead, duration, paused and muted state, seeks that
 * complete asynchronously), with no real media and no real time. Player events are dispatched by hand.
 */
export interface FakeVideo {
  readonly el: HTMLVideoElement;
  /** The element's playhead in seconds (what a real player would report). */
  time(): number;
  muted(): boolean;
  seeks: number[];
  play(): void;
  pause(): void;
  /** The playhead advances WITHOUT any event (what happens between `timeupdate` events and when animation frames are throttled). */
  tick(seconds: number): void;
  /** Natural playback: the playhead advances and `timeupdate` fires. */
  advanceTo(seconds: number, stepMs?: number): Promise<void>;
  /** The USER seeks. */
  userSeek(seconds: number): Promise<void>;
  /** The USER changes mute. */
  userMute(muted: boolean): void;
  end(): void;
  loaded(): void;
  fail(): void;
}

export function installFakeVideo(el: HTMLVideoElement, durationSeconds = 60): FakeVideo {
  let time = 0; let paused = true; let muted = false; let duration = durationSeconds;
  const seeks: number[] = [];
  const emit = (name: string) => el.dispatchEvent(new Event(name));
  Object.defineProperties(el, {
    currentTime: { configurable: true, get: () => time, set: (v: number) => { time = v; seeks.push(v); emit('seeking'); queueMicrotask(() => emit('seeked')); } },
    duration: { configurable: true, get: () => duration },
    paused: { configurable: true, get: () => paused },
    muted: { configurable: true, get: () => muted, set: (v: boolean) => { muted = v; queueMicrotask(() => emit('volumechange')); } },
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    el, seeks, time: () => time, muted: () => muted,
    play() { paused = false; emit('play'); emit('playing'); },
    pause() { paused = true; emit('pause'); },
    tick(seconds) { time = seconds; },
    async advanceTo(seconds, stepMs = 250) {
      if (paused) this.play();
      while (time < seconds - 1e-9) {
        time = Math.min(seconds, time + stepMs / 1000);
        emit('timeupdate');
        await flush();
      }
    },
    async userSeek(seconds) { time = seconds; emit('seeked'); await flush(); },
    userMute(value) { muted = value; emit('volumechange'); },
    end() { paused = true; emit('ended'); },
    loaded() { duration = durationSeconds; emit('loadedmetadata'); },
    fail() { emit('error'); },
  };
}
