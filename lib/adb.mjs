// ADB wrapper: resolves the attached Android device and runs adb commands.
// Device selection: ADB_SERIAL env var (if set) or the only device in "device" state.
import { spawn } from 'node:child_process';
import { runCmd } from './spawn.mjs';

let _serial = null;

async function resolveSerial() {
  if (_serial) return _serial;
  if (process.env.ADB_SERIAL) return (_serial = process.env.ADB_SERIAL);
  const r = await runCmd('adb', ['devices', '-l'], { timeoutMs: 8000 });
  if (!r.ok) throw new Error(`adb devices failed: ${r.err || r.out || 'adb not found on PATH'}`);
  const online = r.out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).slice(0, 2))
    .filter((p) => p[1] === 'device');
  if (online.length === 0) {
    throw new Error(
      'No authorized Android device found via ADB. On the phone: Settings → Developer options → USB debugging → ON. ' +
        'Plug in and tap "Allow" on the authorization prompt, then re-run. Or set ADB_SERIAL=<serial> when launching the server. ' +
        'Check with: adb devices'
    );
  }
  if (online.length > 1) {
    throw new Error(
      `Multiple ADB devices online (${online.map((p) => p[0]).join(', ')}). Set ADB_SERIAL=<serial> when launching the server.`
    );
  }
  return (_serial = online[0][0]);
}

async function runAdb(args, timeoutMs = 20000) {
  const s = await resolveSerial();
  return runCmd('adb', ['-s', s, ...args], { timeoutMs });
}

export function createAdb() {
  async function info() {
    const serial = await resolveSerial();
    const model = (await runAdb(['shell', 'getprop', 'ro.product.model'], 5000)).out.trim();
    const android = (await runAdb(['shell', 'getprop', 'ro.build.version.release'], 5000)).out.trim();
    const sizeOut = (await runAdb(['shell', 'wm', 'size'], 5000)).out.trim();
    const m = sizeOut.match(/(\d+)\s*x\s*(\d+)/);
    return {
      serial,
      model: model || '?',
      android: android || '?',
      width: m ? Number(m[1]) : null,
      height: m ? Number(m[2]) : null,
    };
  }

  async function screenshot() {
    const dst = '/sdcard/.mcp_phone_use_screen.png';
    const src = `/tmp/.mcp_phone_use_shot_${Date.now()}.png`;
    const r = await runAdb(['shell', 'screencap', '-p', dst], 15000);
    if (!r.ok) throw new Error(`screencap failed: ${r.err || r.out}`);
    const p = await runAdb(['pull', dst, src], 20000);
    if (!p.ok) throw new Error(`adb pull failed: ${p.err || p.out}`);
    await runAdb(['shell', 'rm', '-f', dst], 3000);
    return { path: src };
  }

  async function uiDump() {
    const dst = '/sdcard/.mcp_phone_use_ui.xml';
    const src = `/tmp/.mcp_phone_use_ui_${Date.now()}.xml`;
    const r = await runAdb(['shell', 'uiautomator', 'dump', dst], 15000);
    if (!r.ok) throw new Error(`uiautomator dump failed: ${r.err || r.out}`);
    const p = await runAdb(['pull', dst, src], 20000);
    if (!p.ok) throw new Error(`adb pull ui.xml failed: ${p.err || p.out}`);
    await runAdb(['shell', 'rm', '-f', dst], 3000);
    return { path: src };
  }

  const shell = (cmd, timeoutMs = 20000) => runAdb(['shell', ...cmd], timeoutMs);

  // Long-lived `adb shell <cmd>` with a writable stdin (used by the virtual HID keyboard).
  const spawnShell = async (cmd) => {
    const s = await resolveSerial();
    return spawn('adb', ['-s', s, 'shell', ...cmd], { env: { ...process.env } });
  };

  return { info, screenshot, uiDump, shell, spawnShell, resolveSerial };
}
