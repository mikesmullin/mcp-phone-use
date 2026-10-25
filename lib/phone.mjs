// Phone control over ADB: screenshots, taps, text, keyevents/key-chords, UI dumps.
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCmd } from './spawn.mjs';
import { createViews, renderView } from './views.mjs';
import { resolveKeySpec } from './hidkbd.mjs';

const SCRIPT_UI = fileURLToPath(new URL('../scripts/ui-dump.py', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Android KeyEvent codes (verified on the tested Android 17 device).
const MODIFIERS = {
  ctrl: 291, ctrlLeft: 291, ctrlRight: 292,
  alt: 57, altLeft: 57, altRight: 58,
  shift: 59, shiftLeft: 59, shiftRight: 60,
  meta: 293, metaLeft: 293, metaRight: 294, sym: 63, fn: 154,
};
const MOD_CODES = new Set(Object.values(MODIFIERS));

const KEYCODES = {
  back: 4, home: 3, enter: 66, space: 62, tab: 61,
  shift: 60, shiftL: 59, shiftR: 60, delete: 67,
  volumeUp: 24, volumeDown: 25, power: 26,
  dpadUp: 39, dpadDown: 40, dpadLeft: 41, dpadRight: 42, dpadCenter: 38,
  menu: 17, moveHome: 122, moveEnd: 123, forwardDelete: 112,
  pageUp: 92, pageDown: 93, escape: 111, search: 84, app: 235,
  ...MODIFIERS,
};

// Lookups are case-insensitive: 'volumeUp', 'VOLUMEUP' and 'volumeup' all resolve.
const KEYCODES_CI = Object.fromEntries(Object.entries(KEYCODES).map(([k, v]) => [k.toLowerCase(), v]));

export function normalizeKey(key, { inChord = false } = {}) {
  const raw = String(key ?? '').trim();
  if (!raw) throw new Error('key is required');
  // A bare number is a raw keycode ("66" = Enter). Inside a chord, a single digit is the character key
  // ("Ctrl+0" -> KEYCODE_0 = 7), which is what a hardware-key chord means.
  if (/^\d+$/.test(raw) && !(inChord && raw.length === 1)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error('key must be a code 0..9999 when numeric');
    return n;
  }
  const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (KEYCODES_CI[name] !== undefined) return KEYCODES_CI[name];
  if (/^[a-z]$/.test(name)) return 29 + (name.charCodeAt(0) - 97);   // KEYCODE_A..Z = 29..54
  if (/^[0-9]$/.test(name)) return 7 + Number(name);                 // KEYCODE_0..9 = 7..16
  throw new Error(
    `Unknown key '${key}'. Use a name (Back, Home, Enter, Space, Tab, Shift, Delete, ForwardDelete, MoveHome, MoveEnd, Dpad*, Volume*, Power, Menu, Ctrl, Alt, Meta, Sym, Fn, a-z, 0-9), ` +
      `a chord ("Ctrl+A", "Shift+Tab", "Ctrl+C"), a comma-separated sequence ("Ctrl+A,Delete"), or a numeric keycode.`
  );
}

// "Ctrl+A" -> keycombination chord; "Ctrl+A,Delete" -> two ordered steps.
export function parseKeySequence(spec) {
  const items = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error('keys is required');
  return items.map((item) => {
    const parts = item.split('+').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error(`Bad key spec '${item}'.`);
    const codes = parts.map((p) => normalizeKey(p, { inChord: parts.length > 1 }));
    if (parts.length === 1) return { label: item, kind: 'keyevent', codes };
    const mods = codes.filter((c) => MOD_CODES.has(c));
    const rest = codes.filter((c) => !MOD_CODES.has(c));
    if (mods.length === 0) {
      throw new Error(`Chord '${item}' needs a modifier (Ctrl, Alt, Shift, Meta, Sym, Fn). Use commas for a sequence instead: "Delete,Delete".`);
    }
    return { label: item, kind: 'keycombination', codes: [...mods, ...rest] }; // modifier first: order matters
  });
}

const EDITABLE = /EditText|TextInput|AutoCompleteTextView|MultiAutoCompleteTextView/;

export function createPhone({ adb, render = renderView, views = createViews(), hid = null } = {}) {
  let device = null;
  const getDevice = async () => {
    if (!device) {
      const i = await adb.info();
      device = { serial: i.serial, model: i.model, android: i.android, width: i.width, height: i.height };
    }
    return device;
  };
  const geometry = async () => {
    const d = await getDevice();
    if (!d.width) throw new Error(`Could not read screen size (model=${d.model}). Run "adb shell wm size" manually to debug.`);
    return { x: 0, y: 0, width: d.width, height: d.height };
  };
  const metadata = (view, status, sent) => ({
    screenshotId: view.id,
    width: view.width,
    height: view.height,
    devicePixels: { width: view.geometry.width, height: view.geometry.height },
    coordinateSpace: 'image pixels; top-left is (0,0). Actions take x,y in THESE image pixels (server converts to device pixels).',
    device: { serial: device.serial, model: device.model, android: device.android },
    status,
    expiresInSeconds: 120,
    sent,
  });

  // Fresh full-screen capture (rendering applied by caller via render).
  const capture = async () => {
    const { path } = await adb.screenshot();
    const bytes = await readFile(path);
    await rm(path, { force: true });
    return { bytes, geometry: await geometry() };
  };

  // Observation: capture (optionally cropped), render, register view.
  const observe = async (args = {}) => {
    const g = await geometry();
    let crop = { ...g };
    const prior = args.screenshotId ? views.get(args.screenshotId) : null;
    if (prior && args.crop) crop = views.crop(prior, args.crop);
    const shot = await capture();
    const rendered = await render(shot, crop, args.maxWidth ?? (prior ? prior.maxWidth : 1280), args.grid ?? (prior ? prior.grid : false));
    const view = views.add({ geometry: g, crop, width: rendered.width, height: rendered.height, maxWidth: args.maxWidth ?? (prior ? prior.maxWidth : 1280), grid: args.grid ?? (prior ? prior.grid : false), title: 'Android' });
    const meta = metadata(view, args.status ?? 'observation', args.sent ?? []);
    return {
      content: [
        { type: 'text', text: JSON.stringify(meta) + '\nUse this screenshotId and the returned image x,y for the NEXT action; no offsets to add or subtract. Inspect the image; input delivery does not prove app success.' },
        { type: 'image', mimeType: 'image/png', data: rendered.bytes.toString('base64') },
      ],
      structuredContent: meta,
    };
  };

  // Text-only result (no image) for quota-friendly verification.
  const statusResult = (status, sent, extra = {}) => {
    const body = { status, sent, device: { serial: device.serial, model: device.model, android: device.android }, ...extra };
    return {
      content: [{ type: 'text', text: JSON.stringify(body, null, 1) + '\nNo screenshot was taken (observe:false). Call phone_ui_dump for a cheap text check, or phone_screenshot for an image.' }],
      structuredContent: body,
    };
  };

  const dumpElements = async (max = 60) => {
    const { path } = await adb.uiDump();
    const r = await runCmd('python3', [SCRIPT_UI, path, '--max', String(max)], { timeoutMs: 30000 });
    await rm(path, { force: true });
    if (!r.ok) throw new Error(`ui-dump.py failed: ${r.out}`);
    return JSON.parse(r.stdout).elements;
  };

  const tapDevicePoint = async ({ x, y }) => adb.shell(['input', 'tap', String(x), String(y)]);
  // Android 17 `input` has NO long-press command; a zero-distance swipe with a duration is the long press.
  const longPressDevicePoint = async ({ x, y, durationMs = 1200 }) =>
    adb.shell(['input', 'swipe', String(x), String(y), String(x), String(y), String(durationMs)]);

  const findLabel = (elements, label) => {
    const want = String(label).toLowerCase();
    return elements.find((e) => ((e.text || e.contentDesc || '')).toLowerCase() === want)
      || elements.find((e) => ((e.text || e.contentDesc || '')).toLowerCase().includes(want));
  };

  // Compound input action: optional click/long-press, text, keys (chords/sequences/repeat), swipe.
  const perform = async (args = {}) => {
    await getDevice();
    const steps = [];
    if (args.x !== undefined && args.y === undefined) throw new Error('click x and y must be provided together.');
    if (args.x !== undefined) {
      const view = views.get(args.screenshotId);
      views.assertGeometry(view, await geometry());
      const p = views.point(view, args.x, args.y);
      const hold = args.longPressMs ?? args.durationMs;
      if (hold) steps.push({ action: 'long-press', run: () => longPressDevicePoint({ ...p, durationMs: hold }) });
      else steps.push({ action: 'tap', run: () => tapDevicePoint(p) });
    }
    if (args.text !== undefined) {
      if (typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 4000) {
        throw new Error('text must contain 1-4000 characters');
      }
      steps.push({ action: 'type', run: async () => {
        // Preferred: real keystrokes on the virtual HID keyboard (works in every app, no IME needed).
        if (hid && await hid.ensure()) {
          const r = await hid.typeText(args.text, { enter: !!args.enter });
          if (r.ok) {
            if (r.unmapped.length) await adb.shell(['input', 'text', r.unmapped.join('')]); // non-ASCII fallback
            return;
          }
        }
        await adb.shell(['input', 'text', args.text]);
      } });
    }
    if (args.keys !== undefined) {
      const semantic = resolveKeySpec(args.keys);
      const repeat = args.repeat ?? 1;
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('repeat must be an integer 1..100');
      const label = repeat > 1 ? `${args.keys} x${repeat}` : args.keys;
      steps.push({
        action: `keys(${label})`,
        run: async () => {
          // Preferred: the virtual HID keyboard -> real hardware-key semantics (Ctrl+A works).
          if (hid && await hid.ensure()) {
            for (let i = 0; i < repeat; i++) for (const s of semantic) await hid.pressKey(s);
            return;
          }
          // Fallback: API-level injection (modifiers are often ignored by apps).
          const seq = parseKeySequence(args.keys);
          for (let i = 0; i < repeat; i++) for (const k of seq) await adb.shell(['input', k.kind, ...k.codes.map(String)]);
        },
      });
    }
    if (args.fromX !== undefined || args.toX !== undefined) {
      const view = views.get(args.screenshotId);
      views.assertGeometry(view, await geometry());
      const from = views.point(view, args.fromX, args.fromY);
      const to = views.point(view, args.toX, args.toY);
      steps.push({ action: 'swipe', run: () => adb.shell(['input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), String(args.durMs ?? 300)]) });
    }
    if (steps.length === 0) throw new Error('Nothing to do: provide at least a click, text, keys, or swipe.');

    const view = args.screenshotId ? views.get(args.screenshotId) : null;
    views.invalidate();
    const sent = [];
    try {
      for (const s of steps) { await s.run(); sent.push(s.action); }
    } catch (error) {
      throw new Error(`${error.message} — completed steps: ${sent.join(', ') || 'none'}. Do not blindly repeat; capture again first.`);
    }
    await sleep(args.waitMs ?? 500);

    if (args.observe === false) {
      return statusResult('input_sent', sent, {
        note: 'Keys/text can be sent without screenshotId when no coordinates are needed. Set observe:false to skip the screenshot (saves image quota); verify with phone_ui_dump.',
      });
    }
    try {
      return await observe({
        screenshotId: undefined,
        maxWidth: view ? view.maxWidth : undefined,
        grid: view ? view.grid : undefined,
        status: 'input_sent',
        sent,
      });
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Input was sent (${sent.join(', ')}), but the follow-up observation failed: ${error.message}. Do not repeat input; capture again with phone_screenshot.` }],
        structuredContent: { status: 'input_sent_observation_failed', sent },
      };
    }
  };

  // Clear a text field the way a finger does: long-press -> Select all -> Cut.
  // Ctrl+A via `input keycombination` is NOT honored by most app text fields (verified on Android 17),
  // so the on-screen selection toolbar is the reliable path. No screenshot is taken.
  const clearText = async (args = {}) => {
    await getDevice();
    const before = await dumpElements();
    let target = null;
    if (args.x !== undefined && args.y !== undefined) {
      const view = views.get(args.screenshotId);
      views.assertGeometry(view, await geometry());
      const p = views.point(view, args.x, args.y);
      target = before.find((e) => EDITABLE.test(e.class) && e.bounds[0] <= p.x && p.x < e.bounds[2] && e.bounds[1] <= p.y && p.y < e.bounds[3])
        || { center: [p.x, p.y], text: '' };
    } else {
      target = before.find((e) => EDITABLE.test(e.class) && e.focused)
        || before.find((e) => EDITABLE.test(e.class) && (e.text || '').length > 0);
    }
    if (!target) throw new Error('No editable field found. Pass x,y (image pixels) of the field, or focus it first.');

    const center = { x: target.center[0], y: target.center[1] };
    const beforeText = target.text || '';
    const sameField = (els) => els.find((e) => EDITABLE.test(e.class) && e.center[0] === center.x && e.center[1] === center.y);

    // Fast path: Ctrl+A + Delete on the virtual HID keyboard (a real input device, so select-all works).
    if (hid && await hid.ensure()) {
      views.invalidate();
      await hid.selectAllAndDelete();
      await sleep(450);
      const now = sameField(await dumpElements());
      if (now && !(now.text || '')) {
        return statusResult('cleared', ['hid:Ctrl+A', 'hid:Delete'], {
          field: { center, before: beforeText, after: '' }, via: 'virtual HID keyboard',
        });
      }
      // Not cleared (field empty, or the app ignores keys) -> fall through to the touch menu path.
    }

    const before2 = await dumpElements();
    const target2 = (args.x !== undefined && args.y !== undefined)
      ? (before2.find((e) => EDITABLE.test(e.class) && e.bounds[0] <= center.x && center.x < e.bounds[2] && e.bounds[1] <= center.y && center.y < e.bounds[3]) || { center: [center.x, center.y], text: beforeText })
      : (before2.find((e) => EDITABLE.test(e.class) && e.focused) || before2.find((e) => EDITABLE.test(e.class) && (e.text || '').length > 0) || { center: [center.x, center.y], text: beforeText });
    views.invalidate();
    const sent = [];
    await longPressDevicePoint({ x: target2.center[0], y: target2.center[1], durationMs: args.durationMs ?? 1200 });
    sent.push('long-press');
    await sleep(700);

    const menu = await dumpElements();
    const selectAll = findLabel(menu, 'Select all');
    if (!selectAll) {
      return statusResult('select_all_menu_missing', sent, {
        field: { center, text: beforeText },
        menu: menu.map((e) => e.text || e.contentDesc).filter(Boolean).slice(0, 12),
        note: 'The selection toolbar did not offer "Select all". The field may be empty or not editable.',
      });
    }
    await tapDevicePoint({ x: selectAll.center[0], y: selectAll.center[1] });
    sent.push('select-all');
    await sleep(700);

    const afterSelect = await dumpElements();
    const cut = findLabel(afterSelect, 'Cut');
    if (!cut) {
      return statusResult('cut_button_missing', sent, {
        field: { center, text: beforeText },
        menu: afterSelect.map((e) => e.text || e.contentDesc).filter(Boolean).slice(0, 12),
        note: 'Text is selected but no "Cut" button was found. Send keys:"Delete" (or keys:"Ctrl+C") to finish.',
      });
    }
    await tapDevicePoint({ x: cut.center[0], y: cut.center[1] });
    sent.push('cut');
    await sleep(700);

    const now = sameField(await dumpElements());
    const result = {
      status: (now?.text || '') === '' ? 'cleared' : 'not_cleared',
      sent,
      field: { center, before: beforeText, after: now ? now.text || '' : null },
      device: { serial: device.serial, model: device.model, android: device.android },
    };
    if (args.observe === false || result.status === 'cleared') return statusResult(result.status, sent, { field: result.field });
    return observe({ status: 'clear_text_check', sent });
  };

  return {
    screenshot: (args) => observe(args),
    tap: (args) => perform({ ...args, longPressMs: undefined }),
    longPress: (args) => perform(args),
    type: (args) => perform(args),
    key: (args) => perform(args),
    swipe: (args) => perform(args),
    interact: (args) => perform(args),
    clearText,
    keyboard: {
      status: () => (hid ? hid.status() : { attached: false, unavailable: true }),
      attach: async () => (hid ? { attached: await hid.attach(), ...hid.status() } : { attached: false }),
      detach: () => (hid ? hid.detach('manual') : { attached: false }),
    },
    info: () => getDevice(),
    uiDump: async (args = {}) => {
      const { path } = await adb.uiDump();
      const r = await runCmd('python3', [SCRIPT_UI, path, '--max', String(args.max ?? 40)], { timeoutMs: 30000 });
      await rm(path, { force: true });
      if (!r.ok) throw new Error(`ui-dump.py failed: ${r.out}`);
      const data = JSON.parse(r.stdout);
      return {
        content: [{ type: 'text', text: data.summary + '\n' + JSON.stringify(data.elements, null, 1) }],
        structuredContent: data,
      };
    },
    findElement: async (query) => {
      const { path } = await adb.uiDump();
      const r = await runCmd('python3', [SCRIPT_UI, path, '--query', String(query)], { timeoutMs: 30000 });
      await rm(path, { force: true });
      if (!r.ok) throw new Error(`ui-dump.py failed: ${r.out}`);
      const data = JSON.parse(r.stdout);
      return {
        content: [{ type: 'text', text: data.summary + '\n' + JSON.stringify(data.elements, null, 1) }],
        structuredContent: data,
      };
    },
  };
}
