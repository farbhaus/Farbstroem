const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const router  = express.Router();

router.post('/login', async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });

    const hash = process.env._ADMIN_PASSWORD_HASH;
    if (!hash) return res.status(500).json({ error: 'Server misconfigured' });

    const ok = await bcrypt.compare(password, hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });

    const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, {
        expiresIn: '7d',
        algorithm: 'HS256',
    });
    res.json({ token });
});

router.post('/logout', (_req, res) => {
    res.json({ ok: true });
});

module.exports = router;
