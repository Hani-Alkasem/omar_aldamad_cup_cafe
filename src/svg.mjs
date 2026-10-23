// Authored inline SVG: icons and the pendant lamps over the menu boards.
// Only icons with the `icon-directional` class flip in RTL.

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

export const lamp = `<svg class="lamp" viewBox="0 0 60 64" width="60" height="64" aria-hidden="true" focusable="false"><path d="M30 0v22" stroke="currentColor" stroke-width="2"/><path d="M8 44a22 22 0 0 1 44 0z" fill="currentColor"/><ellipse class="lamp-bulb" cx="30" cy="46" rx="12" ry="3"/></svg>`;
