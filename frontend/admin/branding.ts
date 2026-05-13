import { apiFetch, getToken } from './auth.js';
import { toast } from '../shared/utils.js';
import type { BrandingResponse } from './types.js';

const COLOR_FIELDS = ['accent', 'bg', 'surface', 'text', 'danger', 'green'] as const;
type ColorField = (typeof COLOR_FIELDS)[number];

const CSS_MAP: Record<ColorField, string> = {
  accent: '--accent',
  bg: '--bg',
  surface: '--surface',
  text: '--text',
  danger: '--danger',
  green: '--green',
};

// Defaults are sourced live from /shared/tokens.css (:root custom properties).
// Captured on module load, BEFORE any /api/branding overrides are applied via
// setProperty, so getComputedStyle returns the stylesheet defaults.
const COLOR_DEFAULTS: Record<ColorField, string> = (() => {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Record<ColorField, string>;
  for (const f of COLOR_FIELDS) out[f] = cs.getPropertyValue(`--${f}`).trim();
  return out;
})();

function setColorVar(field: ColorField, value: string | null): void {
  if (value) document.documentElement.style.setProperty(CSS_MAP[field], value);
  else document.documentElement.style.removeProperty(CSS_MAP[field]);
}

function getInput(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

export async function loadBranding(): Promise<void> {
  const res = await fetch('/api/branding');
  if (!res.ok) return;
  const data: BrandingResponse = await res.json();

  const logoPreview = document.getElementById('logo-preview') as HTMLImageElement;
  const logoEmpty = document.getElementById('logo-empty');
  if (logoPreview) logoPreview.style.display = data.hasLogo ? '' : 'none';
  if (logoEmpty) logoEmpty.style.display = data.hasLogo ? 'none' : '';
  if (data.hasLogo && logoPreview) logoPreview.src = '/api/branding/logo?' + Date.now();

  const brandImg = document.getElementById('brand-logo') as HTMLImageElement | null;
  const brandText = document.getElementById('brand-text');
  if (brandImg) {
    if (data.hasLogo) {
      brandImg.src = '/api/branding/logo?' + Date.now();
      brandImg.style.display = '';
      if (brandText) brandText.style.display = 'none';
    } else {
      brandImg.style.display = 'none';
      if (brandText) brandText.style.display = '';
    }
  }

  const bgPreview = document.getElementById('bg-preview') as HTMLImageElement | null;
  const bgEmpty = document.getElementById('bg-empty');
  if (bgPreview) bgPreview.style.display = data.hasBg ? '' : 'none';
  if (bgEmpty) bgEmpty.style.display = data.hasBg ? 'none' : '';
  if (data.hasBg && bgPreview) bgPreview.src = '/api/branding/bg?' + Date.now();

  if (data.colors) {
    for (const f of COLOR_FIELDS) {
      const val = data.colors[`color_${f}`] || COLOR_DEFAULTS[f];
      getInput(`color-${f}`).value = val;
      getInput(`color-${f}-hex`).value = val;
      if (data.colors[`color_${f}`]) setColorVar(f, val);
    }
  }
}

async function uploadBrandingAsset(asset: 'logo' | 'bg'): Promise<void> {
  const input = getInput(`${asset}-file-input`);
  const file = input.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/admin/branding/${asset}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  input.value = '';
  if (res.ok) {
    toast(`${asset === 'logo' ? 'Logo' : 'Background'} updated`);
    void loadBranding();
  } else {
    toast('Upload failed');
  }
}

async function removeBrandingAsset(asset: 'logo' | 'bg'): Promise<void> {
  if (!confirm(`Remove custom ${asset === 'logo' ? 'logo' : 'background image'}?`)) return;
  const res = await apiFetch(`/api/admin/branding/${asset}`, { method: 'DELETE' });
  if (res && res.ok) {
    toast('Removed');
    void loadBranding();
  } else {
    toast('Remove failed');
  }
}

async function saveColors(): Promise<void> {
  const body: Record<string, string> = {};
  for (const f of COLOR_FIELDS) {
    body[`color_${f}`] = getInput(`color-${f}-hex`).value || '';
  }
  const res = await apiFetch('/api/admin/branding/colors', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res && res.ok) {
    for (const f of COLOR_FIELDS) {
      const val = body[`color_${f}`];
      setColorVar(f, val ? val : null);
    }
    toast('Colors saved');
  } else {
    toast('Save failed');
  }
}

async function resetColors(): Promise<void> {
  const body: Record<string, string> = {};
  for (const f of COLOR_FIELDS) {
    body[`color_${f}`] = '';
    getInput(`color-${f}`).value = COLOR_DEFAULTS[f];
    getInput(`color-${f}-hex`).value = COLOR_DEFAULTS[f];
  }
  const res = await apiFetch('/api/admin/branding/colors', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res && res.ok) {
    for (const f of COLOR_FIELDS) setColorVar(f, null);
    toast('Colors reset to defaults');
  } else {
    toast('Reset failed');
  }
}

export function initBranding(): void {
  // Live preview: color picker ↔ hex input, in-memory only until Save.
  for (const f of COLOR_FIELDS) {
    getInput(`color-${f}`).addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      getInput(`color-${f}-hex`).value = v;
      setColorVar(f, v);
    });
    getInput(`color-${f}-hex`).addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        getInput(`color-${f}`).value = v;
        setColorVar(f, v);
      }
    });
  }

  document.getElementById('colors-save-btn')?.addEventListener('click', saveColors);
  document.getElementById('colors-reset-btn')?.addEventListener('click', resetColors);

  document
    .getElementById('logo-upload-btn')
    ?.addEventListener('click', () => getInput('logo-file-input').click());
  document
    .getElementById('logo-file-input')
    ?.addEventListener('change', () => uploadBrandingAsset('logo'));
  document
    .getElementById('logo-remove-btn')
    ?.addEventListener('click', () => removeBrandingAsset('logo'));
  document
    .getElementById('bg-upload-btn')
    ?.addEventListener('click', () => getInput('bg-file-input').click());
  document
    .getElementById('bg-file-input')
    ?.addEventListener('change', () => uploadBrandingAsset('bg'));
  document
    .getElementById('bg-remove-btn')
    ?.addEventListener('click', () => removeBrandingAsset('bg'));
}

// Apply saved branding colors before any UI renders. Called once on load.
export function applyBrandingColorsOnce(): void {
  fetch('/api/branding')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: BrandingResponse | null) => {
      if (!data?.colors) return;
      for (const f of COLOR_FIELDS) {
        const v = data.colors[`color_${f}`];
        if (v) document.documentElement.style.setProperty(CSS_MAP[f], v);
      }
    })
    .catch(() => {});
}
