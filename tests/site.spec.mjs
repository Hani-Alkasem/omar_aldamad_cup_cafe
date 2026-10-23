import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';

const PAGES = [
  { lang: 'ar', path: '/', dir: 'rtl' },
  { lang: 'en', path: '/en/', dir: 'ltr' },
];
const WIDTHS = [320, 375, 768, 1280];
mkdirSync('screenshots', { recursive: true });

// Loads every lazy image so full-page screenshots and overflow checks see the real layout.
async function settle(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    scrollTo(0, 0);
    const visible = [...document.images].filter((img) => img.offsetParent !== null && !img.complete);
    const loaded = Promise.all(visible.map((img) => new Promise((r) => { img.onload = img.onerror = r; })));
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);
  });
}

for (const { lang, path, dir } of PAGES) {
  test.describe(`${lang} page`, () => {
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

        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
        expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(0);

        // Every visible interactive element is at least 44×44 CSS px.
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('a[href], button, summary, [role="tab"]')]
            .filter((el) => el.offsetParent !== null && !el.classList.contains('skip'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width < 44 || r.height < 44)
            .map(({ el, r }) => `${el.tagName} "${el.textContent.trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`),
        );
        expect(small, 'tap targets under 44px').toEqual([]);

        // Neighbouring targets keep at least an 8px gap.
        const tight = await page.evaluate(() => {
          const rects = [...document.querySelectorAll('a[href], button, summary, [role="tab"]')]
            .filter((el) => el.offsetParent !== null && !el.classList.contains('skip'))
            .map((el) => ({ el, r: el.getBoundingClientRect() }));
          const out = [];
          for (let i = 0; i < rects.length; i += 1) {
            for (let j = i + 1; j < rects.length; j += 1) {
              const a = rects[i].r;
              const b = rects[j].r;
              if (rects[i].el.contains(rects[j].el) || rects[j].el.contains(rects[i].el)) continue;
              const gapX = Math.max(b.left - a.right, a.left - b.right);
              const gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
              if (gapX < 8 && gapY < 8) out.push(`${rects[i].el.textContent.trim().slice(0, 20)} ↔ ${rects[j].el.textContent.trim().slice(0, 20)}`);
            }
          }
          return out;
        });
        expect(tight, 'targets closer than 8px').toEqual([]);

        expect(problems, 'console errors / failed requests').toEqual([]);
        await page.screenshot({ path: `screenshots/${lang}-${width}.png`, fullPage: true });
      });
    }

    test('axe: no serious or critical violations', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      await settle(page);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });

    test('menu tabs are keyboard operable in reading direction', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(3);
      await tabs.first().focus();
      const nextKey = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      await page.keyboard.press(nextKey);
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(page.locator('#panel-iced')).toBeVisible();
      await expect(page.locator('#panel-hot')).toBeHidden();
      await page.keyboard.press('End');
      await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press(nextKey);
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(tabs.nth(0)).toBeFocused();
      await tabs.nth(2).click();
      await expect(page.locator('#panel-nuts')).toBeVisible();
    });

    test('visible focus on keyboard navigation', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        const outline = await page.evaluate(() => {
          const s = getComputedStyle(document.activeElement);
          return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
        });
        expect(outline.style).not.toBe('none');
        expect(outline.width).toBeGreaterThanOrEqual(2);
      }
    });

    test('open-now line renders', async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      await expect(page.locator('[data-status-line]')).toBeVisible();
      await expect(page.locator('[data-status-lead]')).not.toBeEmpty();
      await expect(page.locator('[data-status-rest]')).not.toBeEmpty();
      await expect(page.locator('[data-hours-table] tr.is-today')).toHaveCount(1);
    });
  });

  test.describe(`${lang} without JavaScript`, () => {
    test.use({ javaScriptEnabled: false });
    test('all content readable, menu stacked', async ({ page }) => {
      await page.goto(path);
      for (const id of ['hot', 'iced', 'nuts']) await expect(page.locator(`#panel-${id}`)).toBeVisible();
      await expect(page.getByRole('tablist')).toBeHidden();
      await expect(page.locator('[data-status-week] summary')).toBeVisible();
      await expect(page.locator('#visit table')).toBeVisible();
    });
  });
}

test('404 page is bilingual', async ({ page }) => {
  const res = await page.goto('/404.html');
  expect(res.ok()).toBeTruthy();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('[lang="en"] h2')).toBeVisible();
});
