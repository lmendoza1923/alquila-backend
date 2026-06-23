const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Listar todos los combos activos
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT c.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', ci.id,
                   'mueble_id', m.id,
                   'nombre', m.nombre,
                   'cantidad', ci.cantidad,
                   'stock', m.stock
                 )
               ) FILTER (WHERE ci.id IS NOT NULL), '[]'
             ) AS items
      FROM combos c
      LEFT JOIN combo_items ci ON ci.combo_id = c.id
      LEFT JOIN muebles m ON m.id = ci.mueble_id AND m.activo = true
      WHERE c.activo = true
      GROUP BY c.id
      ORDER BY c.nombre;
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalle de un combo
router.get('/:id', async (req, res) => {
  try {
    const query = `
      SELECT c.*, 
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', ci.id,
                   'mueble_id', m.id,
                   'nombre', m.nombre,
                   'cantidad', ci.cantidad,
                   'stock', m.stock
                 )
               ) FILTER (WHERE ci.id IS NOT NULL), '[]'
             ) AS items
      FROM combos c
      LEFT JOIN combo_items ci ON ci.combo_id = c.id
      LEFT JOIN muebles m ON m.id = ci.mueble_id AND m.activo = true
      WHERE c.id = $1 AND c.activo = true
      GROUP BY c.id;
    `;
    const result = await db.query(query, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Combo no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear un combo (Solo admin)
router.post('/', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { nombre, descripcion, precio_dia, precio_semana, precio_mes, items } = req.body;

    if (!nombre || !precio_dia || isNaN(precio_dia)) {
      return res.status(400).json({ error: 'Nombre y precio por día son obligatorios' });
    }

    const comboRes = await client.query(
      `INSERT INTO combos (nombre, descripcion, precio_dia, precio_semana, precio_mes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nombre, descripcion, parseFloat(precio_dia), precio_semana ? parseFloat(precio_semana) : null, precio_mes ? parseFloat(precio_mes) : null]
    );
    const combo = comboRes.rows[0];

    const comboItems = [];
    if (items && items.length > 0) {
      for (const item of items) {
        const itemRes = await client.query(
          `INSERT INTO combo_items (combo_id, mueble_id, cantidad)
           VALUES ($1, $2, $3) RETURNING *`,
          [combo.id, item.mueble_id, parseInt(item.cantidad)]
        );
        comboItems.push(itemRes.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...combo, items: comboItems });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Modificar un combo (Solo admin)
router.put('/:id', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { nombre, descripcion, precio_dia, precio_semana, precio_mes, items, activo } = req.body;

    if (!nombre || !precio_dia || isNaN(precio_dia)) {
      return res.status(400).json({ error: 'Nombre y precio por día son obligatorios' });
    }

    const isActivo = activo !== undefined ? activo : true;

    const comboRes = await client.query(
      `UPDATE combos 
       SET nombre = $1, descripcion = $2, precio_dia = $3, precio_semana = $4, precio_mes = $5, activo = $6
       WHERE id = $7 RETURNING *`,
      [nombre, descripcion, parseFloat(precio_dia), precio_semana ? parseFloat(precio_semana) : null, precio_mes ? parseFloat(precio_mes) : null, isActivo, req.params.id]
    );

    if (!comboRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Combo no encontrado' });
    }

    const combo = comboRes.rows[0];

    // Eliminar las relaciones anteriores
    await client.query('DELETE FROM combo_items WHERE combo_id = $1', [combo.id]);

    // Insertar nuevas relaciones
    const comboItems = [];
    if (items && items.length > 0) {
      for (const item of items) {
        const itemRes = await client.query(
          `INSERT INTO combo_items (combo_id, mueble_id, cantidad)
           VALUES ($1, $2, $3) RETURNING *`,
          [combo.id, item.mueble_id, parseInt(item.cantidad)]
        );
        comboItems.push(itemRes.rows[0]);
      }
    }

    await client.query('COMMIT');
    res.json({ ...combo, items: comboItems });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Eliminar un combo lógicamente (Solo admin)
router.delete('/:id', admin, async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE combos SET activo = false WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Combo no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
