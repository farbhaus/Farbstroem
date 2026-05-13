// Read-only branding loader: fetches /api/branding and applies logo,
// background image, and color overrides. Pages call this once at load.
//
// The admin SPA has its own branding.ts that handles editing — this is
// only for surfaces that want to display whatever is currently set.

const COLOR_MAP: Record<string, string> = {
  color_accent: '--accent',
  color_bg: '--bg',
  color_surface: '--surface',
  color_text: '--text',
  color_danger: '--danger',
  color_green: '--green',
};

interface BrandingPayload {
  hasLogo?: boolean;
  hasBg?: boolean;
  colors?: Record<string, string>;
}

export interface ApplyBrandingOptions {
  logoEl?: HTMLImageElement | null;
  bgTarget?: HTMLElement | null;
}

export async function applyBranding(opts: ApplyBrandingOptions = {}): Promise<BrandingPayload | null> {
  try {
    const res = await fetch('/api/branding');
    if (!res.ok) return null;
    const data: BrandingPayload = await res.json();

    if (data.colors) {
      for (const [key, cssVar] of Object.entries(COLOR_MAP)) {
        const v = data.colors[key];
        if (v) document.documentElement.style.setProperty(cssVar, v);
      }
    }

    if (data.hasLogo && opts.logoEl) {
      opts.logoEl.src = '/api/branding/logo';
      opts.logoEl.classList.remove('u-hidden');
    }

    if (data.hasBg) {
      const target = opts.bgTarget || document.body;
      target.style.backgroundImage = 'url(/api/branding/bg)';
      target.style.backgroundSize = 'cover';
      target.style.backgroundPosition = 'center';
      target.style.backgroundRepeat = 'no-repeat';
    }

    return data;
  } catch {
    return null;
  }
}
