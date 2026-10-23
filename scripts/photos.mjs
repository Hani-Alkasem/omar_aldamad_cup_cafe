// Downloads the site photography from Unsplash (Unsplash License only, never Unsplash+),
// one master per slot at 2400px, and records photographer credit.
// Usage: node scripts/photos.mjs [--force]   Needs network access to unsplash.com and images.unsplash.com.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src/assets/photos');
const force = process.argv.includes('--force');
const slots = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(ROOT, 'photos.json'), 'utf8'))).filter(([k]) => !k.startsWith('_')));
const creditsPath = join(OUT, 'credits.json');
const credits = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, 'utf8')) : {};
mkdirSync(OUT, { recursive: true });

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

let failed = 0;
for (const [slot, ids] of Object.entries(slots)) {
  const file = join(OUT, `${slot}.jpg`);
  if (!force && existsSync(file) && credits[slot]) continue;
  let done = false;
  for (const id of ids) {
    try {
      const photo = await getJson(`https://unsplash.com/napi/photos/${id}`);
      if (photo.premium || photo.plus) {
        console.warn(`photos: ${slot} skip ${id} (Unsplash+)`);
        continue;
      }
      const res = await fetch(`${photo.urls.raw}&w=2400&q=82&fm=jpg&fit=max`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${res.status} download`);
      const buf = Buffer.from(await res.arrayBuffer());
      await sharp(buf).rotate().jpeg({ quality: 84, mozjpeg: true }).toFile(file);
      credits[slot] = {
        id,
        page: photo.links.html,
        photographer: photo.user.name,
        profile: photo.user.links.html,
        description: photo.alt_description ?? photo.description ?? '',
        license: 'Unsplash License (https://unsplash.com/license)',
      };
      console.log(`photos: ${slot} ← ${id} by ${photo.user.name}`);
      done = true;
      break;
    } catch (err) {
      console.warn(`photos: ${slot} ${id} failed (${err.message})`);
    }
  }
  if (!done) failed += 1;
}
writeFileSync(creditsPath, JSON.stringify(credits, null, 2) + '\n');
if (failed) {
  console.error(`photos: ${failed} slot(s) without a photo`);
  process.exit(1);
}
