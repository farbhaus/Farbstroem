const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const events  = require('../events');
const router  = express.Router();

/**
 * OME Admission Webhook
 * OME calls this for every ingest connection to validate the stream key.
 *
 * Request body from OME:
 * {
 *   "client": { "address": "...", "port": ... },
 *   "request": {
 *     "direction": "incoming",   // "incoming" = ingest, "outgoing" = viewer
 *     "protocol": "rtmp" | "srt" | "webrtc",
 *     "url": "rtmp://host/live/stream-key-here",
 *     "time": "..."
 *   }
 * }
 *
 * We respond with:
 *   { "allowed": true }   → accept
 *   { "allowed": false }  → deny
 */
router.post('/', (req, res) => {
    // req.body is the raw Buffer (express.raw middleware is applied before this route)
    const rawBody   = req.body;
    const signature = req.headers['x-ome-signature'];

    if (!signature) {
        console.warn('[webhook] missing signature — rejected');
        return res.status(401).json({ allowed: false });
    }
    const expected = crypto
        .createHmac('sha1', process.env.OME_WEBHOOK_SECRET || '')
        .update(rawBody)
        .digest('base64url');
    if (signature !== expected) {
        console.warn('[webhook] signature mismatch — rejected');
        return res.status(401).json({ allowed: false });
    }

    let parsed;
    try { parsed = JSON.parse(rawBody); } catch {
        return res.status(400).json({ allowed: false });
    }

    const { request } = parsed;
    if (!request) return res.status(400).json({ allowed: false });

    const direction = request.direction; // 'incoming' = ingest, 'outgoing' = viewer
    const url       = request.url || '';

    if (direction === 'incoming') {
        // Extract stream key from URL
        // RTMP:  rtmp://host/live/{stream-key}
        // SRT:   streamid = default/live/{stream-key}  (OME resolves to URL)
        // WHIP:  https://host/live/{stream-key}?direction=whip
        const streamKey = extractStreamKey(url, request.protocol);

        if (!streamKey) {
            console.warn('[webhook] Could not extract stream key from:', url);
            return res.json({ allowed: false });
        }

        const key = db.prepare('SELECT * FROM stream_keys WHERE key_token = ?').get(streamKey);

        if (!key) {
            console.warn('[webhook] Unknown stream key:', streamKey);
            return res.json({ allowed: false });
        }

        // Capture slugs of rooms that are about to go live (so we can notify participants)
        const pendingSlugs = db.prepare(`
            SELECT slug FROM rooms WHERE stream_key_id = ? AND status = 'pending'
        `).all(key.id).map(r => r.slug);

        // Mark ALL rooms using this key as live
        const updated = db.prepare(`
            UPDATE rooms SET status = 'live', started_at = CURRENT_TIMESTAMP
            WHERE stream_key_id = ? AND status != 'ended'
        `).run(key.id);

        // Notify connected participants so their players start automatically
        for (const slug of pendingSlugs) events.emit('room:live', slug);

        console.log(`[webhook] Stream key ${streamKey} accepted → ${updated.changes} room(s) live`);
        return res.json({ allowed: true });
    }

    // 'outgoing' = viewer request (Phase 2: enforce waiting room here)
    // For now, allow all viewer connections — access controlled by the viewer join flow
    return res.json({ allowed: true });
});

function extractStreamKey(url, protocol) {
    try {
        // Normalise: SRT streamid comes through as a URL path, e.g. /default/live/{key}
        // RTMP and WHIP: last path segment after /live/
        const parsed = new URL(url.startsWith('http') || url.startsWith('rtmp') ? url : 'http://x' + url);
        const parts  = parsed.pathname.split('/').filter(Boolean);
        // Path is typically: [vhost,] app, streamKey — take the last segment
        return parts[parts.length - 1] || null;
    } catch {
        return null;
    }
}


module.exports = router;
