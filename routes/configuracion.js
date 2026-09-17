const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Obtener todas las configuraciones públicas
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT clave, valor FROM configuracion');
    const config = {};
    result.rows.forEach(r => {
      config[r.clave] = r.valor;
    });
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Actualizar configuraciones (solo admin)
router.put('/', admin, async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [clave, valor] of entries) {
      await db.query(
        `INSERT INTO configuracion (clave, valor) VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET valor = $2`,
        [clave, String(valor || '')]
      );
    }
    res.json({ ok: true, message: 'Configuración actualizada' });
  } catch (err) {
    console.error('Error al guardar configuracion:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
