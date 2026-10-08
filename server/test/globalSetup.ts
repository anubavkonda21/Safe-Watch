import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Makes the REAL visual-inference tests runnable instead of silently skipped.
 * On macOS it builds the Apple Vision helper and prepares the checksummed test
 * images; if that fails, the whole run fails (the real test is never converted to a mock).
 * On other platforms the Apple Vision adapter cannot exist, so those tests are
 * skipped with an explicit reason (see `describe.runIf(process.platform === 'darwin')`).
 */
export default function setup() {
  if (process.platform !== 'darwin') return;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const script of ['scripts/build-vision-helper.sh', 'scripts/download-vision-assets.sh']) {
    try {
      execFileSync('bash', [script], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      const err = e as { stderr?: Buffer; message: string };
      throw new Error(`Real vision tests need ${script} to succeed: ${err.stderr?.toString().trim() || err.message}`);
    }
  }
}
