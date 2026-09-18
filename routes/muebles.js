const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');
const { obtenerStockComprometido } = require('../utils/disponibilidad');

// Listar muebles (con filtros opcionales y disponibilidad por fecha)
router.get('/', async (req, res) => {
  try {
    const { categoria, busqueda, todos, fecha_inicio, fecha_fin } = req.query;
    let query = `
      SELECT m.*, c.nombre AS categoria_nombre
      FROM muebles m
      LEFT JOIN categorias c ON c.id = m.categoria_id
      WHERE 1=1
    `;
    const params = [];

    if (todos !== 'true') {
      query += ' AND m.activo = true';
    }

    if (categoria) { params.push(categoria); query += ` AND m.categoria_id = $${params.length}`; }
    if (busqueda)  { params.push(`%${busqueda}%`); query += ` AND m.nombre ILIKE $${params.length}`; }
    query += ' ORDER BY m.nombre';

    const result = await db.query(query, params);

    if (fecha_inicio && fecha_fin) {
      const mapa = await obtenerStockComprometido(db, fecha_inicio, fecha_fin);
      const mueblesConDisponibilidad = result.rows.map(m => {
        const stockTotal = parseInt(m.stock) || 0;
        const comprometido = mapa[m.id] || 0;
        const disponible = Math.max(0, stockTotal - comprometido);
        return {
          ...m,
          stock_total: stockTotal,
          reservado: comprometido,
          stock_disponible: disponible,
          stock: disponible
        };
      });
      return res.json(mueblesConDisponibilidad);
    }

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
       WHERE m.id = $1`,
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
    const { fecha_inicio, fecha_fin, exclude_reserva_id } = req.query;
    const mueble = await db.query('SELECT id, nombre, stock FROM muebles WHERE id=$1', [req.params.id]);
    if (!mueble.rows.length) return res.status(404).json({ error: 'Mueble no encontrado' });

    const m = mueble.rows[0];
    const stockTotal = parseInt(m.stock) || 0;

    if (fecha_inicio && fecha_fin) {
      const mapa = await obtenerStockComprometido(db, fecha_inicio, fecha_fin, exclude_reserva_id || null);
      const comprometido = mapa[m.id] || 0;
      const disponible = Math.max(0, stockTotal - comprometido);
      return res.json({ disponible, stock: disponible, stock_total: stockTotal, reservado: comprometido });
    }

    res.json({ disponible: stockTotal, stock: stockTotal, stock_total: stockTotal, reservado: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD admin
router.post('/', admin, async (req, res) => {
  try {
    const { nombre, descripcion, categoria_id, precio_dia, stock, imagenes } = req.body;
    const pDia = (precio_dia !== undefined && precio_dia !== null && precio_dia !== '' && !isNaN(precio_dia)) ? parseFloat(precio_dia) : 0.00;
    const catId = (categoria_id !== undefined && categoria_id !== null && categoria_id !== '') ? parseInt(categoria_id) : null;
    
    const result = await db.query(
      `INSERT INTO muebles (nombre, descripcion, categoria_id, precio_dia, precio_semana, precio_mes, stock, imagenes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [nombre, descripcion, catId, pDia, null, null, stock || 1, imagenes || []]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', admin, async (req, res) => {
  try {
    const { nombre, descripcion, categoria_id, precio_dia, stock, imagenes, activo } = req.body;
    const pDia = (precio_dia !== undefined && precio_dia !== null && precio_dia !== '' && !isNaN(precio_dia)) ? parseFloat(precio_dia) : 0.00;
    const catId = (categoria_id !== undefined && categoria_id !== null && categoria_id !== '') ? parseInt(categoria_id) : null;

    const result = await db.query(
      `UPDATE muebles SET nombre=$1, descripcion=$2, categoria_id=$3, precio_dia=$4,
       precio_semana=$5, precio_mes=$6, stock=$7, imagenes=$8, activo=$9
       WHERE id=$10 RETURNING *`,
      [nombre, descripcion, catId, pDia, null, null, stock, imagenes, activo, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', admin, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM muebles WHERE id=$1 RETURNING *', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Mueble no encontrado' });
    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
