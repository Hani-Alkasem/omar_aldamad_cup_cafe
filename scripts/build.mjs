// Renders Home and Menu in Arabic (/, /menu/) and English (/en/, /en/menu/) from shared templates
// and site.config.json. Usage: node scripts/build.mjs [--env=staging|production] [--out=dist] [--allow-missing-photos]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, basename, extname } from 'node:path';
import { icons } from '../src/svg.mjs';
import { spokenTime, arabicDigits } from '../src/js/time.js';

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
const i18n = { ar: readJson(join(SRC, 'i18n/ar.json')), en: readJson(join(SRC, 'i18n/en.json')) };

// ── Photos ──
const havePhotos = existsSync(join(SRC, 'assets/photos/hero.jpg'));
if (havePhotos && !existsSync(join(SRC, 'assets/img/manifest.json'))) {
  execFileSync(process.execPath, [join(ROOT, 'scripts/images.mjs')], { stdio: 'inherit' });
}
if (!havePhotos && !('allow-missing-photos' in args)) {
  throw new Error('No photos yet. Run `npm run photos` (needs unsplash.com access), or pass --allow-missing-photos for a local layout check.');
}
const imgManifest = havePhotos ? readJson(join(SRC, 'assets/img/manifest.json')) : { images: {} };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── Assets: content-hashed copies under /assets/ (1-year immutable cache) ──
const assetUrls = new Map();
function emitAsset(rel, outDir = dirname(rel), buf = readFileSync(join(SRC, rel))) {
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
if (havePhotos) for (const f of readdirSync(join(SRC, 'assets/img')).filter((f) => !f.endsWith('.json'))) emitAsset(`assets/img/${f}`);

// time.js is inlined ahead of main.js so the browser makes a single request.
const bundle = Buffer.from(
  readFileSync(join(SRC, 'js/time.js'), 'utf8').replace(/^export /gm, '') +
    '\n' +
    readFileSync(join(SRC, 'js/main.js'), 'utf8').replace(/^import .*\n/gm, ''),
);
const asset = {
  favicon: emitAsset('assets/favicon.svg'),
  js: emitAsset('js/main.js', 'assets/js', bundle),
  appleIcon: assetUrls.get('/assets/img/apple-touch-icon.png') ?? '',
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
const template = (name) => readFileSync(join(SRC, 'templates', `${name}.html`), 'utf8');

const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const hours = Object.fromEntries(DAYS.map((d) => [d, config.hours[d] ?? null]));
const range = (d, lang) => (hours[d] ? `${spokenTime(hours[d][0], lang)} – ${spokenTime(hours[d][1], lang)}` : null);
function hourGroups(t, lang) {
  const groups = [];
  for (const d of DAYS) {
    const r = range(d, lang);
    const last = groups.at(-1);
    if (last && last.r === r) last.days.push(d);
    else groups.push({ r, days: [d] });
  }
  return groups.filter((g) => g.r).map((g) => ({ days: `${t.days[g.days[0]]}${g.days.length > 1 ? `–${t.days[g.days.at(-1)]}` : ''}`, r: g.r }));
}

const SIZES = {
  hero: '100vw',
  tile: '(min-width: 64rem) 17rem, 46vw',
  feature: '(min-width: 64rem) 36rem, 100vw',
  side: '(min-width: 64rem) 30rem, 100vw',
  strip: '(min-width: 64rem) 23rem, 33vw',
};
const SLOT_SIZES = { hero: 'hero', craft: 'feature', space: 'feature', counter: 'feature', pistachio: 'side', beans: 'strip', together: 'strip', 'hot-chocolate': 'strip' };
function picture(slot, lang, sizes, { priority = false } = {}) {
  const alt = i18n[lang].alt[slot];
  const meta = imgManifest.images[slot];
  if (!meta) return `<div class="photo-missing" role="img" aria-label="${esc(alt ?? slot)}"><span>${esc(slot)}</span></div>`;
  if (alt === undefined) console.warn(`build: no ${lang} alt text for photo "${slot}"`);
  const set = (ext) => meta.widths.map((w) => `${img(`${slot}-${w}.${ext}`)} ${w}w`).join(', ');
  const fallbackW = meta.widths[Math.floor((meta.widths.length - 1) / 2)];
  const h = Math.round((meta.height / meta.width) * fallbackW);
  const loading = priority ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"';
  return `<picture><source type="image/avif" srcset="${set('avif')}" sizes="${sizes}"><source type="image/webp" srcset="${set('webp')}" sizes="${sizes}"><img src="${img(`${slot}-${fallbackW}.jpg`)}" srcset="${set('jpg')}" sizes="${sizes}" width="${fallbackW}" height="${h}" alt="${esc(alt ?? '')}" ${loading}></picture>`;
}

const allItems = config.menu.sections.flatMap((s) => s.items);
function findItem(en) {
  const item = allItems.find((i) => i.en === en);
  if (!item) throw new Error(`featured item not in menu: ${en}`);
  return item;
}

function jsonLd(lang, t, addressResolved, geoResolved) {
  const prices = allItems.map((i) => i.price);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CafeOrCoffeeShop',
    '@id': `${siteUrl}/#cafe`,
    name: config.name.full,
    alternateName: [config.name.ar, config.name.en],
    url: `${siteUrl}/`,
    ...(havePhotos ? { image: `${siteUrl}${img('og.jpg')}` } : {}),
    description: t.meta.homeDescription,
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
      name: t.menuPage.heading,
      url: `${siteUrl}${lang === 'ar' ? '/menu/' : '/en/menu/'}`,
      inLanguage: lang,
      hasMenuSection: config.menu.sections.map((s) => ({
        '@type': 'MenuSection',
        name: s[lang],
        hasMenuItem: s.items.map((i) => ({
          '@type': 'MenuItem',
          name: i[lang],
          ...(i.desc ? { description: i.desc[lang] } : {}),
          offers: { '@type': 'Offer', price: i.price, priceCurrency: config.currency.code },
        })),
      })),
    },
    ...(config.social.demo ? {} : { sameAs: [config.social.instagram, config.social.facebook].filter((u) => /^https:\/\//.test(u)) }),
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ── Pages ──
const layout = template('layout');
const pages = { home: template('home'), menu: template('menu') };
const addressResolved = !isPlaceholder(config.address.streetAddress);
const geoResolved = !isPlaceholder(config.address.geo.lat) && !isPlaceholder(config.address.geo.lng);
const showDemo = !isProd; // staging always discloses sample data and stock photography
const urlFor = (lang, page) => `${lang === 'ar' ? '' : '/en'}${page === 'home' ? '/' : '/menu/'}`;

for (const lang of ['ar', 'en']) {
  const t = i18n[lang];
  const other = lang === 'ar' ? 'en' : 'ar';
  const nf = new Intl.NumberFormat(t.locale);
  const price = (p) => `<data value="${p}">${nf.format(p)}</data> <span class="currency">${esc(config.currency.label[lang])}</span>`;
  const addressText = addressResolved ? `${config.address.streetAddress}${lang === 'ar' ? '، ' : ', '}${t.city}` : t.city;
  const photo = new Proxy({}, { get: (_, slot) => picture(slot, lang, SIZES[SLOT_SIZES[slot] ?? 'tile'], { priority: slot === 'hero' }) });

  const statusLine = `<div class="status" data-status data-hours="${esc(JSON.stringify(hours))}" data-tz="${esc(config.timezone)}" data-lang="${lang}" data-open-lead="${esc(t.status.openLead)}" data-open-rest="${esc(t.status.openRest)}" data-closed-lead="${esc(t.status.closedLead)}" data-closed-rest="${esc(t.status.closedRest)}" data-today="${esc(t.status.today)}" data-tomorrow="${esc(t.status.tomorrow)}" data-days="${esc(JSON.stringify(t.days))}"><p class="status-line" data-status-line hidden><span class="status-dot" aria-hidden="true"></span><strong data-status-lead></strong><span data-status-rest></span></p></div>`;

  const sectionOf = (it) => config.menu.sections.find((s) => s.items.includes(it)).id;
  const featuredTiles = config.featured
    .map(({ item, photo: slot }) => {
      const it = findItem(item);
      return `<li class="tile"><a href="${urlFor(lang, 'menu')}#${sectionOf(it)}"><div class="tile-media">${picture(slot, lang, SIZES.tile)}</div><h3 class="tile-name">${esc(it[lang])}</h3><p class="tile-alt" lang="${other}">${esc(it[other])}</p><p class="tile-desc">${esc(it.desc[lang])}</p><p class="tile-price">${price(it.price)}</p></a></li>`;
    })
    .join('\n');
  const nuts = config.menu.sections.find((s) => s.id === 'nuts');
  const flavourItems = nuts.items.map((it) => `<li><span>${esc(it[lang])}</span><span class="flavour-price">+${price(it.price)}</span></li>`).join('\n');

  const hoursRows = DAYS.map((d) => `<tr data-day="${d}"><th scope="row">${esc(t.days[d])}</th><td>${range(d, lang) ? `<bdi>${esc(range(d, lang))}</bdi>` : '—'}</td></tr>`).join('\n');
  const hoursCompact = hourGroups(t, lang).map((g) => `<p>${esc(g.days)}<br><bdi>${esc(g.r)}</bdi></p>`).join('');

  const jumpLinks = config.menu.sections.map((s) => `<li><a href="#${s.id}">${esc(s[lang])}</a></li>`).join('\n');
  const menuSections = config.menu.sections
    .map((s, i) => {
      const items = s.items
        .map((it) => `<li class="item"><div class="item-head"><h3 class="item-name">${esc(it[lang])}</h3><span class="item-price">${price(it.price)}</span></div><p class="item-alt" lang="${other}">${esc(it[other])}</p>${it.desc ? `<p class="item-desc">${esc(it.desc[lang])}</p>` : ''}</li>`)
        .join('\n');
      return `<section class="menu-section${i % 2 ? ' menu-section-flip' : ''}" id="${s.id}" aria-labelledby="${s.id}-title">
<div class="wrap menu-grid">
<div class="menu-media">${picture(s.photo, lang, SIZES.side)}</div>
<div class="menu-list"><h2 id="${s.id}-title">${esc(s[lang])}</h2>${s.note ? `<p class="menu-note">${esc(s.note[lang])}</p>` : ''}<ul class="items">${items}</ul></div>
</div>
</section>`;
    })
    .join('\n');

  for (const page of ['home', 'menu']) {
    const path = urlFor(lang, page);
    const hero = imgManifest.images.hero;
    const heroSet = hero ? hero.widths.map((w) => `${img(`hero-${w}.avif`)} ${w}w`).join(', ') : '';
    const preloads = [
      page === 'home' && hero ? `<link rel="preload" as="image" type="image/avif" href="${img(`hero-${hero.widths[1]}.avif`)}" imagesrcset="${heroSet}" imagesizes="${SIZES.hero}" fetchpriority="high">` : '',
      `<link rel="preload" as="font" type="font/woff2" href="${font(lang === 'ar' ? 'ibm-plex-sans-arabic-arabic-600-normal' : 'ibm-plex-sans-latin-500-normal')}" crossorigin>`,
    ].filter(Boolean).join('\n');

    const ctx = {
      lang,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      page,
      t,
      c: config,
      asset,
      css,
      title: page === 'home' ? t.meta.homeTitle : t.meta.menuTitle,
      description: page === 'home' ? t.meta.homeDescription : t.meta.menuDescription,
      robotsMeta: isProd ? '' : '<meta name="robots" content="noindex, nofollow">',
      canonical: `${siteUrl}${path}`,
      urlAr: `${siteUrl}${urlFor('ar', page)}`,
      urlEn: `${siteUrl}${urlFor('en', page)}`,
      ogImage: havePhotos ? `${siteUrl}${img('og.jpg')}` : '',
      ogLocale: lang === 'ar' ? 'ar_SY' : 'en_GB',
      paths: { home: urlFor(lang, 'home'), menu: urlFor(lang, 'menu'), alt: urlFor(other, page) },
      current: { home: page === 'home' ? ' aria-current="page"' : '', menu: page === 'menu' ? ' aria-current="page"' : '' },
      preloads,
      jsonld: jsonLd(lang, t, addressResolved, geoResolved),
      demoBanner: showDemo
        ? `<div class="demo-banner" data-demo-banner role="note"><p>${esc(t.demo.text)}</p><button type="button" class="demo-dismiss" data-demo-dismiss aria-label="${esc(t.demo.dismiss)}">${icons.close}</button></div>`
        : '',
      statusLine,
      photo,
      featuredTiles,
      flavourItems,
      hoursRows,
      hoursCompact,
      jumpLinks,
      menuSections,
      addressText,
      arrowIcon: icons.arrow,
      pinIcon: icons.pin,
      phoneIcon: icons.phone,
      chatIcon: icons.chat,
      menuIcon: icons.menu,
      callLabel: t.visit.call.replace(/ /g, '\u00a0'),
      telHref: config.contact.phone.replace(/[^\d+]/g, ''),
      phoneDisplay: (lang === 'ar' ? arabicDigits(config.contact.phone) : config.contact.phone).replace(/ /g, '\u00a0'),
      waNumber: config.contact.whatsapp.replace(/\D/g, ''),
      year: nf.format(new Date().getFullYear()).replace(/[٬,]/g, ''),
    };
    ctx.content = render(pages[page], ctx);
    mkdirSync(join(OUT, path), { recursive: true });
    writeFileSync(join(OUT, path, 'index.html'), render(layout, ctx));
  }
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
<p class="logo" lang="ar">كُوب</p>
<h1>${esc(ar.heading)}</h1>
<p>${esc(ar.body)}</p>
<p><a class="btn btn-primary" href="/">${esc(ar.home)}</a></p>
<div lang="en" dir="ltr" class="not-found-en">
<h2>${esc(en.heading)}</h2>
<p>${esc(en.body)}</p>
<p><a class="btn btn-primary" href="/en/">${esc(en.home)}</a></p>
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
      ...(havePhotos ? [{ src: img('icon-192.png'), sizes: '192x192', type: 'image/png' }, { src: img('icon-512.png'), sizes: '512x512', type: 'image/png' }] : []),
      { src: asset.favicon, sizes: 'any', type: 'image/svg+xml' },
    ],
  }, null, 2) + '\n',
);

writeFileSync(join(OUT, 'robots.txt'), isProd ? `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');

if (isProd) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = (page) => {
    const alt = `<xhtml:link rel="alternate" hreflang="ar" href="${siteUrl}${urlFor('ar', page)}"/><xhtml:link rel="alternate" hreflang="en" href="${siteUrl}${urlFor('en', page)}"/><xhtml:link rel="alternate" hreflang="x-default" href="${siteUrl}${urlFor('ar', page)}"/>`;
    return ['ar', 'en'].map((l) => `<url><loc>${siteUrl}${urlFor(l, page)}</loc><lastmod>${today}</lastmod>${alt}</url>`).join('\n');
  };
  writeFileSync(
    join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entry('home')}
${entry('menu')}
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
  RewriteRule ^(en|menu|en/menu)$ /$1/ [L,R=301]
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

console.log(`build: ${config.env} → ${OUT} (${siteUrl})${havePhotos ? '' : ' [no photos: layout check only]'}`);
