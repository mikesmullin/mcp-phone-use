import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from './spawn.mjs';

const script = fileURLToPath(new URL('../scripts/screenshot-view.py', import.meta.url));

// Renders the device screenshot with crop/scale/grid. Returns { width, height, bytes, geometry }.
export async function renderView(shot, crop, maxWidth, grid) {
  const dir = await mkdtemp(join('/tmp', 'phone-view-'));
  try {
    const source = join(dir, 'source.png');
    const output = join(dir, 'view.png');
    await writeFile(source, shot.bytes);
    const options = {
      ...crop,
      maxWidth,
      grid,
      sourceWidth: shot.geometry.width,
      sourceHeight: shot.geometry.height,
    };
    const r = await runCmd('python3', [script, source, output, JSON.stringify(options)]);
    if (!r.ok) throw new Error(`Screenshot rendering failed (requires Python Pillow): ${r.out}`);
    const dimensions = JSON.parse(r.stdout);
    return { ...dimensions, bytes: await readFile(output) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createViews({ now = Date.now, ttlMs = 120000, limit = 16 } = {}) {
  const views = new Map();
  const versions = new Map();
  const version = (k) => (versions.get(k) ?? 0);

  const add = (view) => {
    const id = randomUUID();
    views.set(id, { ...view, id, version: version('device'), time: now() });
    while (views.size > limit) views.delete(views.keys().next().value);
    return views.get(id);
  };

  const get = (id) => {
    const s = views.get(id);
    if (!s) throw new Error('Unknown screenshotId. Call phone_screenshot and use its returned ID.');
    if (now() - s.time > ttlMs) throw new Error('Stale screenshotId. Use the latest returned screenshot or capture again.');
    if (s.version !== version('device')) throw new Error('Stale screenshotId. Use the latest returned screenshot or capture again.');
    return s;
  };

  const point = (s, x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= s.width || y >= s.height) {
      throw new Error(`Point outside ${s.width}x${s.height} screenshot. Use image pixels, not device coordinates.`);
    }
    return {
      x: s.crop.x + Math.min(s.crop.width - 1, Math.floor((x * s.crop.width) / s.width)),
      y: s.crop.y + Math.min(s.crop.height - 1, Math.floor((y * s.crop.height) / s.height)),
    };
  };

  const crop = (s, r) => {
    if (!r) return { ...s.crop };
    if (![r.x, r.y, r.width, r.height].every(Number.isInteger) || r.width < 1 || r.height < 1 || r.x < 0 || r.y < 0 || r.x + r.width > s.width || r.y + r.height > s.height) {
      throw new Error('Crop must be inside the referenced image, in image pixels.');
    }
    const a = point(s, r.x, r.y);
    const b = point(s, r.x + r.width, r.y + r.height);
    return { x: a.x, y: a.y, width: Math.min(s.crop.width, Math.max(1, b.x - a.x)), height: Math.min(s.crop.height, Math.max(1, b.y - a.y)) };
  };

  const assertGeometry = (s, g) => {
    if (s.geometry.x !== g.x || s.geometry.y !== g.y || s.geometry.width !== g.width || s.geometry.height !== g.height) {
      throw new Error('Device screen size changed since screenshot. Capture again; no action sent.');
    }
  };

  const invalidate = () => versions.set('device', version('device') + 1);

  return { add, get, point, crop, assertGeometry, invalidate };
}
