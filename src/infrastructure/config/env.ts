export interface AppConfig {
  appName: string;
  maxUploadBytes: number;
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
  return { appName, maxUploadBytes: mb * 1024 * 1024 };
}

export const config: AppConfig = parseConfig(import.meta.env as RawEnv);
