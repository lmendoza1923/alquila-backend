const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Listar muebles (con filtros opcionales)
router.get('/', async (req, res) => {
  try {
    const { categoria, busqueda, fecha_inicio, fecha_fin } = req.query;
    let query = `
      SELECT m.*, c.nombre AS categoria_nombre
      FROM muebles m
      LEFT JOIN categorias c ON c.id = m.categoria_id
      WHERE m.activo = true
    `;
    const params = [];
    if (categoria) { params.push(categoria); query += ` AND m.categoria_id = $${params.length}`; }
    if (busqueda)  { params.push(`%${busqueda}%`); query += ` AND m.nombre ILIKE $${params.length}`; }
    query += ' ORDER BY m.nombre';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalle de mueble
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.*, c.nombre AS categoria_nombre
       FROM muebles m LEFT JOIN categorias c ON c.id = m.categoria_id
       WHERE m.id = $1 AND m.activo = true`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mueble no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verificar disponibilidad de un mueble en rango de fechas
router.get('/:id/disponibilidad', async (req, res) => {
  try {
    const { fecha_inicio, fecha_fin } = req.query;
    const mueble = await db.query('SELECT stock FROM muebles WHERE id=$1', [req.params.id]);
    if (!mueble.rows.length) return res.status(404).json({ error: 'Mueble no encontrado' });

    const stock = mueble.rows[0].stock;
    const reservado = await db.query(`
      SELECT COALESCE(SUM(ri.cantidad),0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      WHERE ri.mueble_id = $1
        AND r.estado NOT IN ('cancelada')
        AND NOT (r.fecha_fin < $2 OR r.fecha_inicio > $3)
    `, [req.params.id, fecha_inicio, fecha_fin]);

    const ocupado = parseInt(reservado.rows[0].total);
    res.json({ disponible: stock - ocupado, stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD admin
router.post('/', admin, async (req, res) => {
  try {
    const { nombre, descripcion, categoria_id, precio_dia, precio_semana, precio_mes, stock, imagenes } = req.body;
    const result = await db.query(
      `INSERT INTO muebles (nombre, descripcion, categoria_id, precio_dia, precio_semana, precio_mes, stock, imagenes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [nombre, descripcion, categoria_id, precio_dia, precio_semana, precio_mes, stock || 1, imagenes || []]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', admin, async (req, res) => {
  try {
    const { nombre, descripcion, categoria_id, precio_dia, precio_semana, precio_mes, stock, imagenes, activo } = req.body;
    const result = await db.query(
      `UPDATE muebles SET nombre=$1, descripcion=$2, categoria_id=$3, precio_dia=$4,
       precio_semana=$5, precio_mes=$6, stock=$7, imagenes=$8, activo=$9
       WHERE id=$10 RETURNING *`,
      [nombre, descripcion, categoria_id, precio_dia, precio_semana, precio_mes, stock, imagenes, activo, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', admin, async (req, res) => {
  try {
    await db.query('UPDATE muebles SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
