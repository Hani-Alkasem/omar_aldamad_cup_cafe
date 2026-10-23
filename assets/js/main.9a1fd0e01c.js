// Times the way people say them in Daraa ("٨ الصبح", "١١ بالليل") and in casual English ("8am").
// Shared by the build (static hours) and the browser (open-now line).

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const arabicDigits = (s) => String(s).replace(/\d/g, (d) => AR_DIGITS[d]);

function spokenTime(hhmm, lang) {
  if (hhmm === '23:59') return lang === 'ar' ? 'نص الليل' : 'midnight';
  const [h, m] = hhmm.split(':').map(Number);
  const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  if (lang !== 'ar') return `${clock}${h < 12 ? 'am' : 'pm'}`;
  const part = h < 4 ? 'بالليل' : h < 12 ? 'الصبح' : h < 15 ? 'الظهر' : h < 18 ? 'العصر' : h < 21 ? 'المسا' : 'بالليل';
  return `${arabicDigits(clock)} ${part}`;
}

// Progressive enhancement only: every page is readable and navigable without this file.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Small-screen navigation: the nav collapses behind a toggle once JS is here.
function initNav() {
  const header = $('[data-header]');
  const toggle = header && $('.nav-toggle', header);
  if (!toggle) return;
  const label = $('[data-nav-label]', toggle);
  const setOpen = (open) => {
    header.toggleAttribute('data-nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    label.textContent = open ? toggle.dataset.labelClose : toggle.dataset.labelOpen;
  };
  header.setAttribute('data-nav-ready', '');
  toggle.hidden = false;
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  $$('.site-nav a', header).forEach((a) => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.hasAttribute('data-nav-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
}

// Open-now line, computed in the café's time zone rather than the visitor's.
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMinutes = (hhmm) => (hhmm === '23:59' ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

function nowIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return { day: part('weekday').toLowerCase().slice(0, 3), minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

function describe(el) {
  const hours = JSON.parse(el.dataset.hours);
  const days = JSON.parse(el.dataset.days);
  const { lang, tz } = el.dataset;
  const now = nowIn(tz);
  const today = hours[now.day];
  if (today && now.minutes >= toMinutes(today[0]) && now.minutes < toMinutes(today[1])) {
    return { now, open: true, lead: el.dataset.openLead, rest: el.dataset.openRest.replace('{time}', spokenTime(today[1], lang)) };
  }
  const start = WEEK.indexOf(now.day);
  for (let k = 0; k < 8; k += 1) {
    const day = WEEK[(start + k) % 7];
    const slot = hours[day];
    if (!slot || (k === 0 && now.minutes >= toMinutes(slot[0]))) continue;
    const when = k === 0 ? el.dataset.today : k === 1 ? el.dataset.tomorrow : days[day];
    return { now, open: false, lead: el.dataset.closedLead, rest: el.dataset.closedRest.replace('{day}', when).replace('{time}', spokenTime(slot[0], lang)) };
  }
  return null;
}

function initStatus() {
  const lines = $$('[data-status]');
  if (!lines.length) return;
  const update = () => {
    let now;
    for (const el of lines) {
      const state = describe(el);
      if (!state) continue;
      now = state.now;
      const line = $('[data-status-line]', el);
      $('[data-status-lead]', line).textContent = state.lead;
      $('[data-status-rest]', line).textContent = state.rest;
      line.classList.toggle('is-open', state.open);
      line.hidden = false;
    }
    if (!now) return;
    $$('[data-hours-table] tr[data-day]').forEach((row) => {
      const match = row.dataset.day === now.day;
      row.classList.toggle('is-today', match);
      const th = $('th', row);
      const tag = $('.today-tag', th);
      if (match && !tag) th.insertAdjacentHTML('beforeend', `<span class="today-tag">${lines[0].dataset.today}</span>`);
      if (!match && tag) tag.remove();
    });
  };
  update();
  setInterval(update, 60_000);
}

function initDemoBanner() {
  const banner = $('[data-demo-banner]');
  if (!banner) return;
  try {
    if (sessionStorage.getItem('kub-demo-dismissed') === '1') banner.hidden = true;
  } catch { /* storage unavailable: keep the notice visible */ }
  $('[data-demo-dismiss]', banner).addEventListener('click', () => {
    banner.hidden = true;
    try { sessionStorage.setItem('kub-demo-dismissed', '1'); } catch { /* ignore */ }
  });
}

initNav();
initStatus();
initDemoBanner();
