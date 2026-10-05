import { ProcessError, runBinary } from '../src/infrastructure/ffmpeg/processRunner';

const node = process.execPath;

describe('runBinary', () => {
  it('captures stdout and the exit code', async () => {
    expect(await runBinary(node, ['-e', 'process.stdout.write("hi"); process.exit(3)'])).toEqual({ exitCode: 3, stdout: 'hi' });
  });
  it('never interprets arguments through a shell', async () => {
    const hostile = '$(echo pwned); `id` | cat > /tmp/sw-pwned & echo $HOME';
    const { stdout } = await runBinary(node, ['-e', 'process.stdout.write(process.argv[1])', hostile]);
    expect(stdout).toBe(hostile);
  });
  it('gives the child a minimal environment', async () => {
    process.env.SW_SECRET_FOR_TEST = 'topsecret';
    const { stdout } = await runBinary(node, ['-e', 'process.stdout.write(String(process.env.SW_SECRET_FOR_TEST))']);
    delete process.env.SW_SECRET_FOR_TEST;
    expect(stdout).toBe('undefined');
  });
  it('closes stdin so tools never wait for input', async () => {
    const r = await runBinary(node, ['-e', 'process.stdin.on("end",()=>process.stdout.write("eof")); process.stdin.resume()']);
    expect(r.stdout).toBe('eof');
  });
  it('kills the process when aborted', async () => {
    const ac = new AbortController();
    const p = runBinary(node, ['-e', 'setTimeout(()=>{},60000)'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });
  it('rejects immediately if already aborted', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(runBinary(node, ['-e', ''], { signal: ac.signal })).rejects.toBeInstanceOf(ProcessError);
  });
  it('caps output and kills a runaway process', async () => {
    await expect(runBinary(node, ['-e', 'for(;;) process.stdout.write("x".repeat(65536))'], { maxStdoutBytes: 1024 })).rejects.toMatchObject({ kind: 'output-too-large' });
  });
  it('reports a missing binary as spawn-failed without leaking the path', async () => {
    const err = await runBinary('/definitely/not/a/binary', []).catch((e: Error) => e);
    expect(err).toMatchObject({ kind: 'spawn-failed' });
    expect((err as Error).message).not.toContain('/definitely');
  });
});
