# Farbstroem design system

Shared tokens, components, and utilities used by every page in `www/`. Loaded as plain CSS/JS so any page can `<link>` or `<script>` them with no build step.

## Files

| File | What it provides |
| --- | --- |
| `tokens.css` | CSS custom properties: colors, typography, spacing (4px scale), radii, motion, z-index, layout. The source of truth — every value you'd hardcode goes here first. |
| `components.css` | Reusable component classes: `.btn`, `.btn-primary`, `.btn-tab`, `.modal-overlay` + `.modal`, `.section-header`, `.badge-*`, `.empty`, form rows. |
| `utils.css` | Tiny utility layer: `.u-hidden`, layout helpers. Keep this small — prefer real components over utility-class drift. |

JS helpers (toast, fetch wrapper, branding loader, formatters, store) live under [frontend/shared/](../../frontend/shared/) as TypeScript modules and are imported per-page from the compiled output in `www/dist/shared/`.

## Color tokens

All UI colors are derived from these custom properties on `:root`. Branding writes to them via `document.documentElement.style.setProperty()` so admin-set palettes apply immediately without reload.

| Token | Default | Used for |
| --- | --- | --- |
| `--bg` | `#171717` | Page background |
| `--surface` | `#1d1d1d` | Cards, modals, nav |
| `--surface2` | `#1c1c1c` | Inset panels, hover states |
| `--border` | `#2a2a2a` | Dividers, input borders |
| `--faint` | `#444444` | Disabled/placeholder text |
| `--dim` | `#777777` | Secondary text |
| `--text` | `#dfdfdf` | Primary text |
| `--accent` | `#ffbd2e` | Brand accent, primary buttons, focus rings |
| `--danger` | `#ff6159` | Destructive actions, errors |
| `--green` | `#28c941` | Success, live indicators |

The branding API (`POST /api/admin/branding/colors`) overrides any of these per deployment. `frontend/admin/branding.ts` reads `getComputedStyle(document.documentElement)` once at module load to capture the stylesheet defaults — capture happens *before* any saved overrides are applied, so reset-to-defaults works correctly.

## Spacing, radii, motion

Use the tokens — don't hardcode pixel values:

```css
.foo {
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    transition: border-color var(--dur-fast) var(--ease-out);
}
```

## Components

Most reusable widgets live as CSS classes in `components.css`. To extend:
1. Add semantic tokens to `tokens.css` first if a value will be reused.
2. Add the class to `components.css`.
3. Document any non-obvious usage here.

Page-specific styling stays inline in the page's `<style>` block. If something is duplicated across two pages, promote it to `components.css`.

## Conventions

- **No hex colors in component CSS** — always reference a token. Page-specific accents (e.g. the `#1a1508` waiting-section background) are the rare exception and should be documented inline.
- **No `!important`** outside of `utils.css`'s `.u-hidden`.
- **Class names**: descriptive, hyphenated. No BEM. No CSS-in-JS.
- **Z-index**: only use the `--z-*` scale. New layers should extend the scale, not invent ad-hoc values.

## TypeScript build

All three SPAs (admin, viewer, landing) are TypeScript, compiled with `tsc` to `www/dist/`. Sources live under `frontend/{admin,viewer,landing,shared}/`. See [frontend/package.json](../../frontend/package.json) for build commands (`build`, `watch`, `typecheck`).
