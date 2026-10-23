// Release guard. Staging: warns about demo values and placeholders. Production: fails on any.
// Usage: node scripts/check.mjs [--env=staging|production]
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const config = JSON.parse(readFileSync(`${ROOT}site.config.json`, 'utf8'));
const env = args.env || config.env;

const demo = [];
const placeholders = [];
(function walk(node, path) {
  if (node && typeof node === 'object') {
    if (node.demo === true) demo.push(path || '(root)');
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  } else if (typeof node === 'string' && /\{\{.+?\}\}/.test(node)) {
    placeholders.push(`${path} = ${node}`);
  }
})(config, '');

const errors = [];
if (env === 'production') {
  if (demo.length) errors.push(`demo data still flagged: ${demo.join(', ')}`);
  if (placeholders.length) errors.push(`unresolved placeholders: ${placeholders.join('; ')}`);
  if (/hostingersite\.com/.test(config.siteUrl)) errors.push(`siteUrl is the temporary domain (${config.siteUrl})`);
  if (!/^https:\/\//.test(config.siteUrl)) errors.push('siteUrl must be https');
  for (const [k, v] of Object.entries(config.social)) if (k !== 'demo' && !/^https:\/\//.test(v)) errors.push(`social.${k} is not a real URL (${v})`);
}

const list = (title, items) => items.length && console.log(`${title}:\n${items.map((i) => `  - ${i}`).join('\n')}`);
console.log(`check: env=${env} siteUrl=${config.siteUrl}`);
list('demo values (replace before production)', demo);
list('placeholders (resolve before production)', placeholders);
if (errors.length) {
  console.error(`check FAILED:\n${errors.map((e) => `  ✖ ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(env === 'production' ? 'check passed: ready for production' : 'check passed (staging: warnings above are allowed)');
