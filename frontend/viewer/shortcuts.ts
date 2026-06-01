// Single-key shortcuts for the viewer toolbar (#159). Each key maps to a
// toolbar button id and simply dispatches its click, so all existing guards
// (disabled until live, hidden outside focus mode, presenter-only logic,
// WS broadcasts) are inherited for free.
const KEY_TO_BTN: Record<string, string> = {
  q: 'cam-btn', // camera
  w: 'mic-btn', // microphone
  e: 'pointer-btn', // pointer (focus mode only)
  f: 'fullscreen-btn', // fullscreen
  m: 'mute-btn', // stream mute/unmute
  x: 'focus-btn', // focus view
  c: 'chat-toggle', // chat panel
  v: 'conf-toggle', // call strip (focus/pinned mode only)
};

export function initShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    // Leave browser/OS combos (copy, devtools, etc.) untouched.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Don't hijack keys while the user is typing.
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const id = KEY_TO_BTN[e.key.toLowerCase()];
    if (!id) return;
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    // A native disabled button ignores .click(); offsetParent === null means
    // the button is hidden (outside focus mode, or app not yet visible).
    if (!btn || btn.disabled || btn.offsetParent === null) return;
    e.preventDefault();
    btn.click();
  });
}
