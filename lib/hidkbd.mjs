// Virtual HID keyboard over ADB — no root, no USB gadget, invisible to the caller.
//
// Android ships /system/bin/hid (frameworks/base/cmds/hid), which writes UHID_CREATE2 to
// /dev/uhid through libhidcommand_jni. adb's `shell` uid is in the `uhid` group (verified on
// the tested device, Android 17: groups include 3011(uhid)), so this creates a REAL input device
// (/dev/input/eventN, Classes: KEYBOARD | EXTERNAL) that the OS treats as a physical keyboard.
// That is what makes hardware-keyboard semantics work: Ctrl+A select-all, Ctrl+C/V/X, Tab,
// Escape, and normal typing — none of which `input keyevent`/`keycombination` reliably deliver
// (they inject at the API level and most apps ignore the injected meta state).
//
// IMPORTANT: pick a VID/PID with NO /system/usr/keylayout/Vendor_XXXX_Product_YYYY.kl file,
// otherwise EventHub maps our HID usages through that vendor layout (a common vendor pair ships
// as a remote-control layout, and every key then silently does nothing). Unmapped -> Generic.kl
// (US layout).
import { spawn } from 'node:child_process';

export const HID_MODS = {
  ctrl: 0x01, ctrlLeft: 0x01, shift: 0x02, shiftLeft: 0x02, alt: 0x04, altLeft: 0x04,
  meta: 0x08, metaLeft: 0x08, gui: 0x08, win: 0x08, super: 0x08, cmd: 0x08,
  ctrlRight: 0x10, shiftRight: 0x20, altRight: 0x40, metaRight: 0x80, guiRight: 0x80,
};

const LETTERS = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, 0x04 + i]));
const DIGITS = { '0': 0x27, '1': 0x1e, '2': 0x1f, '3': 0x20, '4': 0x21, '5': 0x22, '6': 0x23, '7': 0x24, '8': 0x25, '9': 0x26 };
const SHIFTED = {
  '!': [0x1e, true], '@': [0x1f, true], '#': [0x20, true], '$': [0x21, true], '%': [0x22, true],
  '^': [0x23, true], '&': [0x24, true], '*': [0x25, true], '(': [0x26, true], ')': [0x27, true],
  '_': [0x2d, true], '+': [0x2e, true], '{': [0x2f, true], '}': [0x30, true], '|': [0x31, true],
  ':': [0x33, true], '"': [0x34, true], '~': [0x35, true], '<': [0x36, true], '>': [0x37, true], '?': [0x38, true],
};

// USB HID Usage Tables, page 0x07 (Keyboard/Keypad). 0x50 = Left Arrow verified on-device.
export const KEY_USAGE = {
  ...LETTERS, ...DIGITS,
  enter: 0x28, return: 0x28, esc: 0x29, escape: 0x29, backspace: 0x2a, delete: 0x2a,
  tab: 0x2b, space: 0x2c, ' ': 0x2c, minus: 0x2d, hyphen: 0x2d, '-': 0x2d,
  equal: 0x2e, equals: 0x2e, '=': 0x2e, bracketleft: 0x2f, '[': 0x2f, bracketright: 0x30, ']': 0x30,
  backslash: 0x31, '\\': 0x31, semicolon: 0x33, ';': 0x33, quote: 0x34, "'": 0x34,
  grave: 0x35, '`': 0x35, comma: 0x36, ',': 0x36, period: 0x37, dot: 0x37, '.': 0x37,
  slash: 0x38, '/': 0x38, capslock: 0x39,
  f1: 0x3a, f2: 0x3b, f3: 0x3c, f4: 0x3d, f5: 0x3e, f6: 0x3f, f7: 0x40, f8: 0x41, f9: 0x42,
  f10: 0x43, f11: 0x44, f12: 0x45, printscreen: 0x46, scrolllock: 0x47, pause: 0x48,
  insert: 0x49, home: 0x4a, pageup: 0x4b, forwarddelete: 0x4c, deleteforward: 0x4c, end: 0x4d, pagedown: 0x4e,
  right: 0x4f, arrowright: 0x4f, dpadright: 0x4f, left: 0x50, arrowleft: 0x50, dpadleft: 0x50,
  down: 0x51, arrowdown: 0x51, dpaddown: 0x51, up: 0x52, arrowup: 0x52, dpadup: 0x52,
  numlock: 0x53, menu: 0x65, contextmenu: 0x65, app: 0x65,
};

