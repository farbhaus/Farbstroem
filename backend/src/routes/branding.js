const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const router       = express.Router();
const BRANDING_DIR = '/data/branding';

fs.mkdirSync(BRANDING_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BRANDING_DIR),
    filename:    (req, _file, cb) => cb(null, req.params.asset),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/branding — public, returns hasLogo / hasBg flags
router.get('/', (req, res) => {
    res.json({
        hasLogo: fs.existsSync(path.join(BRANDING_DIR, 'logo')),
        hasBg:   fs.existsSync(path.join(BRANDING_DIR, 'bg')),
    });
});

// GET /branding/logo  or  /branding/bg — serve the file
router.get('/:asset(logo|bg)', (req, res) => {
    const filePath = path.join(BRANDING_DIR, req.params.asset);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`${req.params.asset}_mime`);
    res.setHeader('Content-Type', row?.value || 'application/octet-stream');
    res.sendFile(filePath);
});

// POST /api/admin/branding/logo|bg — upload (admin only)
router.post('/:asset(logo|bg)', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(`${req.params.asset}_mime`, req.file.mimetype);
    res.json({ ok: true });
});

// DELETE /api/admin/branding/logo|bg — remove (admin only)
router.delete('/:asset(logo|bg)', requireAuth, (req, res) => {
    const filePath = path.join(BRANDING_DIR, req.params.asset);
    try { fs.unlinkSync(filePath); } catch {}
    db.prepare('DELETE FROM settings WHERE key = ?').run(`${req.params.asset}_mime`);
    res.json({ ok: true });
});

module.exports = router;
