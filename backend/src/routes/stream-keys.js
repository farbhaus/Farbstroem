const express = require('express');
const crypto  = require('crypto');
const db      = require('../db');
const router  = express.Router();

// List all stream keys (with comma-separated list of rooms using each key)
router.get('/', (req, res) => {
    const keys = db.prepare(`
        SELECT sk.*, GROUP_CONCAT(r.name, ', ') as room_names
        FROM stream_keys sk
        LEFT JOIN rooms r ON r.stream_key_id = sk.id
        GROUP BY sk.id
        ORDER BY sk.created_at DESC
    `).all();
    res.json(keys);
});

// Create a stream key
router.post('/', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const id        = crypto.randomUUID();
    const key_token = crypto.randomBytes(24).toString('hex');

    db.prepare(`
        INSERT INTO stream_keys (id, name, key_token)
        VALUES (?, ?, ?)
    `).run(id, name, key_token);

    res.status(201).json(db.prepare('SELECT * FROM stream_keys WHERE id = ?').get(id));
});

// Update a stream key (rename only — room assignment is managed via rooms)
router.put('/:id', (req, res) => {
    const { name } = req.body;
    const key = db.prepare('SELECT * FROM stream_keys WHERE id = ?').get(req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });

    db.prepare('UPDATE stream_keys SET name = ? WHERE id = ?').run(name ?? key.name, key.id);

    res.json(db.prepare('SELECT * FROM stream_keys WHERE id = ?').get(key.id));
});

// Delete a stream key
router.delete('/:id', (req, res) => {
    const result = db.prepare('DELETE FROM stream_keys WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
});

module.exports = router;