// Standard HID boot-keyboard report descriptor (report id 1: mods, reserved, 6 keycodes).
export const KEYBOARD_DESCRIPTOR = [
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x01,
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
  0x95, 0x05, 0x75, 0x01, 0x91, 0x02, 0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, 0xc0,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Semantic key spec: "Ctrl+A" -> [{mods:['ctrl'], key:'a'}]; "Ctrl+A,Delete" -> two presses. */
export function resolveKeySpec(spec) {
  const items = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new Error('keys is required');
  return items.map((item) => {
    const parts = item.split('+').map((s) => s.trim()).filter(Boolean);
    const mods = [];
    let key = null;
    for (const part of parts) {
      const n = norm(part);
      if (HID_MODS[n] !== undefined && !KEY_USAGE[n]) { mods.push(n); continue; }
      if (KEY_USAGE[n] !== undefined && !key) { key = n; continue; }
      if (part.length === 1 && SHIFTED[part]) { key = part; continue; }
      throw new Error(`Unknown key '${part}'. Use names (Enter, Escape, Tab, Delete, Backspace, Space, a-z, 0-9, F1-F12, arrows/Home/End/PageUp/PageDown, Insert, Menu, CapsLock) or modifiers (Ctrl, Alt, Shift, Meta).`);
    }
    if (!key) throw new Error(`Key spec '${item}' has no base key.`);
    return { label: item, mods, key };
  });
}

function charToKey(ch) {
  if (ch === ' ') return { usage: 0x2c, shift: false };
  const lower = ch.toLowerCase();
  if (LETTERS[lower]) return { usage: LETTERS[lower], shift: ch === upper(ch) };
  if (DIGITS[lower]) return { usage: DIGITS[lower], shift: false };
  if (SHIFTED[ch]) return { usage: SHIFTED[ch][0], shift: true };
  if (KEY_USAGE[ch] !== undefined) return { usage: KEY_USAGE[ch], shift: false };
  return null;
}
const upper = (c) => c.toUpperCase();

export function createHidKeyboard({ adb, name = 'MCP Virtual Keyboard', vid = 0x1234, pid = 0x9999, idleMs = 240000 } = {}) {
  let proc = null;
  let lastUse = 0;
  let failed = false;
  let detaching = false;
  let idleTimer = null;

  const write = (obj) => { proc.stdin.write(JSON.stringify(obj) + '\n'); };
  const report = (mods = 0, keys = []) => {
    const k = [...keys, 0, 0, 0, 0, 0, 0].slice(0, 6);
    write({ id: 1, command: 'report', report: [1, mods, 0, ...k] });
  };

  function armIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => detach('idle'), idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function attach() {
    if (proc) return true;
    if (failed) return false;
    try {
      proc = await adb.spawnShell(['hid', '-']);
    } catch {
      failed = true;
      return false;
    }
    proc.stdout.resume();
    proc.stderr.resume();
    proc.on('exit', (code) => {
      const intentional = detaching;
      proc = null;
      if (!intentional && code !== 0) failed = true; // e.g. /dev/uhid denied -> use adb input fallback
    });
    try {
      write({ id: 1, command: 'register', name, vid, pid, bus: 'usb', descriptor: KEYBOARD_DESCRIPTOR });
    } catch {
      failed = true;
      try { proc.kill('SIGKILL'); } catch {}
      proc = null;
      return false;
    }
    await sleep(1400); // wait for onInputDeviceAdded before sending reports
    if (!proc) { failed = true; return false; }
    lastUse = Date.now();
    armIdleTimer();
    return true;
  }

  async function ensure() {
    if (proc) { lastUse = Date.now(); armIdleTimer(); return true; }
    return attach();
  }

  function detach(reason = 'manual') {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!proc) return { attached: false, reason };
    detaching = true;
    try { proc.stdin.end(); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
    proc = null;
    setTimeout(() => { detaching = false; }, 200).unref?.();
    return { attached: false, reason };
  }

  const status = () => ({ attached: !!proc, fallbackOnly: failed, vid, pid, name, idleMs });

  async function press(spec, { holdMs = 45 } = {}) {
    if (!(await ensure())) return false;
    const mods = spec.mods.reduce((m, n) => m | HID_MODS[n], 0);
    const usage = KEY_USAGE[norm(spec.key)] ?? (SHIFTED[spec.key] ? SHIFTED[spec.key][0] : undefined);
    if (usage === undefined) throw new Error(`No HID usage for '${spec.key}'.`);
    const shift = SHIFTED[spec.key] ? 0x02 : 0;
    report(mods | shift, [usage]);
    await sleep(holdMs);
    report(0, []);
    return true;
  }

  async function pressKey(spec, repeat = 1, { holdMs = 45 } = {}) {
    for (let i = 0; i < repeat; i++) if (!(await press(spec, { holdMs }))) return false;
    return true;
  }

  /** Returns the list of characters that had no HID mapping (caller can fall back to `input text`). */
  async function typeText(text, { keyDelayMs = 22, enter = false } = {}) {
    if (!(await ensure())) return { ok: false, unmapped: [...text] };
    const unmapped = [];
    for (const ch of text) {
      const k = charToKey(ch);
      if (!k) { unmapped.push(ch); continue; }
      report(k.shift ? 0x02 : 0, [k.usage]);
      await sleep(keyDelayMs);
      report(0, []);
      await sleep(6);
    }
    if (enter) { report(0, [0x28]); await sleep(45); report(0, []); }
    return { ok: true, unmapped };
  }

  // Ctrl+A then Backspace: the reliable "clear field" for a real keyboard.
  async function selectAllAndDelete() {
    const ok = await pressKey({ label: 'Ctrl+A', mods: ['ctrl'], key: 'a' });
    if (!ok) return false;
    await sleep(120);
    return pressKey({ label: 'Delete', mods: [], key: 'delete' });
  }

  process.on('exit', () => { try { proc && proc.kill('SIGKILL'); } catch {} });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { proc && proc.kill('SIGKILL'); } catch {} });

  return { attach, ensure, detach, status, press, pressKey, typeText, selectAllAndDelete, resolveKeySpec };
}
