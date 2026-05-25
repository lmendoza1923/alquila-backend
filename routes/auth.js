const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

// Registro
router.post('/register', async (req, res) => {
  try {
    const { nombre, email, password, telefono } = req.body;
    if (!nombre || !email || !password)
      return res.status(400).json({ error: 'Campos requeridos: nombre, email, password' });

    const existe = await db.query('SELECT id FROM usuarios WHERE email=$1', [email]);
    if (existe.rows.length) return res.status(409).json({ error: 'Email ya registrado' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO usuarios (nombre, email, password_hash, telefono) VALUES ($1,$2,$3,$4) RETURNING id, nombre, email, rol',
      [nombre, email, hash, telefono]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, rol: user.rol }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db.query('SELECT * FROM usuarios WHERE email=$1 AND activo=true', [email]);
    if (!result.rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign({ id: user.id, rol: user.rol }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, ...userSafe } = user;
    res.json({ user: userSafe, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
