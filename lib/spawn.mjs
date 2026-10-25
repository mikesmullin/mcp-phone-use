// Generic process runner used by adb commands and the Python render/parse helpers.
const { spawn } = await import('node:child_process');

export const runCmd = (cmd, args = [], { timeoutMs = 30000, cwd } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs, env: { ...process.env } });
    let out = '', stderr = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (stderr += d));
    const done = (code) => resolve({ ok: code === 0, out: (out + stderr).trim(), stdout: out, stderr, err: stderr, code });
    child.on('close', done);
    child.on('timeout', () => child.kill('SIGKILL'));
    child.on('error', reject);
  });
