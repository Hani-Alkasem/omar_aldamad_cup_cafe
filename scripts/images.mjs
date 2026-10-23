// Extracts the interior renders from "COFFE CUP.pdf" and writes responsive AVIF/WebP/JPEG sets
// plus the Open Graph image and app icons. Output: src/assets/img/ + src/assets/img/manifest.json
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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

  // The café's own line-art mural (shelf, NATURAL/COSY plaques, five baristas), cut out of the
  // mural-wall render as ink on transparent: dark, low-chroma pixels keep; wall, shadow and plants drop.
  {
    const box = { left: 80, top: 330, width: 760, height: 317 };
    const { data, info } = await sharp(join(tmp, 'img-007-010.jpg')).extract(box).raw().toBuffer({ resolveWithObject: true });
    const ink = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0, j = 0; i < data.length; i += info.channels, j += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const plant = Math.max(r, g, b) - Math.min(r, g, b) > 38 || g > r + 12;
      const alpha = plant ? 0 : Math.min(1, Math.max(0, (92 - lum) / 40));
      ink.set([17, 17, 17, Math.round(alpha * 255)], j);
    }
    // Drop specks (plant tips, render noise): connected ink blobs under 40px at source size.
    const W = info.width;
    const H = info.height;
    const seen = new Uint8Array(W * H);
    for (let start = 0; start < W * H; start += 1) {
      if (seen[start] || ink[start * 4 + 3] < 40) continue;
      const blob = [start];
      seen[start] = 1;
      for (let n = 0; n < blob.length; n += 1) {
        const p = blob[n];
        const x = p % W;
        for (const q of [p - 1, p + 1, p - W, p + W]) {
          if (q < 0 || q >= W * H || seen[q] || ink[q * 4 + 3] < 40) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
          seen[q] = 1;
          blob.push(q);
        }
      }
      if (blob.length < 40) for (const p of blob) ink[p * 4 + 3] = 0;
    }

    // Upscale 2x, then steepen the alpha ramp so edges stay crisp at display size.
    const MASTER = info.width * 2;
    const up = await sharp(ink, { raw: { width: info.width, height: info.height, channels: 4 } })
      .resize({ width: MASTER, kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let k = 3; k < up.data.length; k += 4) {
      up.data[k] = Math.round(Math.min(1, Math.max(0, (up.data[k] / 255 - 0.42) / 0.3)) * 255);
    }
    const master = sharp(up.data, { raw: { width: up.info.width, height: up.info.height, channels: 4 } }).png();
    const masterBuf = await master.toBuffer();
    const widths = [640, 1100, MASTER];
    for (const w of widths) {
      const base = sharp(masterBuf).resize({ width: w });
      await base.clone().avif({ quality: 60, effort: 6 }).toFile(join(OUT, `wall-mural-${w}.avif`));
      await base.clone().webp({ quality: 80, alphaQuality: 90, effort: 6 }).toFile(join(OUT, `wall-mural-${w}.webp`));
      await base.clone().png({ compressionLevel: 9, palette: true }).toFile(join(OUT, `wall-mural-${w}.png`));
    }
    manifest.images['wall-mural'] = { zone: 'wallMural', width: up.info.width, height: up.info.height, widths, origin: 'COFFE CUP.pdf, image 007-010, mural region cut out as ink' };
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

  // Provenance: embed each raster's origin with Impeccable's embed-prompt when the launcher is available.
  const launcher = join(ROOT, '.claude/skills/impeccable/scripts/impeccable');
  if (existsSync(launcher)) {
    const originOf = (name) => {
      const slug = Object.keys(manifest.images).find((s) => name.startsWith(`${s}-`));
      if (name.startsWith('wall-mural-')) return 'Origin: COFFE CUP.pdf, image 007-010 (mural-wall render by Omar Al Masalmeh); the café\'s line-art mural cut out as ink on transparent by scripts/images.mjs.';
      if (slug) return `Origin: ${manifest.images[slug].origin} (3D interior render by Omar Al Masalmeh), resized by scripts/images.mjs. Not a photograph.`;
      if (name === 'og.jpg') return 'Origin: COFFE CUP.pdf, image 002-000 (entrance render), cropped to 1200x630 by scripts/images.mjs.';
      return 'Origin: rendered from src/assets/favicon.svg (authored for this site) by scripts/images.mjs.';
    };
    try {
      for (const name of readdirSync(OUT).filter((f) => f !== 'manifest.json')) {
        execFileSync(launcher, ['embed-prompt', join(OUT, name), '--prompt', originOf(name)], { stdio: 'ignore' });
      }
    } catch (err) {
      console.warn(`images: provenance not embedded (${err.message.split('\n')[0]})`);
    }
  }
  console.log(`images: ${RENDERS.length} renders → ${OUT}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
