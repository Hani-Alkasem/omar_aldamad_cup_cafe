// Renders the Arabic (/) and English (/en/) pages from one template and site.config.json.
// Usage: node scripts/build.mjs [--env=staging|production] [--out=dist]
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, basename, extname } from 'node:path';
import { icons, leafA, leafB, lamp, mural } from '../src/svg.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const config = readJson(join(ROOT, 'site.config.json'));
if (args.env) config.env = args.env;
if (!['staging', 'production'].includes(config.env)) throw new Error(`Unknown env "${config.env}"`);
const OUT = join(ROOT, args.out || 'dist');
const siteUrl = config.siteUrl.replace(/\/$/, '');
const isProd = config.env === 'production';

if (!existsSync(join(SRC, 'assets/img/manifest.json'))) {
  execFileSync(process.execPath, [join(ROOT, 'scripts/images.mjs')], { stdio: 'inherit' });
}
const imgManifest = readJson(join(SRC, 'assets/img/manifest.json'));
const i18n = { ar: readJson(join(SRC, 'i18n/ar.json')), en: readJson(join(SRC, 'i18n/en.json')) };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── Assets: content-hashed copies under /assets/ (served with a 1-year immutable cache) ──
const assetUrls = new Map();
function emitAsset(rel, outDir = dirname(rel)) {
  const buf = readFileSync(join(SRC, rel));
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const ext = extname(rel);
  const outRel = join(outDir, `${basename(rel, ext)}.${hash}${ext}`);
  mkdirSync(join(OUT, outDir), { recursive: true });
  writeFileSync(join(OUT, outRel), buf);
  const url = `/${outRel}`;
  assetUrls.set(`/${rel}`, url);
  return url;
}
for (const f of readdirSync(join(SRC, 'assets/fonts')).filter((f) => f.endsWith('.woff2'))) emitAsset(`assets/fonts/${f}`);
for (const f of readdirSync(join(SRC, 'assets/img')).filter((f) => f !== 'manifest.json')) emitAsset(`assets/img/${f}`);
const asset = {
  favicon: emitAsset('assets/favicon.svg'),
  js: emitAsset('js/main.js', 'assets/js'),
  appleIcon: assetUrls.get('/assets/img/apple-touch-icon.png'),
};
const img = (name) => assetUrls.get(`/assets/img/${name}`);
const font = (name) => assetUrls.get(`/assets/fonts/${name}.woff2`);

const cssSource = readFileSync(join(SRC, 'css/main.css'), 'utf8');
// RTL guard (CLAUDE.md): layout CSS uses logical properties only.
const physical = cssSource.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) =>
  /(^|[\s;{])(margin|padding|border)-(left|right)\b|(^|[\s;{])(left|right)\s*:|text-align:\s*(left|right)|float:\s*(left|right)/.test(line));
if (physical.length) throw new Error(`Physical left/right in main.css (use logical properties):\n${physical.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')}`);
const css = cssSource
  .replace(/\/assets\/fonts\/[\w.-]+\.woff2/g, (m) => assetUrls.get(m) ?? m)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s*\n\s*/g, '\n')
  .trim();
const cssHash = createHash('sha256').update(css).digest('base64');

// ── Helpers ──
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isPlaceholder = (v) => typeof v === 'string' && /\{\{.+\}\}/.test(v);
const hasDemo = (o) => o && typeof o === 'object' && (o.demo === true || Object.values(o).some(hasDemo));
const get = (ctx, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
function render(tpl, ctx) {
  const resolve = (path) => {
    const v = get(ctx, path.trim());
    if (v === undefined) throw new Error(`Template value missing: ${path}`);
    return v;
  };
  return tpl.replace(/\{\{\{([^}]+)\}\}\}/g, (_, p) => resolve(p)).replace(/\{\{([^}]+)\}\}/g, (_, p) => esc(resolve(p)));
}

const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const hours = Object.fromEntries(DAYS.map((d) => [d, config.hours[d] ?? null]));
const numberFmt = (locale) => new Intl.NumberFormat(locale);
const toLocaleDigits = (s, locale) => s.replace(/\d/g, (d) => numberFmt(locale).format(Number(d)));
function timeFmt(hhmm, locale, midnight) {
  if (hhmm === '23:59' && midnight) return midnight;
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 1, h, m));
}
const range = (d, t) => (hours[d] ? `${timeFmt(hours[d][0], t.locale)} – ${timeFmt(hours[d][1], t.locale, t.status.midnight)}` : null);

function hoursSummary(t) {
  const groups = [];
  for (const d of DAYS) {
    const r = range(d, t);
    const last = groups.at(-1);
    if (last && last.r === r) last.days.push(d);
    else groups.push({ r, days: [d] });
  }
  return groups
    .filter((g) => g.r)
    .map((g) => `${t.days[g.days[0]]}${g.days.length > 1 ? `–${t.days[g.days.at(-1)]}` : ''} ${g.r}`)
    .join(' · ');
}

