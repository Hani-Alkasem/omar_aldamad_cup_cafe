// Authored inline SVG: the barista mural (after the café's line-art wall), pendant lamps and icons.
// Line art is never mirrored in RTL; only icons with the `icon-directional` class flip.

const icon = (body, cls = '') =>
  `<svg class="icon${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  arrow: icon('<path d="M5 12h14M13 6l6 6-6 6"/>', 'icon-directional'),
  pin: icon('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  phone: icon('<path d="M6.5 3.5h3l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>'),
  chat: icon('<path d="M4 5h16v11H10l-6 4z"/><path d="M8 9.5h8M8 12.5h5"/>'),
  instagram: icon('<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17 7h.01"/>'),
  facebook: icon('<path d="M14.5 8H17V4.5h-2.5A4 4 0 0 0 10.5 8.5V11H8v3.5h2.5V21H14v-6.5h2.6l.6-3.5H14V8.8c0-.5.3-.8.5-.8z"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
};

const plaqueIcon = (body) =>
  `<svg class="plaque-icon" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// Fern for NATURAL, broad leaf for COSY — the two plaques on the café wall.
export const leafA = plaqueIcon('<path d="M24 42V8"/><path d="M24 14l-7-5M24 14l7-5M24 21l-9-6M24 21l9-6M24 28l-9-6M24 28l9-6M24 35l-7-5M24 35l7-5"/>');
export const leafB = plaqueIcon('<path d="M24 42c-12-6-14-19-7-30 12 3 17 16 7 30z"/><path d="M24 42c-2-9-4-17-7-30M21 26l-6-3M22 33l-6-2M20 19l-4-3"/>');

export const lamp = `<svg class="lamp" viewBox="0 0 60 64" width="60" height="64" aria-hidden="true" focusable="false"><path d="M30 0v22" stroke="currentColor" stroke-width="2"/><path d="M8 44a22 22 0 0 1 44 0z" fill="currentColor"/><ellipse class="lamp-bulb" cx="30" cy="46" rx="12" ry="3"/></svg>`;

// Figures are drawn half-length behind a counter; y=160 is the counter line.
const stroke = 'fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"';
const body = `<circle cx="62" cy="40" r="17"/><path d="M62 57v7M26 160c0-58 14-86 36-94 22 8 36 36 36 94"/><path d="M45 160v-56h34v56M45 104l5-30M79 104l-5-30"/>`;

const symbols = `
<symbol id="m-pour" viewBox="0 0 130 160">
  <path d="M45 38c-1-17 9-26 19-26 12 0 21 9 18 26-5-8-11-11-18-11-8 0-14 4-19 11z" fill="currentColor"/>
  <g ${stroke}>${body}
    <path d="M92 92c13 12 13 27 1 36"/><path d="M80 120h24v20H80zM104 124c8 0 8 12 0 12M80 124c-11-3-19-12-25-17"/>
    <path d="M55 112v22" stroke-dasharray="2 5"/>
    <path d="M30 100c-5 20 1 36 15 40"/><path d="M42 140h20l-2 20H44z"/>
  </g>
</symbol>
<symbol id="m-cup" viewBox="0 0 130 160">
  <path d="M44 36c0-16 9-24 18-24 13 0 20 9 18 24-5-6-11-9-18-9-7 0-13 3-18 9z" fill="currentColor"/>
  <g ${stroke}>${body}
    <path d="M30 100c4 18 18 24 26 18M94 100c-4 18-18 24-26 18"/>
    <path d="M53 104h18l-2 15H55z"/><path d="M58 96c-3-4 3-6 0-10M66 96c-3-4 3-6 0-10"/>
  </g>
</symbol>
<symbol id="m-tray" viewBox="0 0 130 160">
  <path d="M45 38c-1-17 9-26 19-26 12 0 21 9 18 26-5-8-11-11-18-11-8 0-14 4-19 11z" fill="currentColor"/>
  <circle cx="84" cy="26" r="7" fill="currentColor"/>
  <g ${stroke}>${body}
    <path d="M92 86c13-9 16-24 10-36M86 50h36M96 50V40h12v10M100 36c-2-3 2-5 0-8"/>
    <path d="M32 100c-5 18-1 36 6 52"/>
  </g>
</symbol>
<symbol id="m-tools" viewBox="0 0 130 160">
  <g ${stroke}>
    <path d="M8 160v-30h22v30M5 130h28M14 124h10"/>
    <path d="M44 160l-8-22 8-16h18l8 16-8 22zM40 138h26"/>
    <path d="M84 160v-36h20v36M80 124h28M94 124v-12M88 112h12"/>
    <path d="M114 146h12l-2 14h-8zM126 149c4 0 4 7 0 7"/>
  </g>
</symbol>
<symbol id="m-plant" viewBox="0 0 70 160">
  <g ${stroke}>
    <path d="M18 160l-4-24h42l-4 24zM12 136h46"/>
    <path d="M35 136V96M35 120c-14-2-20-12-18-24 12 2 18 10 18 24zM35 110c12-1 18-10 17-22-11 1-17 9-17 22zM35 100c-6-8-4-18 2-24 5 7 4 17-2 24z"/>
  </g>
</symbol>`;

const place = [
  ['m-plant', 0, 70], ['m-pour', 90, 130], ['m-tools', 250, 130], ['m-cup', 410, 130],
  ['m-plant', 560, 70], ['m-tray', 650, 130], ['m-tools', 810, 130], ['m-cup', 960, 130], ['m-plant', 1120, 70],
];

export const mural = `<svg class="mural-art" viewBox="0 -16 1200 180" preserveAspectRatio="xMidYMax slice" focusable="false">
<defs>${symbols}</defs>
${place.map(([id, x, w]) => `<use href="#${id}" x="${x}" y="0" width="${w}" height="160"/>`).join('')}
<path class="mural-shelf" d="M0 162H1200" vector-effect="non-scaling-stroke"/>
</svg>`;
