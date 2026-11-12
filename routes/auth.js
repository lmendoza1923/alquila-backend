const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { auth, admin } = require('../middleware/auth');

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

// Obtener lista de usuarios (solo admins)
router.get('/usuarios', auth, async (req, res) => {
  try {
    if (req.user.rol !== 'admin') {
      const result = await db.query('SELECT id, nombre, email, rol FROM usuarios WHERE id=$1', [req.user.id]);
      return res.json(result.rows);
    }
    const result = await db.query('SELECT id, nombre, email, rol, activo, creado_en FROM usuarios ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cambiar contraseña
router.put('/change-password', auth, async (req, res) => {
  try {
    const { passwordActual, nuevaPassword, usuario_id } = req.body;

    if (!nuevaPassword || nuevaPassword.trim().length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const targetUserId = (req.user.rol === 'admin' && usuario_id) ? usuario_id : req.user.id;
    const result = await db.query('SELECT * FROM usuarios WHERE id=$1', [targetUserId]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];

    // Si el usuario cambia su propia contraseña, exigir y validar la contraseña actual
    if (targetUserId === req.user.id) {
      if (!passwordActual) {
        return res.status(400).json({ error: 'Debes ingresar tu contraseña actual para confirmar el cambio' });
      }
      const ok = await bcrypt.compare(passwordActual, user.password_hash);
      if (!ok) {
        return res.status(400).json({ error: 'La contraseña actual no es correcta' });
      }
    }

    const newHash = await bcrypt.hash(nuevaPassword.trim(), 10);
    await db.query('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [newHash, targetUserId]);

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
