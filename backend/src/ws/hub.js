const db     = require('../db');
const events = require('../events');
const { randomUUID } = require('crypto');

// slug → Map<participantId, {ws, name, role, cameraOn, micOn, disconnectTimer}>
const rooms = new Map();

const GRACE_PERIOD_MS = 3000; // 3s grace for reconnection

module.exports = function setupHub(wss) {
    wss.on('connection', (ws, req) => {
        const url   = new URL(req.url, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);

        // Expect /ws/room/{slug}
        if (parts.length < 3 || parts[0] !== 'ws' || parts[1] !== 'room') {
            ws.close(1008, 'Invalid path');
            return;
        }
        const slug = parts[2];

        let participant = null;

        ws.on('error', (err) => console.error('[ws]', err.message));

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }

            // First message must be auth
            if (!participant) {
                if (msg.type !== 'auth') return;

                const p = db.prepare(`
                    SELECT p.id, p.name, p.role FROM participants p
                    JOIN rooms r ON r.id = p.room_id
                    WHERE p.id = ? AND p.token = ? AND r.slug = ? AND p.is_admitted = 1 AND p.is_kicked = 0
                `).get(msg.participantId, msg.token, slug);

                if (!p) { ws.close(1008, 'Unauthorized'); return; }

                if (!rooms.has(slug)) rooms.set(slug, new Map());
                const room = rooms.get(slug);

                // Check for existing participant (reconnection)
                const existing = room.get(p.id);
                if (existing) {
                    // Reconnecting — clear grace timer, replace WS, preserve cam/mic state
                    clearTimeout(existing.disconnectTimer);
                    existing.ws = ws;
                    existing.disconnectTimer = null;
                    participant = existing;
                } else {
                    participant = { id: p.id, name: p.name, role: p.role, ws, disconnectTimer: null };
                    room.set(p.id, participant);
                }

                ws.send(JSON.stringify({ type: 'auth:ok' }));

                // Send chat history (last 50 messages)
                const history = db.prepare(`
                    SELECT cm.id, cm.name, cm.role, cm.text, cm.created_at
                    FROM chat_messages cm
                    JOIN rooms r ON r.id = cm.room_id
                    WHERE r.slug = ?
                    ORDER BY cm.created_at ASC
                    LIMIT 50
                `).all(slug);
                if (history.length > 0) {
                    ws.send(JSON.stringify({
                        type: 'chat:history',
                        messages: history.map(m => ({
                            id:   m.id,
                            name: m.name,
                            role: m.role,
                            text: m.text,
                            ts:   new Date(m.created_at).getTime(),
                        })),
                    }));
                }

                broadcastParticipants(slug);
                return;
            }

            switch (msg.type) {
                case 'chat:message': {
                    const text = String(msg.text || '').trim().slice(0, 500);
                    if (!text) break;
                    const id = randomUUID();
                    try {
                        db.prepare(
                            'INSERT INTO chat_messages (id, room_id, name, role, text) VALUES (?, (SELECT id FROM rooms WHERE slug = ?), ?, ?, ?)'
                        ).run(id, slug, participant.name, participant.role, text);
                    } catch {}
                    broadcastToRoom(slug, {
                        type: 'chat:message',
                        id,
                        participantId: participant.id,
                        name: participant.name,
                        role: participant.role,
                        text,
                        ts: Date.now(),
                    });
                    break;
                }
                case 'pointer:move': {
                    const x = Number(msg.x);
                    const y = Number(msg.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
                    broadcastToRoom(slug, {
                        type: 'pointer:move',
                        participantId: participant.id,
                        name: participant.name,
                        x, y,
                    });
                    break;
                }
                case 'pointer:hide': {
                    broadcastToRoom(slug, {
                        type: 'pointer:hide',
                        participantId: participant.id,
                    });
                    break;
                }
            }
        });

        ws.on('close', () => {
            if (!participant) return;
            const room = rooms.get(slug);
            if (!room) return;

            // Grace period — allow reconnection before removing
            participant.disconnectTimer = setTimeout(() => {
                const current = room.get(participant.id);
                // Only remove if this is still the disconnected instance (not replaced by reconnect)
                if (current && current.disconnectTimer) {
                    room.delete(participant.id);
                    if (room.size === 0) rooms.delete(slug);
                    else broadcastParticipants(slug);
                }
            }, GRACE_PERIOD_MS);
        });
    });
};

function broadcastParticipants(slug) {
    const room = rooms.get(slug);
    if (!room) return;
    const participants = Array.from(room.values()).map(p => ({
        id: p.id, name: p.name, role: p.role,
    }));
    const msg = JSON.stringify({ type: 'participants:update', participants });
    for (const p of room.values()) {
        if (p.ws.readyState === 1) p.ws.send(msg);
    }
}

function broadcastToRoom(slug, msg) {
    const room = rooms.get(slug);
    if (!room) return;
    const str = JSON.stringify(msg);
    for (const p of room.values()) {
        if (p.ws.readyState === 1) p.ws.send(str);
    }
}

events.on('room:live',    slug => broadcastToRoom(slug, { type: 'room:live' }));
events.on('room:pending', slug => broadcastToRoom(slug, { type: 'room:pending' }));
events.on('room:ended',   slug => {
    broadcastToRoom(slug, { type: 'room:ended' });
    // Delete chat history — same privacy lifecycle as uploaded files
    try {
        db.prepare('DELETE FROM chat_messages WHERE room_id = (SELECT id FROM rooms WHERE slug = ?)').run(slug);
    } catch {}
});
events.on('file:shared',  ({ slug, ...msg }) => broadcastToRoom(slug, { type: 'file:shared', ...msg }));

events.on('participant:kicked', ({ slug, participantId }) => {
    const room = rooms.get(slug);
    if (!room) return;
    const p = room.get(participantId);
    if (!p) return;
    clearTimeout(p.disconnectTimer);
    try { p.ws.send(JSON.stringify({ type: 'kicked' })); } catch {}
    p.ws.close(1008, 'Kicked');
    room.delete(participantId);
    if (room.size === 0) rooms.delete(slug);
    else broadcastParticipants(slug);
});
