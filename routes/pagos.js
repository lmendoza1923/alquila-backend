const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Obtener pagos de una reserva
router.get('/reserva/:reservaId', admin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM pagos WHERE reserva_id = $1 ORDER BY creado_en ASC`,
      [req.params.reservaId]
    );
    // También devolver el saldo pendiente
    const reserva = await db.query('SELECT total FROM reservas WHERE id = $1', [req.params.reservaId]);
    if (!reserva.rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

    const totalPagado = result.rows.reduce((sum, p) => sum + parseFloat(p.monto), 0);
    const totalReserva = parseFloat(reserva.rows[0].total);

    res.json({
      pagos: result.rows,
      total_reserva: totalReserva,
      total_pagado: totalPagado,
      saldo_pendiente: totalReserva - totalPagado
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar un pago o abono
router.post('/', admin, async (req, res) => {
  try {
    const { reserva_id, monto, metodo, notas } = req.body;
    if (!reserva_id || !monto || parseFloat(monto) <= 0)
      return res.status(400).json({ error: 'Reserva y monto son obligatorios' });

    const result = await db.query(
      `INSERT INTO pagos (reserva_id, monto, metodo, notas) VALUES ($1, $2, $3, $4) RETURNING *`,
      [reserva_id, parseFloat(monto), metodo || 'efectivo', notas || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar un pago
router.delete('/:id', admin, async (req, res) => {
  try {
    await db.query('DELETE FROM pagos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener términos del contrato
router.get('/terminos', admin, async (req, res) => {
  try {
    const result = await db.query(`SELECT valor FROM configuracion WHERE clave = 'terminos_contrato'`);
    res.json({ terminos: result.rows[0]?.valor || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guardar términos del contrato
router.put('/terminos', admin, async (req, res) => {
  try {
    const { terminos } = req.body;
    await db.query(
      `INSERT INTO configuracion (clave, valor) VALUES ('terminos_contrato', $1)
       ON CONFLICT (clave) DO UPDATE SET valor = $1`,
      [terminos || '']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
