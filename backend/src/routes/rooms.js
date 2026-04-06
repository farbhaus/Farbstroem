const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const db      = require('../db');
const events  = require('../events');
const router  = express.Router();

// List all rooms (admin)
router.get('/', (req, res) => {
    const rooms = db.prepare(`
        SELECT r.*, sk.key_token, sk.name as stream_key_name,
            (SELECT COUNT(*) FROM participants p
             WHERE p.room_id = r.id AND p.is_admitted = 0 AND p.role = 'viewer') as waiting_count
        FROM rooms r
        LEFT JOIN stream_keys sk ON sk.id = r.stream_key_id
        ORDER BY r.created_at DESC
    `).all();
    res.json(rooms);
});

// Get single room (admin)
router.get('/:id', (req, res) => {
    const room = db.prepare(`
        SELECT r.*, sk.key_token, sk.name as stream_key_name
        FROM rooms r
        LEFT JOIN stream_keys sk ON sk.id = r.stream_key_id
        WHERE r.id = ?
    `).get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json(room);
});

// Create room
router.post('/', async (req, res) => {
    const { name, password, delivery_mode, waiting_room, expires_at, stream_key_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const id   = crypto.randomUUID();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
               + '-' + crypto.randomBytes(3).toString('hex');

    const password_hash = password ? await bcrypt.hash(password, 12) : null;

    db.prepare(`
        INSERT INTO rooms (id, name, slug, password_hash, delivery_mode, waiting_room, expires_at, stream_key_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, name, slug, password_hash,
        delivery_mode || 'webrtc',
        waiting_room ? 1 : 0,
        expires_at || null,
        stream_key_id || null
    );

    res.status(201).json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id));
});

// Update room
router.put('/:id', async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Not found' });

    const { name, password, delivery_mode, waiting_room, expires_at, stream_key_id } = req.body;

    let password_hash = room.password_hash;
    if (password === '') {
        password_hash = null;           // clear password
    } else if (password) {
        password_hash = await bcrypt.hash(password, 12);
    }

    db.prepare(`
        UPDATE rooms SET
            name          = ?,
            password_hash = ?,
            delivery_mode = ?,
            waiting_room  = ?,
            expires_at    = ?,
            stream_key_id = ?
        WHERE id = ?
    `).run(
        name          ?? room.name,
        password_hash,
        delivery_mode ?? room.delivery_mode,
        waiting_room  !== undefined ? (waiting_room ? 1 : 0) : room.waiting_room,
        expires_at    !== undefined ? expires_at : room.expires_at,
        stream_key_id !== undefined ? (stream_key_id || null) : room.stream_key_id,
        room.id
    );

    res.json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id));
});

// End a room (set status = ended)
router.post('/:id/end', (req, res) => {
    const room = db.prepare('SELECT slug FROM rooms WHERE id = ?').get(req.params.id);
    const result = db.prepare(`
        UPDATE rooms SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    if (room) events.emit('room:ended', room.slug);
    res.json({ ok: true });
});

// Delete room
router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

// Waiting room list (admin)
router.get('/:id/waiting', (req, res) => {
    const participants = db.prepare(`
        SELECT id, name, role, is_admitted, joined_at
        FROM participants WHERE room_id = ? AND is_admitted = 0
        ORDER BY joined_at ASC
    `).all(req.params.id);
    res.json(participants);
});

// Admit a participant
router.post('/:id/admit/:participantId', (req, res) => {
    db.prepare(`
        UPDATE participants SET is_admitted = 1
        WHERE id = ? AND room_id = ?
    `).run(req.params.participantId, req.params.id);
    res.json({ ok: true });
});

// Admit all waiting
router.post('/:id/admit-all', (req, res) => {
    db.prepare(`
        UPDATE participants SET is_admitted = 1 WHERE room_id = ? AND is_admitted = 0
    `).run(req.params.id);
    res.json({ ok: true });
});

// List kicked participants
router.get('/:id/kicked', (req, res) => {
    const rows = db.prepare(
        'SELECT id, name, role, joined_at FROM participants WHERE room_id = ? AND is_kicked = 1'
    ).all(req.params.id);
    res.json(rows);
});

// Unblock a kicked participant
router.post('/:id/unkick/:participantId', (req, res) => {
    db.prepare(
        'UPDATE participants SET is_kicked = 0 WHERE id = ? AND room_id = ?'
    ).run(req.params.participantId, req.params.id);
    res.json({ ok: true });
});

module.exports = router;
