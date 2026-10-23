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

// Progressive enhancement only: every section is readable without this file.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Menu boards → WAI-ARIA tabs. Arrow keys follow visual direction, so in RTL ArrowLeft = next.
function initTabs() {
  const root = $('[data-tabs]');
  const list = root && $('[role="tablist"]', root);
  if (!list) return;
  const tabs = $$('[role="tab"]', list);
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));

  panels.forEach((panel, i) => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabs[i].id);
    panel.tabIndex = 0;
  });

  const select = (index, focus = false) => {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[i].hidden = !active;
    });
    if (focus) tabs[index].focus();
  };

  list.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) select(tabs.indexOf(tab));
  });

  list.addEventListener('keydown', (event) => {
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    const rtl = getComputedStyle(list).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    let next = null;
    if (step) next = (current + step + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  });

  root.dataset.enhanced = '';
  list.hidden = false;
  select(0);
}

// Open-now line, computed in the café's time zone rather than the visitor's.
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMinutes = (hhmm) => (hhmm === '23:59' ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

function nowIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return { day: part('weekday').toLowerCase().slice(0, 3), minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

function initStatus() {
  const el = $('[data-status]');
  if (!el) return;
  const hours = JSON.parse(el.dataset.hours);
  const days = JSON.parse(el.dataset.days);
  const { lang, tz } = el.dataset;
  const line = $('[data-status-line]', el);

  const update = () => {
    const now = nowIn(tz);
    const today = hours[now.day];
    const isOpen = Boolean(today && now.minutes >= toMinutes(today[0]) && now.minutes < toMinutes(today[1]));
    let lead;
    let rest;
    if (isOpen) {
      lead = el.dataset.openLead;
      rest = el.dataset.openRest.replace('{time}', spokenTime(today[1], lang));
    } else {
      const start = WEEK.indexOf(now.day);
      for (let k = 0; k < 8; k += 1) {
        const day = WEEK[(start + k) % 7];
        const slot = hours[day];
        if (!slot || (k === 0 && now.minutes >= toMinutes(slot[0]))) continue;
        const when = k === 0 ? el.dataset.today : k === 1 ? el.dataset.tomorrow : days[day];
        lead = el.dataset.closedLead;
        rest = el.dataset.closedRest.replace('{day}', when).replace('{time}', spokenTime(slot[0], lang));
        break;
      }
    }
    if (!lead) return;
    $('[data-status-lead]', line).textContent = lead;
    $('[data-status-rest]', line).textContent = rest;
    line.classList.toggle('is-open', isOpen);
    line.hidden = false;
    $('[data-status-week]', el).hidden = true;

    $$('[data-hours-table] tr[data-day]').forEach((row) => {
      const match = row.dataset.day === now.day;
      row.classList.toggle('is-today', match);
      const th = $('th', row);
      const tag = $('.today-tag', th);
      if (match && !tag) th.insertAdjacentHTML('beforeend', `<span class="today-tag">${el.dataset.today}</span>`);
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

initTabs();
initStatus();
initDemoBanner();
