// Modal helpers — every admin modal is opened/closed by toggling display
// on a `.modal-overlay` element. These wrap the boilerplate.

export function openModal(id: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

export function closeModal(id: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// Wire a Cancel/Close pair (or any button list) to close the given modal.
// Each entry is the button id; clicking it hides the modal.
export function wireModalClose(modalId: string, buttonIds: string[]): void {
  for (const bid of buttonIds) {
    const btn = document.getElementById(bid);
    if (btn) btn.addEventListener('click', () => closeModal(modalId));
  }
}
