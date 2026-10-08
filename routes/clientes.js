const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Obtener todos los clientes con resumen de reservas y detalles
router.get('/', admin, async (req, res) => {
  try {
    const { q } = req.query;
    let whereClause = '';
    const params = [];

    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      whereClause = `
        WHERE LOWER(COALESCE(c.nombre, '')) LIKE $1
           OR LOWER(COALESCE(c.alias, '')) LIKE $1
           OR LOWER(COALESCE(c.cedula, '')) LIKE $1
           OR LOWER(COALESCE(c.telefono, '')) LIKE $1
           OR LOWER(COALESCE(c.email, '')) LIKE $1
           OR LOWER(COALESCE(c.direccion, '')) LIKE $1
      `;
    }

    const query = `
      SELECT 
        c.id,
        c.alias,
        c.nombre,
        c.cedula,
        c.telefono,
        c.email,
        c.direccion,
        c.notas,
        c.creado_en,
        c.actualizado_en,
        COALESCE(res_agg.total_reservas, 0) AS total_reservas,
        COALESCE(res_agg.total_facturado, 0) AS total_facturado,
        COALESCE(res_agg.total_pagado, 0) AS total_pagado,
        COALESCE(res_agg.saldo_pendiente, 0) AS saldo_pendiente,
        res_agg.ultima_reserva,
        COALESCE(res_agg.reservas, '[]'::json) AS reservas
      FROM clientes c
      LEFT JOIN (
        SELECT 
          r.cliente_id,
          COUNT(r.id)::int AS total_reservas,
          COALESCE(SUM(CASE WHEN r.estado != 'cancelada' THEN r.total ELSE 0 END), 0) AS total_facturado,
          COALESCE(SUM(CASE WHEN r.estado != 'cancelada' THEN COALESCE(pagos_sub.total_pagos, 0) ELSE 0 END), 0) AS total_pagado,
          COALESCE(SUM(CASE WHEN r.estado != 'cancelada' THEN GREATEST(0, r.total - COALESCE(pagos_sub.total_pagos, 0)) ELSE 0 END), 0) AS saldo_pendiente,
          MAX(r.fecha_inicio) AS ultima_reserva,
          json_agg(
            json_build_object(
              'id', r.id,
              'fecha_inicio', r.fecha_inicio,
              'fecha_fin', r.fecha_fin,
              'estado', r.estado,
              'total', r.total,
              'direccion_entrega', r.direccion_entrega,
              'notas', r.notas,
              'creado_en', r.creado_en,
              'total_pagado', COALESCE(pagos_sub.total_pagos, 0),
              'saldo_pendiente', GREATEST(0, r.total - COALESCE(pagos_sub.total_pagos, 0)),
              'items', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'mueble_id', ri.mueble_id,
                    'combo_id', ri.combo_id,
                    'nombre', COALESCE(ri.nombre, m.nombre, cb.nombre),
                    'cantidad', ri.cantidad,
                    'precio_unitario', ri.precio_unitario,
                    'subtotal', ri.subtotal
                  )
                )
                FROM reserva_items ri
                LEFT JOIN muebles m ON m.id = ri.mueble_id
                LEFT JOIN combos cb ON cb.id = ri.combo_id
                WHERE ri.reserva_id = r.id
              ), '[]'::json)
            ) ORDER BY r.creado_en DESC
          ) AS reservas
        FROM reservas r
        LEFT JOIN (
          SELECT reserva_id, SUM(monto) AS total_pagos
          FROM pagos
          GROUP BY reserva_id
        ) pagos_sub ON pagos_sub.reserva_id = r.id
        WHERE r.cliente_id IS NOT NULL
        GROUP BY r.cliente_id
      ) res_agg ON res_agg.cliente_id = c.id
      ${whereClause}
      ORDER BY c.creado_en DESC, c.nombre ASC
    `;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener clientes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obtener un cliente específico con todas sus reservas
router.get('/:id', admin, async (req, res) => {
  try {
    const { id } = req.params;
    const clientRes = await db.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (!clientRes.rows.length) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const cliente = clientRes.rows[0];

    const reservasRes = await db.query(`
      SELECT 
        r.*,
        COALESCE(SUM(p.monto), 0) AS total_pagado,
        GREATEST(0, r.total - COALESCE(SUM(p.monto), 0)) AS saldo_pendiente,
        COALESCE(
          json_agg(
            json_build_object(
              'mueble_id', ri.mueble_id,
              'combo_id', ri.combo_id,
              'nombre', COALESCE(ri.nombre, m.nombre, cb.nombre),
              'cantidad', ri.cantidad,
              'precio_unitario', ri.precio_unitario,
              'subtotal', ri.subtotal
            )
          ) FILTER (WHERE ri.id IS NOT NULL), '[]'::json
        ) AS items
      FROM reservas r
      LEFT JOIN pagos p ON p.reserva_id = r.id
      LEFT JOIN reserva_items ri ON ri.reserva_id = r.id
      LEFT JOIN muebles m ON m.id = ri.mueble_id
      LEFT JOIN combos cb ON cb.id = ri.combo_id
      WHERE r.cliente_id = $1
      GROUP BY r.id
      ORDER BY r.creado_en DESC
    `, [id]);

    cliente.reservas = reservasRes.rows;
    res.json(cliente);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint público para que el cliente llene el formulario desde un enlace compartido
router.post('/publico', async (req, res) => {
  try {
    const { alias, nombre, cedula, telefono, email, direccion, notas } = req.body;

    if (!nombre && !alias && !telefono) {
      return res.status(400).json({ error: 'Debes proporcionar al menos tu nombre y número de teléfono' });
    }

    const nom = nombre ? nombre.trim() : (alias ? alias.trim() : 'Cliente sin nombre');
    const ali = alias ? alias.trim() : null;
    const ced = cedula ? cedula.trim() : null;
    const tel = telefono ? telefono.trim() : null;
    const em = email ? email.trim() : null;
    const dir = direccion ? direccion.trim() : null;
    const not = notas ? notas.trim() : null;

    // Verificar si ya existe por cédula o teléfono para no duplicar si el cliente ya está registrado
    let clienteExistente = null;
    if (ced) {
      const checkCed = await db.query('SELECT * FROM clientes WHERE LOWER(TRIM(cedula)) = LOWER($1)', [ced]);
      if (checkCed.rows.length) clienteExistente = checkCed.rows[0];
    }
    if (!clienteExistente && tel) {
      const checkTel = await db.query('SELECT * FROM clientes WHERE TRIM(telefono) = $1', [tel]);
      if (checkTel.rows.length) clienteExistente = checkTel.rows[0];
    }

    let cliente;
    if (clienteExistente) {
      // Actualizar datos del cliente existente
      const upRes = await db.query(`
        UPDATE clientes SET
          alias = COALESCE($1, alias),
          nombre = COALESCE($2, nombre),
          cedula = COALESCE($3, cedula),
          telefono = COALESCE($4, telefono),
          email = COALESCE($5, email),
          direccion = COALESCE($6, direccion),
          notas = CASE 
            WHEN notas IS NULL OR notas = '' THEN $7 
            WHEN $7 IS NOT NULL AND $7 != '' AND $7 != notas THEN notas || E'\n' || $7 
            ELSE notas 
          END,
          actualizado_en = CURRENT_TIMESTAMP
        WHERE id = $8
        RETURNING *
      `, [ali, nom, ced, tel, em, dir, not, clienteExistente.id]);
      cliente = upRes.rows[0];
    } else {
      // Crear nuevo cliente
      const insRes = await db.query(`
        INSERT INTO clientes (alias, nombre, cedula, telefono, email, direccion, notas)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [ali, nom, ced, tel, em, dir, not]);
      cliente = insRes.rows[0];
    }

    res.status(201).json({
      ok: true,
      mensaje: 'Información registrada con éxito',
      cliente
    });
  } catch (err) {
    console.error('Error en formulario público de clientes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Crear un nuevo cliente (panel admin)
router.post('/', admin, async (req, res) => {
  try {
    const { alias, nombre, cedula, telefono, email, direccion, notas } = req.body;

    if (!nombre && !alias) {
      return res.status(400).json({ error: 'El nombre o alias del cliente es obligatorio' });
    }

    const result = await db.query(`
      INSERT INTO clientes (alias, nombre, cedula, telefono, email, direccion, notas)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      alias ? alias.trim() : null,
      nombre ? nombre.trim() : (alias ? alias.trim() : 'Sin nombre'),
      cedula ? cedula.trim() : null,
      telefono ? telefono.trim() : null,
      email ? email.trim() : null,
      direccion ? direccion.trim() : null,
      notas ? notas.trim() : null
    ]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar un cliente existente
router.put('/:id', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const {
      alias, nombre, cedula, telefono, email, direccion, notas,
      actualizar_reservas = true
    } = req.body;

    const existe = await client.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (!existe.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const updatedNombre = nombre !== undefined ? (nombre ? nombre.trim() : '') : existe.rows[0].nombre;
    const updatedAlias = alias !== undefined ? (alias ? alias.trim() : null) : existe.rows[0].alias;
    const updatedCedula = cedula !== undefined ? (cedula ? cedula.trim() : null) : existe.rows[0].cedula;
    const updatedTelefono = telefono !== undefined ? (telefono ? telefono.trim() : null) : existe.rows[0].telefono;
    const updatedEmail = email !== undefined ? (email ? email.trim() : null) : existe.rows[0].email;
    const updatedDireccion = direccion !== undefined ? (direccion ? direccion.trim() : null) : existe.rows[0].direccion;
    const updatedNotas = notas !== undefined ? (notas ? notas.trim() : null) : existe.rows[0].notas;

    const resCliente = await client.query(`
      UPDATE clientes SET
        alias = $1,
        nombre = $2,
        cedula = $3,
        telefono = $4,
        email = $5,
        direccion = $6,
        notas = $7,
        actualizado_en = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [
      updatedAlias,
      updatedNombre || updatedAlias || 'Sin nombre',
      updatedCedula,
      updatedTelefono,
      updatedEmail,
      updatedDireccion,
      updatedNotas,
      id
    ]);

    // Opcionalmente actualizar reservas asociadas para mantener consistencia histórica
    if (actualizar_reservas) {
      await client.query(`
        UPDATE reservas SET
          alias_cliente = COALESCE($1, alias_cliente),
          nombre_cliente = COALESCE($2, nombre_cliente),
          cedula_cliente = COALESCE($3, cedula_cliente),
          telefono_cliente = COALESCE($4, telefono_cliente),
          email_cliente = COALESCE($5, email_cliente),
          direccion_entrega = COALESCE($6, direccion_entrega)
        WHERE cliente_id = $7
      `, [
        updatedAlias,
        updatedNombre,
        updatedCedula,
        updatedTelefono,
        updatedEmail,
        updatedDireccion,
        id
      ]);
    }

    await client.query('COMMIT');
    res.json(resCliente.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Eliminar un cliente
router.delete('/:id', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    // Desvincular de reservas para no perder historial de reservas
    await client.query('UPDATE reservas SET cliente_id = NULL WHERE cliente_id = $1', [id]);
    const delRes = await client.query('DELETE FROM clientes WHERE id = $1 RETURNING *', [id]);

    if (!delRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    await client.query('COMMIT');
    res.json({ ok: true, mensaje: 'Cliente eliminado correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
