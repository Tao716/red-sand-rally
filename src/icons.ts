const paths: Record<string, string> = {
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  arrowLeft: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  volume: '<path d="m11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  mute: '<path d="m11 4-6 5H2v6h3l6 5V4Zm5 5 6 6m0-6-6 6"/>',
  music: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  musicOff: '<path d="M9 18v-6M9 5l11-2v13M14 8l6-1M3 3l18 18"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><path d="M20 16c0 1.4-1.3 2.5-3 2.5S14 17.4 14 16c0-1 .7-1.8 1.6-2.2"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 2.8c-1 .5-1 1-1 2.2m0 3h.01"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  play: '<path d="m8 4 13 8-13 8V4Z" fill="currentColor" stroke="none"/>',
  flag: '<path d="M5 21V3m0 0c5-5 9 5 15 0v11c-6 5-10-5-15 0"/><path d="M10 3v11m5-10v11M5 8c5-5 9 5 15 0"/>',
  rocket: '<path d="M14 4c2-2 6-2 7-1 1 1 1 5-1 7l-7 7-6-6 7-7Z"/><path d="m7 11-4-1 4-4 5 0m1 11 1 4 4-4v-5M6 16l-3 5 5-3"/><circle cx="16" cy="8" r="1.5"/>',
  mine: '<circle cx="12" cy="12" r="5"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M5 19l3-3M16 8l3-3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 10-8 10S4 17 4 12V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  nitro: '<path d="m14 2-10 12h7l-1 8 10-12h-7l1-8Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  trophy: '<path d="M7 3h10v7a5 5 0 0 1-10 0V3ZM7 5H3v3a4 4 0 0 0 5 4m9-7h4v3a4 4 0 0 1-5 4m-4 3v6m-5 0h10"/>',
  route: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M5 7v8a4 4 0 0 0 8 0V9a4 4 0 0 1 8 0v4m-2 4V9"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--paper)"/><circle cx="16" cy="12" r="2" fill="var(--paper)"/><circle cx="10" cy="18" r="2" fill="var(--paper)"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  empty: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5m-9 5v9"/>',
};
export function icon(name: string, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.arrow}</svg>`;
}
