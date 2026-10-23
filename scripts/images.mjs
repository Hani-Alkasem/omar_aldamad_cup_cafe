// Turns the photo masters in src/assets/photos/ into responsive AVIF/WebP/JPEG sets, plus the
// Open Graph card and app icons. Output: src/assets/img/ + src/assets/img/manifest.json
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const PHOTOS = join(ROOT, 'src/assets/photos');
const OUT = join(ROOT, 'src/assets/img');
const WIDTHS = [480, 960, 1600];
const HERO_WIDTHS = [640, 1280, 2000];

const credits = existsSync(join(PHOTOS, 'credits.json')) ? JSON.parse(readFileSync(join(PHOTOS, 'credits.json'), 'utf8')) : {};
const slots = readdirSync(PHOTOS).filter((f) => f.endsWith('.jpg')).map((f) => f.replace(/\.jpg$/, ''));
if (!slots.length) throw new Error('No photos in src/assets/photos. Run `npm run photos` first.');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const manifest = { images: {} };

for (const slot of slots) {
  const input = sharp(join(PHOTOS, `${slot}.jpg`));
  const { width, height } = await input.metadata();
  const widths = [...new Set((slot === 'hero' ? HERO_WIDTHS : WIDTHS).map((w) => Math.min(w, width)))];
  for (const w of widths) {
    const base = input.clone().resize({ width: w, withoutEnlargement: true });
    await base.clone().avif({ quality: 52, effort: 6 }).toFile(join(OUT, `${slot}-${w}.avif`));
    await base.clone().webp({ quality: 74, effort: 6 }).toFile(join(OUT, `${slot}-${w}.webp`));
    await base.clone().jpeg({ quality: 78, mozjpeg: true, progressive: true }).toFile(join(OUT, `${slot}-${w}.jpg`));
  }
  manifest.images[slot] = { width, height, widths, credit: credits[slot] ?? null };
}

await sharp(join(PHOTOS, 'hero.jpg')).resize(1200, 630, { fit: 'cover', position: 'attention' }).jpeg({ quality: 80, mozjpeg: true }).toFile(join(OUT, 'og.jpg'));

const icon = readFileSync(join(ROOT, 'src/assets/favicon.svg'));
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await sharp(icon, { density: 600 }).resize(size, size).png().toFile(join(OUT, name));
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Provenance: embed each raster's origin with Impeccable's embed-prompt when the launcher is available.
const launcher = join(ROOT, '.claude/skills/impeccable/scripts/impeccable');
if (existsSync(launcher)) {
  const originOf = (name) => {
    const slot = name === 'og.jpg' ? 'hero' : slots.find((s) => name.startsWith(`${s}-`));
    const c = slot && credits[slot];
    if (c) return `Origin: Unsplash photo ${c.id} by ${c.photographer} (${c.page}), Unsplash License; resized by scripts/images.mjs.`;
    return 'Origin: rendered from src/assets/favicon.svg (authored for this site) by scripts/images.mjs.';
  };
  try {
    for (const name of readdirSync(OUT).filter((f) => !f.endsWith('.json'))) {
      execFileSync(launcher, ['embed-prompt', join(OUT, name), '--prompt', originOf(name)], { stdio: 'ignore' });
    }
  } catch (err) {
    console.warn(`images: provenance not embedded (${err.message.split('\n')[0]})`);
  }
}
console.log(`images: ${slots.length} photos → ${OUT}`);