function picture(slug, alt, sizes, { priority = false } = {}) {
  const meta = imgManifest.images[slug];
  const set = (ext) => meta.widths.map((w) => `${img(`${slug}-${w}.${ext}`)} ${w}w`).join(', ');
  const fallbackW = meta.widths.includes(960) ? 960 : meta.widths.at(-1);
  const h = Math.round((meta.height / meta.width) * fallbackW);
  const loading = priority ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"';
  return `<picture><source type="image/avif" srcset="${set('avif')}" sizes="${sizes}"><source type="image/webp" srcset="${set('webp')}" sizes="${sizes}"><img src="${img(`${slug}-${fallbackW}.jpg`)}" srcset="${set('jpg')}" sizes="${sizes}" width="${fallbackW}" height="${h}" alt="${esc(alt)}" ${loading}></picture>`;
}
const HERO_SIZES = '(min-width: 64rem) 36rem, (min-width: 48rem) 100vw, 1px';
const GALLERY_SIZES = '(min-width: 64rem) 24rem, (min-width: 48rem) 46vw, 48vw';
const LEAD_SIZES = '100vw';
const GALLERY = ['entrance', 'seating', 'featureWall', 'bar', 'mural', 'counter', 'service'];
const slugOf = Object.fromEntries(Object.entries(imgManifest.images).map(([slug, m]) => [m.zone, slug]));

