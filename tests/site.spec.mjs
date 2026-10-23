import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';

const PAGES = [
  { name: 'ar-home', path: '/', dir: 'rtl' },
  { name: 'ar-menu', path: '/menu/', dir: 'rtl' },
  { name: 'en-home', path: '/en/', dir: 'ltr' },
  { name: 'en-menu', path: '/en/menu/', dir: 'ltr' },
];
const WIDTHS = [320, 375, 768, 1280];
mkdirSync('screenshots', { recursive: true });

// Loads lazy images so full-page screenshots and overflow checks see the real layout.
async function settle(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 40));
    }
    scrollTo({ top: 0, behavior: 'instant' });
    const visible = [...document.images].filter((img) => img.offsetParent !== null && !img.complete);
    const loaded = Promise.all(visible.map((img) => new Promise((r) => { img.onload = img.onerror = r; })));
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);
  });
}

const targets = () =>
  [...document.querySelectorAll('a[href], button, summary')]
    .filter((el) => el.offsetParent !== null && !el.classList.contains('skip') && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => ({ el, r: el.getBoundingClientRect() }));

for (const { name, path, dir } of PAGES) {
  test.describe(name, () => {
    for (const width of WIDTHS) {
      test(`layout at ${width}px`, async ({ page }) => {
        const problems = [];
        page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
        page.on('pageerror', (e) => problems.push(e.message));
        page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`));
        await page.setViewportSize({ width, height: 844 });
        await page.goto(path, { waitUntil: 'networkidle' });
        await settle(page);

        await expect(page.locator('html')).toHaveAttribute('dir', dir);
        await expect(page.locator('h1')).toHaveCount(1);
        expect(await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth), 'horizontal overflow').toBeLessThanOrEqual(0);

        const small = await page.evaluate(`(${targets})().filter(({ r }) => r.width < 44 || r.height < 44).map(({ el, r }) => el.tagName + ' "' + el.textContent.trim().slice(0, 30) + '" ' + Math.round(r.width) + '×' + Math.round(r.height))`);
        expect(small, 'tap targets under 44px').toEqual([]);

        const tight = await page.evaluate(`(() => { const rs = (${targets})(); const out = [];
          for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
            const a = rs[i].r, b = rs[j].r;
            if (rs[i].el.contains(rs[j].el) || rs[j].el.contains(rs[i].el)) continue;
            const gx = Math.max(b.left - a.right, a.left - b.right), gy = Math.max(b.top - a.bottom, a.top - b.bottom);
            if (gx < 8 && gy < 8) out.push(rs[i].el.textContent.trim().slice(0, 20) + ' ↔ ' + rs[j].el.textContent.trim().slice(0, 20));
          } return out; })()`);
        expect(tight, 'targets closer than 8px').toEqual([]);

        expect(problems, 'console errors / failed requests').toEqual([]);
        await page.screenshot({ path: `screenshots/${name}-${width}.png`, fullPage: true });
      });
    }

    test('axe: no serious or critical violations', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      await settle(page);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });

    test('visible focus on keyboard navigation', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        const o = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
        expect(o.style).not.toBe('none');
        expect(o.width).toBeGreaterThanOrEqual(2);
      }
    });

    test('open-now line renders', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      await expect(page.locator('[data-status-line]').first()).toBeVisible();
      await expect(page.locator('[data-status-lead]').first()).not.toBeEmpty();
    });
  });

  test(`${name} without JavaScript keeps nav and content`, async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:4173${path}`);
    await expect(page.locator('#site-nav')).toBeVisible();
    await expect(page.locator('main h2').first()).toBeVisible();
    await ctx.close();
  });
}

test('menu page lists every section', async ({ page }) => {
  await page.goto('/menu/');
  for (const id of ['hot', 'iced', 'nuts']) await expect(page.locator(`#${id} .item`).first()).toBeVisible();
});

test('404 page is bilingual', async ({ page }) => {
  const res = await page.goto('/404.html');
  expect(res.ok()).toBeTruthy();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('[lang="en"] h2')).toBeVisible();
});
