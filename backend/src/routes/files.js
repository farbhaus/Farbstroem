const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const { randomUUID } = require('crypto');
const db           = require('../db');
const events       = require('../events');

const router      = express.Router();
const UPLOAD_BASE = '/data/uploads';
const MAX_SIZE    = 100 * 1024 * 1024; // 100 MB

// ---- Participant auth (query params, runs before multer) ----
function participantAuth(req, res, next) {
    const { participantId, token } = req.query;
    const { slug } = req.params;
    if (!participantId || !token) return res.status(401).json({ error: 'Unauthorized' });

    const row = db.prepare(`
        SELECT p.id, p.name, p.role, r.id AS room_id, r.slug
        FROM participants p
        JOIN rooms r ON r.id = p.room_id
        WHERE p.id = ? AND p.token = ? AND r.slug = ? AND p.is_admitted = 1 AND p.is_kicked = 0
    `).get(participantId, token, slug);

    if (!row) return res.status(401).json({ error: 'Unauthorized' });
    req.participant = row;
    req.room = { id: row.room_id, slug: row.slug };
    next();
}

// ---- Multer: per-room subdirectory, UUID filename ----
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(UPLOAD_BASE, req.room.id);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).slice(0, 16);
        cb(null, randomUUID() + ext);
    },
});
const upload = multer({ storage, limits: { fileSize: MAX_SIZE } });

// ---- POST /:slug/files — upload ----
router.post('/:slug/files', participantAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const id           = randomUUID();
    const originalName = req.file.originalname.replace(/"/g, '').slice(0, 255) || 'file';
    // Whitelist safe MIME types — client-supplied value is not trusted (prevents stored XSS via download)
    const SAFE_MIMES = new Set([
        'image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/avif',
        'video/mp4','video/quicktime','video/webm',
        'audio/mpeg','audio/wav','audio/ogg','audio/flac',
        'application/pdf',
        'text/plain',
        'application/zip','application/x-zip-compressed',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    const mime = SAFE_MIMES.has(req.file.mimetype) ? req.file.mimetype : 'application/octet-stream';

    db.prepare(`
        INSERT INTO session_files (id, room_id, uploader_id, original_name, stored_path, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.room.id, req.participant.id, originalName, req.file.path, mime, req.file.size);

    events.emit('file:shared', {
        slug:         req.room.slug,
        id,
        participantId: req.participant.id,
        uploaderName: req.participant.name,
        role:         req.participant.role,
        name:         originalName,
        size:         req.file.size,
        mime,
        ts:           Date.now(),
    });

    res.json({ id, name: originalName, size: req.file.size });
});

// ---- GET /:slug/files — list ----
router.get('/:slug/files', participantAuth, (req, res) => {
    const files = db.prepare(`
        SELECT sf.id, sf.original_name AS name, sf.size_bytes AS size, sf.mime_type AS mime,
               sf.created_at, p.name AS uploaderName, p.role
        FROM session_files sf
        LEFT JOIN participants p ON p.id = sf.uploader_id
        WHERE sf.room_id = ?
        ORDER BY sf.created_at ASC
    `).all(req.room.id);
    res.json(files);
});

// ---- GET /:slug/files/:fileId/download ----
router.get('/:slug/files/:fileId/download', participantAuth, (req, res) => {
    const file = db.prepare(`
        SELECT sf.stored_path, sf.original_name, sf.mime_type
        FROM session_files sf
        JOIN rooms r ON r.id = sf.room_id
        WHERE sf.id = ? AND r.slug = ?
    `).get(req.params.fileId, req.params.slug);

    if (!file) return res.status(404).json({ error: 'Not found' });

    // Force attachment + safe MIME so the browser downloads rather than renders
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file.stored_path);
});

// ---- Cleanup helpers ----
function deleteRoomFiles(roomId) {
    const files = db.prepare('SELECT stored_path FROM session_files WHERE room_id = ?').all(roomId);
    for (const f of files) {
        try { fs.unlinkSync(f.stored_path); } catch {}
    }
    db.prepare('DELETE FROM session_files WHERE room_id = ?').run(roomId);
    try { fs.rmdirSync(path.join(UPLOAD_BASE, roomId)); } catch {}
}

// Cleanup on room:ended
events.on('room:ended', (slug) => {
    const room = db.prepare('SELECT id FROM rooms WHERE slug = ?').get(slug);
    if (room) {
        deleteRoomFiles(room.id);
        console.log(`[files] Cleaned up files for room ${room.id} (ended)`);
    }
});

// Weekly cleanup: purge files for any ended/expired rooms that still have files
function weeklyCleanup() {
    const stale = db.prepare(`
        SELECT DISTINCT r.id FROM rooms r
        JOIN session_files sf ON sf.room_id = r.id
        WHERE r.status = 'ended'
           OR (r.expires_at IS NOT NULL AND r.expires_at < datetime('now'))
    `).all();
    for (const r of stale) deleteRoomFiles(r.id);
    if (stale.length) console.log(`[files] Weekly cleanup: purged ${stale.length} room(s)`);
}

setTimeout(weeklyCleanup, 60_000);                      // 1 min after start
setInterval(weeklyCleanup, 7 * 24 * 60 * 60 * 1000);   // then every 7 days

module.exports = router;