function jsonLd(lang, t, addressResolved, geoResolved) {
  const prices = config.menu.sections.flatMap((s) => s.items.map((i) => i.price));
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CafeOrCoffeeShop',
    '@id': `${siteUrl}/#cafe`,
    name: config.name.full,
    alternateName: [config.name.ar, config.name.en],
    url: `${siteUrl}/`,
    image: `${siteUrl}${img('og.jpg')}`,
    description: t.description,
    inLanguage: lang,
    address: {
      '@type': 'PostalAddress',
      ...(addressResolved ? { streetAddress: config.address.streetAddress } : {}),
      addressLocality: config.address.addressLocality,
      addressCountry: config.address.addressCountry,
    },
    ...(geoResolved ? { geo: { '@type': 'GeoCoordinates', latitude: Number(config.address.geo.lat), longitude: Number(config.address.geo.lng) } } : {}),
    hasMap: config.address.mapsUrl,
    ...(config.contact.demo ? {} : { telephone: config.contact.phone.replace(/\s+/g, '') }),
    openingHoursSpecification: DAYS.filter((d) => hours[d]).map((d) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: `https://schema.org/${{ sat: 'Saturday', sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' }[d]}`,
      opens: hours[d][0],
      closes: hours[d][1],
    })),
    servesCuisine: 'Coffee',
    priceRange: `${Math.min(...prices)}–${Math.max(...prices)} ${config.currency.code}`,
    currenciesAccepted: config.currency.code,
    acceptsReservations: false,
    hasMenu: {
      '@type': 'Menu',
      name: t.menu.heading,
      inLanguage: lang,
      hasMenuSection: config.menu.sections.map((s) => ({
        '@type': 'MenuSection',
        name: s[lang],
        hasMenuItem: s.items.map((i) => ({
          '@type': 'MenuItem',
          name: i[lang],
          offers: { '@type': 'Offer', price: i.price, priceCurrency: config.currency.code },
        })),
      })),
    },
    ...(config.social.demo ? {} : { sameAs: [config.social.instagram, config.social.facebook].filter((u) => /^https:\/\//.test(u)) }),
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ── Pages ──
const template = readFileSync(join(SRC, 'templates/page.html'), 'utf8');
const addressResolved = !isPlaceholder(config.address.streetAddress);
const geoResolved = !isPlaceholder(config.address.geo.lat) && !isPlaceholder(config.address.geo.lng);
const showDemo = hasDemo(config);

for (const lang of ['ar', 'en']) {
  const t = i18n[lang];
  const other = lang === 'ar' ? 'en' : 'ar';
  const nf = numberFmt(t.locale);
  const path = lang === 'ar' ? '/' : '/en/';
  const addressText = addressResolved ? `${config.address.streetAddress}${lang === 'ar' ? '، ' : ', '}${t.city}` : t.city;

  const menuTabs = config.menu.sections
    .map((s, i) => `<button type="button" role="tab" id="tab-${s.id}" aria-controls="panel-${s.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${lamp}<span class="tab-label">${esc(s[lang])}</span></button>`)
    .join('\n');
  const menuPanels = config.menu.sections
    .map((s) => {
      const items = s.items
        .map((it) => `<div class="item"><dt><span class="item-name">${esc(it[lang])}</span> <bdi class="item-alt" lang="${other}">${esc(it[other])}</bdi></dt><dd class="price"><data value="${it.price}">${nf.format(it.price)}</data> <span class="currency">${esc(config.currency.label[lang])}</span></dd></div>`)
        .join('');
      const note = s.note ? `<p class="board-note">${esc(s.note[lang])}</p>` : '';
      return `<section class="board" id="panel-${s.id}" aria-labelledby="board-${s.id}-title">
<h3 class="board-title" id="board-${s.id}-title">${esc(s[lang])} <span class="board-title-alt" lang="${other}">${esc(s[other])}</span></h3>${note}
<dl class="board-items">${items}</dl>
</section>`;
    })
    .join('\n');

  const galleryItems = GALLERY.map((zone) => {
    const z = t.gallery.zones[zone];
    return `<li${zone === 'entrance' ? ' class="is-mobile-only"' : ''}><figure class="frame">${picture(slugOf[zone], z.alt, zone === 'entrance' ? LEAD_SIZES : GALLERY_SIZES)}<figcaption><span class="frame-caption">${esc(z.caption)}</span> <span class="concept-tag">${esc(t.gallery.concept)}</span></figcaption></figure></li>`;
  }).join('\n');

  const hoursRows = DAYS.map((d) => `<tr data-day="${d}"><th scope="row">${esc(t.days[d])}</th><td>${range(d, t) ? `<bdi>${esc(range(d, t))}</bdi>` : '—'}</td></tr>`).join('\n');
  const hoursList = `<dl class="week">${DAYS.map((d) => `<div><dt>${esc(t.days[d])}</dt><dd><bdi>${esc(range(d, t) ?? '—')}</bdi></dd></div>`).join('')}</dl>`;

  const heroSet = (ext) => imgManifest.images.entrance.widths.map((w) => `${img(`entrance-${w}.${ext}`)} ${w}w`).join(', ');
  const preloads = [
    `<link rel="preload" as="image" type="image/avif" href="${img('entrance-960.avif')}" imagesrcset="${heroSet('avif')}" imagesizes="${HERO_SIZES}" media="(min-width: 48rem)" fetchpriority="high">`,
    `<link rel="preload" as="font" type="font/woff2" href="${font(lang === 'ar' ? 'ibm-plex-sans-arabic-arabic-700-normal' : 'inter-latin-600-normal')}" crossorigin>`,
  ].join('\n');

  const h1 = `<span class="h1-main" lang="ar">${esc(config.name.ar)}</span><span class="visually-hidden"> – </span><span class="h1-sub" lang="en">${esc(config.name.en)}</span>`;

  const ctx = {
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    t,
    c: config,
    asset,
    css,
    robotsMeta: isProd ? '' : '<meta name="robots" content="noindex, nofollow">',
    canonical: `${siteUrl}${path}`,
    urlAr: `${siteUrl}/`,
    urlEn: `${siteUrl}/en/`,
    ogImage: `${siteUrl}${img('og.jpg')}`,
    ogLocale: lang === 'ar' ? 'ar_SY' : 'en_GB',
    homePath: path,
    altPath: lang === 'ar' ? '/en/' : '/',
    preloads,
    jsonld: jsonLd(lang, t, addressResolved, geoResolved),
    demoBanner: showDemo
      ? `<div class="demo-banner" data-demo-banner role="note"><p>${esc(t.demo.text)}</p><button type="button" class="demo-dismiss" data-demo-dismiss aria-label="${esc(t.demo.dismiss)}">${icons.close}</button></div>`
      : '',
    h1,
    tagline: config.tagline[lang],
    hoursJson: esc(JSON.stringify(hours)),
    daysJson: esc(JSON.stringify(t.days)),
    hoursList,
    hoursRows,
    hoursSummary: hoursSummary(t),
    addressText,
    addressIcon: icons.pin,
    arrowIcon: icons.arrow,
    pinIcon: icons.pin,
    phoneIcon: icons.phone,
    chatIcon: icons.chat,
    instagramIcon: icons.instagram,
    facebookIcon: icons.facebook,
    heroPicture: picture('entrance', t.hero.imageAlt, HERO_SIZES, { priority: true }),
    heroCaption: t.gallery.zones.entrance.caption,
    mural,
    menuTabs,
    menuPanels,
    leafA,
    leafB,
    plaqueAltLang: other,
    plaqueNaturalAlt: lang === 'ar' ? 'NATURAL' : i18n.ar.values.natural,
    plaqueCosyAlt: lang === 'ar' ? 'COSY' : i18n.ar.values.cosy,
    galleryItems,
    callLabel: t.visit.call.replace(/ /g, '\u00a0'),
    telHref: config.contact.phone.replace(/[^\d+]/g, ''),
    phoneDisplay: toLocaleDigits(config.contact.phone, t.locale).replace(/ /g, '\u00a0'),
    waNumber: config.contact.whatsapp.replace(/\D/g, ''),
    year: nf.format(new Date().getFullYear()).replace(/[٬,]/g, ''),
  };

  const html = render(template, ctx);
  mkdirSync(join(OUT, path), { recursive: true });
  writeFileSync(join(OUT, path, 'index.html'), html);
}

// ── 404 ──
const ar = i18n.ar.notFound;
const en = i18n.en.notFound;
writeFileSync(
  join(OUT, '404.html'),
  `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ar.title)}</title>
<meta name="robots" content="noindex">
<link rel="icon" href="${asset.favicon}" type="image/svg+xml">
<style>${css}</style>
</head>
<body class="not-found">
<main class="wrap not-found-main">
<p class="wordmark"><span class="wordmark-ar">كُوب</span> <span class="wordmark-en" lang="en">Kub Coffee</span></p>
<h1>${esc(ar.heading)}</h1>
<p>${esc(ar.body)}</p>
<p><a class="btn btn-primary" href="/">${esc(ar.home)}</a></p>
<div lang="en" dir="ltr" class="not-found-en">
<h2>${esc(en.heading)}</h2>
<p>${esc(en.body)}</p>
<p><a class="btn btn-secondary" href="/en/">${esc(en.home)}</a></p>
</div>
</main>
</body>
</html>
`,
);

// ── Manifest, robots, sitemap, .htaccess ──
writeFileSync(
  join(OUT, 'manifest.webmanifest'),
  JSON.stringify({
    name: config.name.full,
    short_name: config.name.ar,
    lang: 'ar',
    dir: 'rtl',
    start_url: '/',
    display: 'browser',
    background_color: '#E6DCC3',
    theme_color: '#3A2A1F',
    icons: [
      { src: img('icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: img('icon-512.png'), sizes: '512x512', type: 'image/png' },
      { src: asset.favicon, sizes: 'any', type: 'image/svg+xml' },
    ],
  }, null, 2) + '\n',
);

writeFileSync(join(OUT, 'robots.txt'), isProd ? `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');

if (isProd) {
  const today = new Date().toISOString().slice(0, 10);
  const alt = `<xhtml:link rel="alternate" hreflang="ar" href="${siteUrl}/"/><xhtml:link rel="alternate" hreflang="en" href="${siteUrl}/en/"/><xhtml:link rel="alternate" hreflang="x-default" href="${siteUrl}/"/>`;
  writeFileSync(
    join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>${siteUrl}/</loc><lastmod>${today}</lastmod>${alt}</url>
<url><loc>${siteUrl}/en/</loc><lastmod>${today}</lastmod>${alt}</url>
</urlset>
`,
  );
}

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  `style-src 'self' 'sha256-${cssHash}'`,
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

writeFileSync(
  join(OUT, '.htaccess'),
  `# Generated by scripts/build.mjs (${config.env}). Hostinger / LiteSpeed.
Options -Indexes
DirectoryIndex index.html
ErrorDocument 404 /404.html

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{HTTPS} !=on
  RewriteCond %{HTTP:X-Forwarded-Proto} !=https
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
  RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]
  RewriteRule ^ https://%1%{REQUEST_URI} [L,R=301]
  RewriteRule ^en$ /en/ [L,R=301]
</IfModule>

# LiteSpeed page cache for HTML (short TTL; hashed assets are cached by the browser)
<IfModule LiteSpeed>
  CacheLookup public on
  RewriteEngine On
  RewriteRule \\.html$|/$ - [E=Cache-Control:max-age=600]
</IfModule>

AddType image/avif .avif
AddType image/webp .webp
AddType font/woff2 .woff2
AddType application/manifest+json .webmanifest
AddType image/svg+xml .svg
AddDefaultCharset utf-8

<IfModule mod_brotli.c>
  AddOutputFilterByType BROTLI_COMPRESS text/html text/plain text/css text/javascript application/javascript application/json application/ld+json application/manifest+json image/svg+xml application/xml
</IfModule>
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/javascript application/javascript application/json application/ld+json application/manifest+json image/svg+xml application/xml
</IfModule>

<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${csp}"
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  Header always set X-Frame-Options "DENY"
${isProd ? '' : '  Header always set X-Robots-Tag "noindex, nofollow"\n'}
  <FilesMatch "\\.[0-9a-f]{10}\\.(avif|webp|jpg|png|svg|woff2|js)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.(html|webmanifest|txt|xml)$">
    Header set Cache-Control "public, max-age=0, must-revalidate"
  </FilesMatch>
</IfModule>
`,
);

console.log(`build: ${config.env} → ${OUT} (${siteUrl})`);
