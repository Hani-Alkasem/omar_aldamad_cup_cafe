// Downloads the site photography from the Unsplash image CDN (Unsplash License), one 2400px
// master per slot listed in photos.json, and records its source in credits.json.
// Usage: npm run photos [-- --force]   Needs network access to images.unsplash.com.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src/assets/photos');
const force = process.argv.includes('--force');
const slots = Object.entries(JSON.parse(readFileSync(join(ROOT, 'photos.json'), 'utf8'))).filter(([k]) => !k.startsWith('_'));
const creditsPath = join(OUT, 'credits.json');
const credits = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, 'utf8')) : {};
mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const [slot, id] of slots) {
  const file = join(OUT, `${slot}.jpg`);
  if (!force && existsSync(file) && credits[slot]?.id === id) continue;
  const url = `https://images.unsplash.com/photo-${id}?w=2400&q=85&fm=jpg&fit=max`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await sharp(Buffer.from(await res.arrayBuffer())).rotate().jpeg({ quality: 84, mozjpeg: true }).toFile(file);
    credits[slot] = { id, source: `https://images.unsplash.com/photo-${id}`, license: 'Unsplash License (https://unsplash.com/license)' };
    console.log(`photos: ${slot} ← ${id}`);
  } catch (err) {
    failed += 1;
    console.warn(`photos: ${slot} ${id} failed (${err.message})`);
  }
}
writeFileSync(creditsPath, JSON.stringify(credits, null, 2) + '\n');
if (failed) {
  console.error(`photos: ${failed} slot(s) failed`);
  process.exit(1);
}
