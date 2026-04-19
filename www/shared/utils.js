/* zStream shared JS helpers. Exposed on window.zs.
   Kept small and zero-dependency — no framework, no build step. */

(function () {
    'use strict';

    const BRANDING_COLOR_MAP = {
        color_accent:  '--accent',
        color_bg:      '--bg',
        color_surface: '--surface',
        color_text:    '--text',
        color_danger:  '--danger',
        color_green:   '--green',
    };

    /* Fetch wrapper: parses JSON, surfaces errors as thrown objects with status. */
    async function api(path, opts) {
        const o = opts || {};
        const headers = Object.assign({}, o.headers || {});
        if (o.body && typeof o.body === 'object' && !(o.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            o.body = JSON.stringify(o.body);
        }
        const res = await fetch(path, Object.assign({}, o, { headers }));
        const ct = res.headers.get('content-type') || '';
        const data = ct.includes('application/json') ? await res.json() : await res.text();
        if (!res.ok) {
            const err = new Error(typeof data === 'string' ? data : (data.error || res.statusText));
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    function show(el) { if (el) el.classList.remove('u-hidden'); }
    function hide(el) { if (el) el.classList.add('u-hidden'); }

    function openModal(el) { if (el) el.classList.remove('u-hidden'); }
    function closeModal(el) { if (el) el.classList.add('u-hidden'); }

    /* Toast: creates a #toast element if missing, shows message briefly. */
    let toastTimer = null;
    function toast(msg, kind) {
        let el = document.getElementById('toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.dataset.kind = kind || '';
        el.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
    }

    /* applyBranding: fetch /api/branding and apply logo, background image, and color overrides.
       Returns the branding payload so callers can do page-specific wiring (e.g. toggling
       per-page image elements). Safe to call multiple times. */
    async function applyBranding(opts) {
        const o = opts || {};
        try {
            const res = await fetch('/api/branding');
            if (!res.ok) return null;
            const data = await res.json();
            if (data.colors) {
                for (const [key, cssVar] of Object.entries(BRANDING_COLOR_MAP)) {
                    if (data.colors[key]) {
                        document.documentElement.style.setProperty(cssVar, data.colors[key]);
                    }
                }
            }
            if (data.hasLogo && o.logoEl) {
                o.logoEl.src = '/api/branding/logo';
                show(o.logoEl);
            }
            if (data.hasBg) {
                const target = o.bgTarget || document.body;
                target.style.backgroundImage = 'url(/api/branding/bg)';
                target.style.backgroundSize = 'cover';
                target.style.backgroundPosition = 'center';
                target.style.backgroundRepeat = 'no-repeat';
            }
            return data;
        } catch (_) {
            return null;
        }
    }

    window.zs = {
        api,
        show, hide,
        openModal, closeModal,
        toast,
        applyBranding,
        BRANDING_COLOR_MAP,
    };
})();
