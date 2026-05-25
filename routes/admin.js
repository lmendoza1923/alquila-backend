const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Dashboard stats
router.get('/stats', admin, async (req, res) => {
  try {
    const [reservas, ingresos, muebles, pendientes] = await Promise.all([
      db.query("SELECT COUNT(*) FROM reservas WHERE estado != 'cancelada'"),
      db.query("SELECT COALESCE(SUM(total),0) AS total FROM reservas WHERE estado IN ('confirmada','activa','completada')"),
      db.query('SELECT COUNT(*) FROM muebles WHERE activo=true'),
      db.query("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'")
    ]);

    res.json({
      total_reservas: parseInt(reservas.rows[0].count),
      ingresos_total: parseFloat(ingresos.rows[0].total),
      total_muebles: parseInt(muebles.rows[0].count),
      reservas_pendientes: parseInt(pendientes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reservas recientes
router.get('/reservas-recientes', admin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre_cliente, email_cliente, fecha_inicio, fecha_fin, estado, total, creado_en
       FROM reservas ORDER BY creado_en DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
