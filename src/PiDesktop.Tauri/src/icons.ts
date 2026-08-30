const paths = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V20h14v-9.5"/><path d="M9 20v-6h6v6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 10 0v2M16 4a3 3 0 0 1 0 6M16 13a5 5 0 0 1 5 5v2"/>',
  toolbox: '<path d="M4 8h16v12H4z"/><path d="M9 8V5h6v3"/><path d="M4 13h16"/><path d="M10 13v2h4v-2"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6"/>',
  boxes: '<path d="m12 2 8 4-8 4-8-4 8-4Z"/><path d="m4 10 8 4 8-4M4 14l8 4 8-4M4 18l8 4 8-4"/>',
  plug: '<path d="m12 22 1-7-5-3 7-10-1 7 5 3-7 10Z"/>',
  bridge: '<path d="M5 19V9M19 19V9M3 19h18M4 9c2-5 5-6 8-6s6 1 8 6M8 9v4M16 9v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  sparkles: '<path d="m12 3-1.2 3.8L7 8l3.8 1.2L12 13l1.2-3.8L17 8l-3.8-1.2L12 3ZM5 14l-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8L5 14ZM19 13l-.8 2.2-2.2.8 2.2.8L19 19l.8-2.2L22 16l-2.2-.8L19 13Z"/>',
  audio: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h6"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M7.1 7A7 7 0 0 1 20 12M16.9 17A7 7 0 0 1 4 12"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
  pipeline: '<path d="M4 5v5a2 2 0 0 0 2 2h12"/><path d="m15 9 3 3-3 3"/><circle cx="4" cy="4" r="2"/><circle cx="4" cy="20" r="2"/><path d="M4 18v-2a4 4 0 0 1 4-4"/>',
  doctor: '<path d="M9 3h6v4H9z"/><path d="M6 5H5a2 2 0 0 0-2 2v12h18V7a2 2 0 0 0-2-2h-1"/><path d="M12 10v6M9 13h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  batch: '<rect x="3" y="4" width="13" height="13" rx="2"/><path d="M8 8h4M8 12h4M7 20h11a3 3 0 0 0 3-3V9"/>',
  sync: '<path d="M20 7h-5V2M4 17h5v5"/><path d="M5.5 9A7 7 0 0 1 18 5l2 2M18.5 15A7 7 0 0 1 6 19l-2-2"/>',
  compare: '<path d="M8 3 4 7l4 4M4 7h13a3 3 0 0 1 3 3v1M16 21l4-4-4-4M20 17H7a3 3 0 0 1-3-3v-1"/>',
  pronunciation: '<path d="M5 10a7 7 0 0 1 14 0v2a7 7 0 0 1-14 0Z"/><path d="M9 11h.01M15 11h.01M9 15c2 1 4 1 6 0M12 3V1"/>',
  lyrics: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h7M8 16h5"/><path d="m16.5 13.5 3-3 1.5 1.5-3 3-2 .5.5-2Z"/>',
  waveform: '<path d="M3 12h2l2-6 3 12 3-14 3 12 2-4h3"/>',
  recipe: '<path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h3"/><path d="m15 16 1 1 2-3"/>',
  shield: '<path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
} as const;

export type IconName = keyof typeof paths;

export function icon(name: IconName, size = 20): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
