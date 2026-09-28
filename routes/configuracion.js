const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Obtener todas las configuraciones públicas
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT clave, valor FROM configuracion');
    const config = {};
    result.rows.forEach(r => {
      const val = r.valor;
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        try {
          config[r.clave] = JSON.parse(val);
        } catch (e) {
          config[r.clave] = val;
        }
      } else {
        config[r.clave] = val;
      }
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
      const valorStr = (typeof valor === 'object' && valor !== null) ? JSON.stringify(valor) : String(valor ?? '');
      await db.query(
        `INSERT INTO configuracion (clave, valor) VALUES ($1, $2)
         ON CONFLICT (clave) DO UPDATE SET valor = $2`,
        [clave, valorStr]
      );
    }
    res.json({ ok: true, message: 'Configuración actualizada' });
  } catch (err) {
    console.error('Error al guardar configuracion:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
