const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// ── 1. Listar todas las sucursales con métricas de mobiliario ──────────────
router.get('/', admin, async (req, res) => {
  try {
    const query = `
      SELECT 
        s.id,
        s.nombre,
        s.codigo,
        s.direccion,
        s.telefono,
        s.encargado,
        s.email,
        s.color,
        s.es_principal,
        s.activo,
        s.creado_en,
        s.actualizado_en,
        COALESCE(COUNT(CASE WHEN sm.cantidad > 0 THEN sm.mueble_id END), 0)::int AS total_items,
        COALESCE(SUM(sm.cantidad), 0)::int AS total_unidades
      FROM sucursales s
      LEFT JOIN sucursal_mobiliario sm ON sm.sucursal_id = s.id
      GROUP BY s.id
      ORDER BY s.es_principal DESC, s.activo DESC, s.nombre ASC
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener sucursales:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. Matriz de Distribución General de Mobiliario ───────────────────────
router.get('/distribucion/general', admin, async (req, res) => {
  try {
    // 1. Obtener sucursales activas
    const resSucursales = await db.query(`
      SELECT id, nombre, codigo, color, es_principal
      FROM sucursales
      WHERE activo = true
      ORDER BY es_principal DESC, nombre ASC
    `);

    // 2. Obtener todos los muebles activos
    const resMuebles = await db.query(`
      SELECT m.id, m.nombre, m.stock, m.imagenes, m.precio_dia, m.categoria_id, c.nombre AS categoria_nombre
      FROM muebles m
      LEFT JOIN categorias c ON c.id = m.categoria_id
      WHERE m.activo = true
      ORDER BY c.nombre NULLS LAST, m.nombre ASC
    `);

    // 3. Obtener todas las asignaciones existentes
    const resAsignaciones = await db.query(`
      SELECT sucursal_id, mueble_id, cantidad, notas
      FROM sucursal_mobiliario
    `);

    // Construir mapa de asignaciones: [mueble_id][sucursal_id] = cantidad
    const mapaAsignaciones = {};
    for (const a of resAsignaciones.rows) {
      if (!mapaAsignaciones[a.mueble_id]) mapaAsignaciones[a.mueble_id] = {};
      mapaAsignaciones[a.mueble_id][a.sucursal_id] = {
        cantidad: parseInt(a.cantidad) || 0,
        notas: a.notas || ''
      };
    }

    // Armar estructura para cada mueble
    const matriz = resMuebles.rows.map(m => {
      const stockTotal = parseInt(m.stock) || 0;
      let totalAsignado = 0;
      const distribucion = {};

      for (const suc of resSucursales.rows) {
        const info = mapaAsignaciones[m.id]?.[suc.id] || { cantidad: 0, notas: '' };
        distribucion[suc.id] = info.cantidad;
        totalAsignado += info.cantidad;
      }

      return {
        id: m.id,
        nombre: m.nombre,
        categoria_nombre: m.categoria_nombre || 'Sin categoría',
        imagenes: m.imagenes || [],
        stock_total: stockTotal,
        distribucion,
        total_asignado: totalAsignado,
        sin_asignar: stockTotal - totalAsignado
      };
    });

    res.json({
      sucursales: resSucursales.rows,
      muebles: matriz
    });
  } catch (err) {
    console.error('Error al obtener matriz de distribución:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. Historial de transferencias entre sucursales ────────────────────────
router.get('/transferencias', admin, async (req, res) => {
  try {
    const query = `
      SELECT 
        t.id,
        t.mueble_id,
        m.nombre AS mueble_nombre,
        m.imagenes AS mueble_imagenes,
        t.origen_sucursal_id,
        COALESCE(so.nombre, 'Sin asignar / Bodega Externa') AS origen_nombre,
        t.destino_sucursal_id,
        COALESCE(sd.nombre, 'Sin asignar') AS destino_nombre,
        t.cantidad,
        t.motivo,
        t.fecha
      FROM transferencias_mobiliario t
      LEFT JOIN muebles m ON m.id = t.mueble_id
      LEFT JOIN sucursales so ON so.id = t.origen_sucursal_id
      LEFT JOIN sucursales sd ON sd.id = t.destino_sucursal_id
      ORDER BY t.fecha DESC
      LIMIT 100
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener transferencias:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. Detalle de una sucursal e inventario de mobiliario asignado ─────────
router.get('/:id', admin, async (req, res) => {
  try {
    const { id } = req.params;
    const resSuc = await db.query('SELECT * FROM sucursales WHERE id = $1', [id]);
    if (!resSuc.rows.length) {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }

    const queryMobiliario = `
      SELECT 
        m.id AS mueble_id,
        m.nombre,
        m.descripcion,
        m.imagenes,
        m.stock AS stock_total,
        m.precio_dia,
        c.nombre AS categoria_nombre,
        COALESCE(sm.cantidad, 0)::int AS cantidad,
        sm.notas
      FROM muebles m
      LEFT JOIN categorias c ON c.id = m.categoria_id
      LEFT JOIN sucursal_mobiliario sm ON sm.mueble_id = m.id AND sm.sucursal_id = $1
      WHERE m.activo = true
      ORDER BY sm.cantidad DESC NULLS LAST, m.nombre ASC
    `;
    const resMobiliario = await db.query(queryMobiliario, [id]);

    res.json({
      sucursal: resSuc.rows[0],
      mobiliario: resMobiliario.rows
    });
  } catch (err) {
    console.error('Error al obtener detalle de sucursal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 5. Crear nueva sucursal ───────────────────────────────────────────────
router.post('/', admin, async (req, res) => {
  try {
    const { nombre, codigo, direccion, telefono, encargado, email, color, es_principal, activo } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre de la sucursal es obligatorio' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Si se marca como principal, desmarcar las demás
      if (es_principal) {
        await client.query('UPDATE sucursales SET es_principal = false');
      }

      const insRes = await client.query(`
        INSERT INTO sucursales (nombre, codigo, direccion, telefono, encargado, email, color, es_principal, activo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        nombre.trim(),
        codigo ? codigo.trim() : null,
        direccion ? direccion.trim() : null,
        telefono ? telefono.trim() : null,
        encargado ? encargado.trim() : null,
        email ? email.trim() : null,
        color || '#4a6cf7',
        Boolean(es_principal),
        activo !== undefined ? Boolean(activo) : true
      ]);

      await client.query('COMMIT');
      res.status(201).json(insRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al crear sucursal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 6. Editar sucursal ────────────────────────────────────────────────────
router.put('/:id', admin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, codigo, direccion, telefono, encargado, email, color, es_principal, activo } = req.body;

    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ error: 'El nombre de la sucursal es obligatorio' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const existe = await client.query('SELECT * FROM sucursales WHERE id = $1', [id]);
      if (!existe.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Sucursal no encontrada' });
      }

      // Si se marca como principal, desmarcar las demás
      if (es_principal) {
        await client.query('UPDATE sucursales SET es_principal = false WHERE id != $1', [id]);
      }

      const upRes = await client.query(`
        UPDATE sucursales SET
          nombre = $1,
          codigo = $2,
          direccion = $3,
          telefono = $4,
          encargado = $5,
          email = $6,
          color = $7,
          es_principal = $8,
          activo = $9,
          actualizado_en = CURRENT_TIMESTAMP
        WHERE id = $10
        RETURNING *
      `, [
        nombre.trim(),
        codigo ? codigo.trim() : null,
        direccion ? direccion.trim() : null,
        telefono ? telefono.trim() : null,
        encargado ? encargado.trim() : null,
        email ? email.trim() : null,
        color || '#4a6cf7',
        Boolean(es_principal),
        activo !== undefined ? Boolean(activo) : true,
        id
      ]);

      await client.query('COMMIT');
      res.json(upRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al actualizar sucursal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 7. Eliminar sucursal ──────────────────────────────────────────────────
router.delete('/:id', admin, async (req, res) => {
  try {
    const { id } = req.params;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existe = await client.query('SELECT * FROM sucursales WHERE id = $1', [id]);
      if (!existe.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Sucursal no encontrada' });
      }

      await client.query('DELETE FROM sucursales WHERE id = $1', [id]);
      await client.query('COMMIT');
      res.json({ ok: true, mensaje: 'Sucursal eliminada correctamente' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al eliminar sucursal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 8. Guardar distribución masiva de mobiliario (Matriz) ─────────────────
router.post('/distribucion/guardar', admin, async (req, res) => {
  try {
    const { cambios } = req.body; // Array de { sucursal_id, mueble_id, cantidad, notas }
    if (!Array.isArray(cambios) || !cambios.length) {
      return res.status(400).json({ error: 'Debes enviar al menos un cambio de distribución' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      for (const c of cambios) {
        const cant = Math.max(0, parseInt(c.cantidad) || 0);
        await client.query(`
          INSERT INTO sucursal_mobiliario (sucursal_id, mueble_id, cantidad, notas, actualizado_en)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (sucursal_id, mueble_id)
          DO UPDATE SET 
            cantidad = EXCLUDED.cantidad,
            notas = COALESCE(EXCLUDED.notas, sucursal_mobiliario.notas),
            actualizado_en = CURRENT_TIMESTAMP
        `, [c.sucursal_id, c.mueble_id, cant, c.notas || null]);
      }

      await client.query('COMMIT');
      res.json({ ok: true, mensaje: 'Distribución actualizada con éxito' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al guardar distribución:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 9. Actualizar inventario de una sucursal específica ───────────────────
router.put('/:id/inventario', admin, async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body; // Array de { mueble_id, cantidad, notas }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Se esperaba un arreglo de items' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      for (const item of items) {
        const cant = Math.max(0, parseInt(item.cantidad) || 0);
        await client.query(`
          INSERT INTO sucursal_mobiliario (sucursal_id, mueble_id, cantidad, notas, actualizado_en)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (sucursal_id, mueble_id)
          DO UPDATE SET 
            cantidad = EXCLUDED.cantidad,
            notas = COALESCE(EXCLUDED.notas, sucursal_mobiliario.notas),
            actualizado_en = CURRENT_TIMESTAMP
        `, [id, item.mueble_id, cant, item.notas || null]);
      }

      await client.query('COMMIT');
      res.json({ ok: true, mensaje: 'Inventario de la sucursal actualizado correctamente' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al actualizar inventario de sucursal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 10. Transferir mobiliario entre dos sucursales ────────────────────────
router.post('/transferir', admin, async (req, res) => {
  try {
    const { mueble_id, origen_sucursal_id, destino_sucursal_id, cantidad, motivo } = req.body;

    if (!mueble_id) {
      return res.status(400).json({ error: 'Debes seleccionar un mueble' });
    }

    if (!destino_sucursal_id) {
      return res.status(400).json({ error: 'Debes seleccionar la sucursal de destino' });
    }

    if (origen_sucursal_id && origen_sucursal_id === destino_sucursal_id) {
      return res.status(400).json({ error: 'La sucursal de origen y destino no pueden ser la misma' });
    }

    const cantTransferir = parseInt(cantidad);
    if (!cantTransferir || cantTransferir <= 0) {
      return res.status(400).json({ error: 'La cantidad a transferir debe ser mayor a 0' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // 1. Si hay origen, verificar stock disponible en la sucursal de origen
      if (origen_sucursal_id) {
        const resOrigen = await client.query(`
          SELECT cantidad FROM sucursal_mobiliario
          WHERE sucursal_id = $1 AND mueble_id = $2
        `, [origen_sucursal_id, mueble_id]);

        const stockOrigen = resOrigen.rows.length ? parseInt(resOrigen.rows[0].cantidad) || 0 : 0;
        if (stockOrigen < cantTransferir) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            error: `La sucursal de origen solo tiene ${stockOrigen} unidad(es) de este artículo disponibles` 
          });
        }

        // Restar de la sucursal de origen
        await client.query(`
          UPDATE sucursal_mobiliario 
          SET cantidad = cantidad - $1, actualizado_en = CURRENT_TIMESTAMP
          WHERE sucursal_id = $2 AND mueble_id = $3
        `, [cantTransferir, origen_sucursal_id, mueble_id]);
      }

      // 2. Sumar a la sucursal de destino
      await client.query(`
        INSERT INTO sucursal_mobiliario (sucursal_id, mueble_id, cantidad, actualizado_en)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (sucursal_id, mueble_id)
        DO UPDATE SET 
          cantidad = sucursal_mobiliario.cantidad + EXCLUDED.cantidad,
          actualizado_en = CURRENT_TIMESTAMP
      `, [destino_sucursal_id, mueble_id, cantTransferir]);

      // 3. Registrar en historial de transferencias
      await client.query(`
        INSERT INTO transferencias_mobiliario (mueble_id, origen_sucursal_id, destino_sucursal_id, cantidad, motivo, usuario_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [mueble_id, origen_sucursal_id || null, destino_sucursal_id, cantTransferir, motivo || 'Transferencia entre sucursales', req.user?.id || null]);

      await client.query('COMMIT');
      res.json({ ok: true, mensaje: `Se transfirieron ${cantTransferir} unidades con éxito` });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al transferir mobiliario:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
