export interface AppConfig {
  appName: string;
  maxUploadBytes: number;
  /** Where the SafeWatch API lives. Empty = same origin (the dev server proxies /api). */
  apiBaseUrl: string;
  /** `server`: upload to the SafeWatch API. `browser`: validate and read metadata locally only (no server needed). */
  mediaBackend: 'server' | 'browser';
}

type RawEnv = Record<string, string | undefined>;

/**
 * Parses and validates client configuration. Throws on invalid values so a
 * misconfigured build fails loudly. Only VITE_-prefixed, non-secret values
 * belong here.
 */
export function parseConfig(env: RawEnv): AppConfig {
  const appName = env.VITE_APP_NAME?.trim() || 'SafeWatch';
  const rawMb = env.VITE_MAX_UPLOAD_MB?.trim() || '2048';
  const mb = Number(rawMb);
  if (!Number.isInteger(mb) || mb < 1 || mb > 4096) {
    throw new Error(`Invalid VITE_MAX_UPLOAD_MB "${rawMb}": expected an integer between 1 and 4096.`);
  }

  const rawApi = env.VITE_API_URL?.trim() ?? '';
  let apiBaseUrl = '';
  if (rawApi) {
    let url: URL;
    try { url = new URL(rawApi); } catch { throw new Error(`Invalid VITE_API_URL "${rawApi}": expected an absolute http(s) URL.`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Invalid VITE_API_URL "${rawApi}": expected http or https.`);
    apiBaseUrl = url.origin;
  }

  const rawBackend = env.VITE_MEDIA_BACKEND?.trim() || 'server';
  if (rawBackend !== 'server' && rawBackend !== 'browser') {
    throw new Error(`Invalid VITE_MEDIA_BACKEND "${rawBackend}": expected "server" or "browser".`);
  }
  return { appName, maxUploadBytes: mb * 1024 * 1024, apiBaseUrl, mediaBackend: rawBackend };
}

export const config: AppConfig = parseConfig(import.meta.env as RawEnv);
