const express = require('express');
const db      = require('../db');
const router  = express.Router();

const OME_API = process.env.OME_API_URL || 'http://stream-ome:8081/v1';

async function omeRequest(path) {
    const token  = Buffer.from(process.env.OME_API_TOKEN || '').toString('base64');
    const res    = await fetch(`${OME_API}${path}`, {
        headers: { Authorization: `Basic ${token}` },
    });
    if (!res.ok) throw new Error(`OME API ${res.status}`);
    return res.json();
}

// Enriched status — all active OME streams, main ones annotated with room/key metadata.
// Conference streams (conf-*) are excluded from the list but counted separately.
router.get('/status', async (req, res) => {
    try {
        const listData = await omeRequest('/vhosts/default/apps/live/streams');
        const names = Array.isArray(listData.response) ? listData.response : [];

        const confNames = names.filter(n => n.startsWith('conf-'));
        const mainNames = names.filter(n => !n.startsWith('conf-'));

        const streams = await Promise.all(mainNames.map(async name => {
            let detail = null;
            try {
                const d = await omeRequest(`/vhosts/default/apps/live/streams/${name}`);
                detail = d.response || null;
            } catch { /* detail unavailable — stream may have just ended */ }

            const row = db.prepare(`
                SELECT sk.name AS key_name, r.name AS room_name, r.id AS room_id, r.slug
                FROM stream_keys sk
                LEFT JOIN rooms r ON r.stream_key_id = sk.id
                WHERE sk.key_token = ?
            `).get(name);

            return {
                name,
                key_name:  row?.key_name  || null,
                room_name: row?.room_name || null,
                room_id:   row?.room_id   || null,
                slug:      row?.slug      || null,
                detail,
            };
        }));

        res.json({ streams, conf_count: confNames.length });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Live streams
router.get('/streams', async (req, res) => {
    try {
        const data = await omeRequest('/vhosts/default/apps/live/streams');
        res.json(data);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Single stream stats
router.get('/streams/:streamKey', async (req, res) => {
    try {
        const data = await omeRequest(`/vhosts/default/apps/live/streams/${req.params.streamKey}`);
        res.json(data);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Force-disconnect a stream
router.delete('/streams/:streamKey', async (req, res) => {
    try {
        const token = Buffer.from(process.env.OME_API_TOKEN || '').toString('base64');
        const r = await fetch(`${OME_API}/vhosts/default/apps/live/streams/${req.params.streamKey}`, {
            method: 'DELETE',
            headers: { Authorization: `Basic ${token}` },
        });
        res.status(r.status).json(await r.json());
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

module.exports = router;
