const path        = require('path');
require('dotenv').config({ path: path.join(__dirname, '../secrets.env') });

// Fail fast
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    { console.error('FATAL: JWT_SECRET must be set and at least 32 chars'); process.exit(1); }
if (!process.env.ADMIN_PASSWORD)
    { console.error('FATAL: ADMIN_PASSWORD must be set'); process.exit(1); }
if (!process.env.OME_WEBHOOK_SECRET)
    { console.error('FATAL: OME_WEBHOOK_SECRET must be set'); process.exit(1); }

// Hash the admin password once at startup so secrets.env just holds plaintext
const bcrypt = require('bcryptjs');
const _startupReady = bcrypt.hash(process.env.ADMIN_PASSWORD, 12).then(hash => {
    process.env._ADMIN_PASSWORD_HASH = hash;
    delete process.env.ADMIN_PASSWORD;
    console.log('[startup] Admin password hashed');
});

const express    = require('express');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const { WebSocketServer } = require('ws');
const { requireAuth }     = require('./middleware/auth');
const db                  = require('./db');
const events              = require('./events');

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(morgan('combined'));

// Rate limiting
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const joinLimiter = rateLimit({ windowMs: 1 * 60 * 1000,  max: 10 });

// Webhook: raw body BEFORE express.json so HMAC is over the original bytes
app.use('/api/webhook/admission', express.raw({ type: '*/*' }), require('./routes/webhook'));

app.use(express.json());
app.use('/api/auth',        authLimiter, require('./routes/auth'));
app.use('/api/stream-keys', requireAuth, require('./routes/stream-keys'));
app.use('/api/rooms',       requireAuth, require('./routes/rooms'));
app.use('/api/ome',         requireAuth, require('./routes/ome'));

// Public room routes (no auth — viewer join flow)
app.use('/api/public/rooms', joinLimiter, require('./routes/rooms-public'));
app.use('/api/public/rooms', joinLimiter, require('./routes/files'));

// Serve frontend
app.use(express.static('/www'));
app.get('*', (_req, res) => res.sendFile('/www/admin/index.html'));

// Error handler
app.use((err, _req, res, _next) => {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// WebSocket hub
const wss = new WebSocketServer({ server });
require('./ws/hub')(wss);

// Fix #5: Poll OME every 30s — reset rooms to 'pending' when their stream is no longer active.
// OME admission webhooks fire on connect but not on disconnect, so we detect drops here.
setInterval(async () => {
    try {
        const token = Buffer.from(process.env.OME_API_TOKEN || '').toString('base64');
        const res = await fetch('http://127.0.0.1:8081/v1/vhosts/default/apps/live/streams', {
            headers: { Authorization: `Basic ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const activeKeys = new Set(
            Array.isArray(data.response) ? data.response.map(s => s.name) : []
        );

        const liveRooms = db.prepare(`
            SELECT r.id, r.slug, sk.key_token
            FROM rooms r
            JOIN stream_keys sk ON sk.id = r.stream_key_id
            WHERE r.status = 'live'
        `).all();

        const stmt = db.prepare(`UPDATE rooms SET status = 'pending' WHERE id = ?`);
        for (const r of liveRooms) {
            if (!activeKeys.has(r.key_token)) {
                stmt.run(r.id);
                events.emit('room:pending', r.slug);
                console.log(`[poller] Room ${r.id} → pending (stream dropped)`);
            }
        }
    } catch {
        // OME temporarily unavailable — skip this cycle
    }
}, 30_000);

const PORT = process.env.PORT || 4001;
_startupReady.then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`stream-backend running on port ${PORT}`);
    });
});
