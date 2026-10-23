// Extracts the interior renders from "COFFE CUP.pdf" and writes responsive AVIF/WebP/JPEG sets
// plus the Open Graph image and app icons. Output: src/assets/img/ + src/assets/img/manifest.json
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const PDF = join(ROOT, 'COFFE CUP.pdf');
const OUT = join(ROOT, 'src/assets/img');
const WIDTHS = [480, 960, 1600];

// pdfimages -p names files <prefix>-<page>-<index>, indexes counted from the first extracted page;
// the skipped indexes are the cover stock photo, slide decorations and the thank-you slide.
const RENDERS = [
  { slug: 'entrance', file: '002-000', zone: 'entrance' },
  { slug: 'seating', file: '003-002', zone: 'seating' },
  { slug: 'feature-wall', file: '004-003', zone: 'featureWall' },
  { slug: 'bar', file: '005-006', zone: 'bar' },
  { slug: 'service', file: '006-008', zone: 'service' },
  { slug: 'mural', file: '007-010', zone: 'mural' },
  { slug: 'counter', file: '008-011', zone: 'counter' },
];

if (!existsSync(PDF)) throw new Error(`Missing ${PDF}`);
const tmp = mkdtempSync(join(tmpdir(), 'kub-img-'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

try {
  execFileSync('pdfimages', ['-j', '-p', '-f', '2', '-l', '8', PDF, join(tmp, 'img')]);
  const manifest = { source: 'COFFE CUP.pdf (3D renders by Omar Al Masalmeh)', images: {} };

  for (const { slug, file, zone } of RENDERS) {
    const src = join(tmp, `img-${file}.jpg`);
    const input = sharp(src).rotate();
    const { width, height } = await input.metadata();
    const widths = [...new Set(WIDTHS.map((w) => Math.min(w, width)))];
    for (const w of widths) {
      const base = input.clone().resize({ width: w, withoutEnlargement: true });
      await base.clone().avif({ quality: 50, effort: 6 }).toFile(join(OUT, `${slug}-${w}.avif`));
      await base.clone().webp({ quality: 72, effort: 6 }).toFile(join(OUT, `${slug}-${w}.webp`));
      await base.clone().jpeg({ quality: 76, mozjpeg: true, progressive: true }).toFile(join(OUT, `${slug}-${w}.jpg`));
    }
    manifest.images[slug] = { zone, width, height, widths, origin: `COFFE CUP.pdf, image ${file}` };
  }

  // Open Graph card: entrance render, 1200x630 crop
  await sharp(join(tmp, 'img-002-000.jpg'))
    .resize(1200, 630, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(join(OUT, 'og.jpg'));

  // App icons from the favicon SVG
  const icon = readFileSync(join(ROOT, 'src/assets/favicon.svg'));
  await sharp(icon, { density: 600 }).resize(180, 180).png().toFile(join(OUT, 'apple-touch-icon.png'));
  await sharp(icon, { density: 600 }).resize(192, 192).png().toFile(join(OUT, 'icon-192.png'));
  await sharp(icon, { density: 600 }).resize(512, 512).png().toFile(join(OUT, 'icon-512.png'));

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`images: ${RENDERS.length} renders → ${OUT}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
