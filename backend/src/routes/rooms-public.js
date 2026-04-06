const express      = require('express');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const db           = require('../db');
const events       = require('../events');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const router       = express.Router();

function getRoomService() {
    return new RoomServiceClient(
        'http://localhost:7880',
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET
    );
}

// Room info (viewer — no auth)
router.get('/:slug/info', (req, res) => {
    const room = db.prepare(`
        SELECT id, name, slug, delivery_mode, waiting_room,
               CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
               status
        FROM rooms WHERE slug = ?
    `).get(req.params.slug);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
});

// Join room (viewer)
router.post('/:slug/join', async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE slug = ?').get(req.params.slug);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.status === 'ended') return res.status(410).json({ error: 'Session has ended' });

    // Fix #8: enforce expiry
    if (room.expires_at && new Date(room.expires_at) < new Date()) {
        return res.status(410).json({ error: 'Session has expired' });
    }

    const { name, password, role } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    if (room.password_hash) {
        if (!password) return res.status(401).json({ error: 'Password required' });
        const ok = await bcrypt.compare(password, room.password_hash);
        if (!ok) return res.status(401).json({ error: 'Wrong password' });
    }

    // Block kicked participants from rejoining with the same name
    const kicked = db.prepare(
        'SELECT id FROM participants WHERE room_id = ? AND LOWER(name) = LOWER(?) AND is_kicked = 1 LIMIT 1'
    ).get(room.id, name);
    if (kicked) return res.status(403).json({ error: 'You have been removed from this session' });

    const participantId = crypto.randomUUID();
    const token         = crypto.randomBytes(32).toString('hex');
    const isPresenter   = role === 'presenter';

    const wasAdmitted = room.waiting_room && !isPresenter
        ? !!db.prepare(`SELECT id FROM participants WHERE room_id = ? AND name = ? AND is_admitted = 1 LIMIT 1`).get(room.id, name)
        : false;

    const isAdmitted = !room.waiting_room || isPresenter || wasAdmitted ? 1 : 0;

    db.prepare(`
        INSERT INTO participants (id, room_id, name, role, is_admitted, token)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(participantId, room.id, name, isPresenter ? 'presenter' : 'viewer', isAdmitted, token);

    const streamKey = room.stream_key_id
        ? db.prepare('SELECT key_token FROM stream_keys WHERE id = ?').get(room.stream_key_id)
        : null;

    res.json({
        participant_id: participantId,
        token,
        role:          isPresenter ? 'presenter' : 'viewer',
        admitted:      !!isAdmitted,
        delivery_mode: room.delivery_mode,
        waiting_room:  !!room.waiting_room,
        stream_key:    streamKey?.key_token || null,
        room_name:     room.name,
        status:        room.status,
    });
});

// Admission status poll
router.get('/:slug/status/:participantId', (req, res) => {
    const p = db.prepare(`
        SELECT is_admitted FROM participants
        WHERE id = ? AND room_id = (SELECT id FROM rooms WHERE slug = ?)
    `).get(req.params.participantId, req.params.slug);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ admitted: !!p.is_admitted });
});

// SSE — waiting room notifications
router.get('/:slug/waiting/events/:participantId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const interval = setInterval(() => {
        const p = db.prepare(`
            SELECT is_admitted FROM participants
            WHERE id = ? AND room_id = (SELECT id FROM rooms WHERE slug = ?)
        `).get(req.params.participantId, req.params.slug);

        if (!p) { clearInterval(interval); res.end(); return; }

        if (p.is_admitted) {
            res.write(`event: admitted\ndata: {}\n\n`);
            clearInterval(interval);
            res.end();
        } else {
            res.write(`event: ping\ndata: {}\n\n`);
        }
    }, 2000);

    req.on('close', () => clearInterval(interval));
});

// LiveKit token — admitted participants only
router.get('/:slug/livekit-token', async (req, res) => {
    const { participantId, token } = req.query;
    if (!participantId || !token) return res.status(401).json({ error: 'Unauthorized' });

    const row = db.prepare(`
        SELECT p.id, p.name, p.role, r.slug
        FROM participants p JOIN rooms r ON r.id = p.room_id
        WHERE p.id = ? AND p.token = ? AND r.slug = ? AND p.is_admitted = 1 AND p.is_kicked = 0
    `).get(participantId, token, req.params.slug);
    if (!row) return res.status(401).json({ error: 'Unauthorized' });

    const at = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        { identity: row.id, name: row.name, metadata: JSON.stringify({ role: row.role }) }
    );
    at.addGrant({ roomJoin: true, room: req.params.slug, canPublish: true, canSubscribe: true });

    res.json({ token: await at.toJwt(), url: process.env.LIVEKIT_URL });
});

// Presenter-only: kick + ban a participant from the room
router.post('/:slug/conference/kick', async (req, res) => {
    const { participantId, token, targetId } = req.body;
    if (!participantId || !token || !targetId) return res.status(400).json({ error: 'Missing fields' });

    const requester = db.prepare(`
        SELECT p.role FROM participants p JOIN rooms r ON r.id = p.room_id
        WHERE p.id = ? AND p.token = ? AND r.slug = ? AND p.is_admitted = 1
    `).get(participantId, token, req.params.slug);
    if (!requester || requester.role !== 'presenter') return res.status(403).json({ error: 'Forbidden' });

    const target = db.prepare(`
        SELECT p.id FROM participants p JOIN rooms r ON r.id = p.room_id
        WHERE p.id = ? AND r.slug = ?
    `).get(targetId, req.params.slug);
    if (!target) return res.status(404).json({ error: 'Participant not found' });

    // 1. Mark as kicked in DB (prevents rejoin)
    db.prepare('UPDATE participants SET is_kicked = 1 WHERE id = ?').run(targetId);

    // 2. Force-disconnect WebSocket + notify viewer
    events.emit('participant:kicked', { slug: req.params.slug, participantId: targetId });

    // 3. Remove from LiveKit room
    try {
        await getRoomService().removeParticipant(req.params.slug, targetId);
    } catch (err) {
        if (!err.message?.includes('not found')) console.error('[kick]', err.message);
    }

    res.json({ ok: true });
});

// Presenter-only: mute/unmute a participant's microphone track
router.post('/:slug/conference/mute', async (req, res) => {
    const { participantId, token, targetId, trackSid, muted } = req.body;
    if (!participantId || !token || !targetId || !trackSid || muted === undefined)
        return res.status(400).json({ error: 'Missing fields' });

    const requester = db.prepare(`
        SELECT p.role FROM participants p JOIN rooms r ON r.id = p.room_id
        WHERE p.id = ? AND p.token = ? AND r.slug = ? AND p.is_admitted = 1
    `).get(participantId, token, req.params.slug);
    if (!requester || requester.role !== 'presenter') return res.status(403).json({ error: 'Forbidden' });

    try {
        await getRoomService().mutePublishedTrack(req.params.slug, targetId, trackSid, !!muted);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 404 || err.message?.includes('not found')) return res.json({ ok: true });
        console.error('[mute]', err.message);
        res.status(500).json({ error: 'Failed to mute participant' });
    }
});

module.exports = router;
