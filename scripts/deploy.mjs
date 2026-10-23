// Builds, checks and publishes dist/ to a deploy branch that Hostinger auto-deploys.
// Usage: node scripts/deploy.mjs staging
//        node scripts/deploy.mjs production --approved
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const [env, ...flags] = process.argv.slice(2);
if (!['staging', 'production'].includes(env)) {
  console.error('usage: node scripts/deploy.mjs <staging|production> [--approved]');
  process.exit(1);
}
if (env === 'production' && !flags.includes('--approved')) {
  console.error('production deploys need --approved (only after the customer signs off)');
  process.exit(1);
}

const branch = `deploy-${env}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
const git = (args, opts = {}) => (execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }) ?? '').trim();

run(process.execPath, ['scripts/build.mjs', `--env=${env}`]);
run(process.execPath, ['scripts/check.mjs', `--env=${env}`]);

const source = git(['rev-parse', '--short', 'HEAD']);
const dirty = git(['status', '--porcelain', '--', 'src', 'scripts', 'site.config.json']) ? '-dirty' : '';
const work = mkdtempSync(join(tmpdir(), `kub-${branch}-`));

let remoteExists = true;
try {
  git(['fetch', 'origin', branch], { stdio: 'ignore' });
} catch {
  remoteExists = false;
}

try {
  if (remoteExists) git(['worktree', 'add', '-B', branch, work, `origin/${branch}`]);
  else {
    git(['worktree', 'add', '--detach', work]);
    git(['checkout', '--orphan', branch], { cwd: work });
  }
  for (const entry of readdirSync(work)) if (entry !== '.git') rmSync(join(work, entry), { recursive: true, force: true });
  cpSync(join(ROOT, 'dist'), work, { recursive: true });

  git(['add', '-A'], { cwd: work });
  if (!git(['status', '--porcelain'], { cwd: work })) {
    console.log(`deploy: ${branch} already up to date`);
  } else {
    git(['commit', '-q', '-m', `Deploy ${env} build from ${source}${dirty}`], { cwd: work });
    let pushed = false;
    for (const wait of [0, 2, 4, 8, 16]) {
      if (wait) execFileSync('sleep', [String(wait)]);
      try {
        git(['push', '-u', 'origin', branch], { cwd: work, stdio: 'inherit' });
        pushed = true;
        break;
      } catch {
        console.warn(`deploy: push failed${wait < 16 ? ', retrying' : ''}`);
      }
    }
    if (!pushed) throw new Error(`could not push ${branch}`);
    console.log(`deploy: pushed ${branch} (${source}${dirty}); Hostinger auto-deploys it in ~1 minute`);
  }
} finally {
  try { git(['worktree', 'remove', '--force', work]); } catch { rmSync(work, { recursive: true, force: true }); }
}
