const router = require('express').Router();
const db = require('../db');
const { auth, admin } = require('../middleware/auth');
const nodemailer = require('nodemailer');

const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

async function enviarConfirmacion(reserva, items) {
  if (!reserva.email_cliente) return;
  const itemsHtml = items.map(i =>
    `<tr><td>${i.nombre}</td><td>${i.cantidad}</td><td>$${i.precio_unitario}</td><td>$${i.subtotal}</td></tr>`
  ).join('');

  await mailer.sendMail({
    from: process.env.EMAIL_FROM,
    to: reserva.email_cliente,
    subject: `Confirmación de reserva #${reserva.id.slice(0,8).toUpperCase()}`,
    html: `
      <h2>¡Reserva recibida!</h2>
      <p>Hola ${reserva.nombre_cliente}, tu reserva ha sido registrada exitosamente.</p>
      <p><strong>Fechas:</strong> ${reserva.fecha_inicio} al ${reserva.fecha_fin}</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
        <thead><tr><th>Artículo</th><th>Cant.</th><th>Precio/día</th><th>Subtotal</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <p><strong>Total: $${reserva.total}</strong></p>
      <p>Nos pondremos en contacto para confirmar los detalles de entrega.</p>
    `
  });
}

// Ayudante para modificar stock de muebles en base a un item de reserva
async function actualizarStockItem(client, item, accion) {
  const factor = accion === 'sumar' ? 1 : -1;
  
  if (item.combo_id) {
    const componentes = await client.query('SELECT mueble_id, cantidad FROM combo_items WHERE combo_id = $1', [item.combo_id]);
    for (const comp of componentes.rows) {
      const cantidadTotal = comp.cantidad * item.cantidad;
      await client.query(
        'UPDATE muebles SET stock = stock + $1 WHERE id = $2',
        [cantidadTotal * factor, comp.mueble_id]
      );
    }
  } else if (item.mueble_id) {
    await client.query(
      'UPDATE muebles SET stock = stock + $1 WHERE id = $2',
      [item.cantidad * factor, item.mueble_id]
    );
  }
}

// Función para completar automáticamente reservas que ya pasaron su fecha de fin
async function autoCompletarReservasExpiradas() {
  const client = await db.connect();
  try {
    const query = `
      SELECT id 
      FROM reservas 
      WHERE fecha_fin < CURRENT_DATE 
        AND estado IN ('pendiente', 'confirmada', 'activa')
    `;
    const res = await client.query(query);
    for (const r of res.rows) {
      try {
        await client.query('BEGIN');
        await client.query("UPDATE reservas SET estado = 'completada' WHERE id = $1", [r.id]);
        const itemsRes = await client.query(
          "SELECT mueble_id, combo_id, cantidad FROM reserva_items WHERE reserva_id = $1", 
          [r.id]
        );
        for (const item of itemsRes.rows) {
          await actualizarStockItem(client, item, 'sumar');
        }
        await client.query('COMMIT');
        console.log(`[Auto-completar] Reserva ${r.id} completada automáticamente (fecha vencida).`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Auto-completar] Error en reserva ${r.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Auto-completar] Error general:', err.message);
  } finally {
    client.release();
  }
}
router.autoCompletarReservasExpiradas = autoCompletarReservasExpiradas;

// Crear reserva (público o autenticado)
router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const {
      fecha_inicio, fecha_fin,
      nombre_cliente, email_cliente, telefono_cliente,
      direccion_entrega, notas, items
    } = req.body;

    if (!items || !items.length)
      return res.status(400).json({ error: 'Debe incluir al menos un mueble o combo' });

    // Calcular total
    let total = 0;
    const dias = Math.ceil((new Date(fecha_fin) - new Date(fecha_inicio)) / 86400000) + 1;
    const itemsDetalle = [];

    for (const item of items) {
      if (item.combo_id) {
        // Es un combo/grupo
        const comboRes = await client.query('SELECT * FROM combos WHERE id = $1 AND activo = true', [item.combo_id]);
        if (!comboRes.rows.length) throw new Error(`Combo ${item.combo_id} no encontrado`);
        const combo = comboRes.rows[0];

        // Verificar disponibilidad de componentes individuales
        const componentes = await client.query(
          `SELECT ci.*, m.nombre, m.stock 
           FROM combo_items ci 
           JOIN muebles m ON m.id = ci.mueble_id 
           WHERE ci.combo_id = $1 AND m.activo = true`,
          [combo.id]
        );

        for (const comp of componentes.rows) {
          const cantidadNecesaria = comp.cantidad * item.cantidad;
          if (comp.stock < cantidadNecesaria) {
            throw new Error(
              `Stock insuficiente de "${comp.nombre}" para el combo "${combo.nombre}". Requeridas: ${cantidadNecesaria}, Disponibles: ${comp.stock}`
            );
          }
        }

        let precio = combo.precio_dia;
        if (dias >= 30 && combo.precio_mes) precio = combo.precio_mes / 30;
        else if (dias >= 7 && combo.precio_semana) precio = combo.precio_semana / 7;

        const subtotal = parseFloat((precio * item.cantidad * dias).toFixed(2));
        total += subtotal;
        itemsDetalle.push({
          combo_id: combo.id,
          mueble_id: null,
          nombre: combo.nombre,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad
        });

      } else if (item.mueble_id) {
        // Es mueble individual
        const mueble = await client.query('SELECT * FROM muebles WHERE id=$1 AND activo=true', [item.mueble_id]);
        if (!mueble.rows.length) throw new Error(`Mueble ${item.mueble_id} no encontrado`);
        const m = mueble.rows[0];

        if (m.stock < item.cantidad)
          throw new Error(`Solo hay ${m.stock} unidades disponibles de "${m.nombre}"`);

        let precio = m.precio_dia;
        if (dias >= 30 && m.precio_mes) precio = m.precio_mes / 30;
        else if (dias >= 7 && m.precio_semana) precio = m.precio_semana / 7;

        const subtotal = parseFloat((precio * item.cantidad * dias).toFixed(2));
        total += subtotal;
        itemsDetalle.push({
          combo_id: null,
          mueble_id: m.id,
          nombre: m.nombre,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad
        });
      } else if (item.nombre) {
        // Es un servicio manual
        const precio = parseFloat(item.precio_unitario || 0);
        const subtotal = parseFloat((precio * item.cantidad).toFixed(2));
        total += subtotal;
        itemsDetalle.push({
          combo_id: null,
          mueble_id: null,
          nombre: item.nombre,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad
        });
      }
    }

    const reservaResult = await client.query(
      `INSERT INTO reservas (fecha_inicio, fecha_fin, nombre_cliente, email_cliente, telefono_cliente, direccion_entrega, notas, total, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [fecha_inicio, fecha_fin, nombre_cliente, email_cliente, telefono_cliente, direccion_entrega, notas, total.toFixed(2), 'activa']
    );
    const reserva = reservaResult.rows[0];

    for (const item of itemsDetalle) {
      await client.query(
        'INSERT INTO reserva_items (reserva_id, mueble_id, combo_id, cantidad, precio_unitario, subtotal, nombre) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [reserva.id, item.mueble_id, item.combo_id, item.cantidad, item.precio_unitario, item.subtotal, item.nombre]
      );
      // Decrementar stock físico de componentes / muebles individuales
      await actualizarStockItem(client, item, 'restar');
    }

    await client.query('COMMIT');

    enviarConfirmacion(reserva, itemsDetalle).catch(console.error);
    res.status(201).json({ reserva, items: itemsDetalle });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/', auth, async (req, res) => {
  try {
    await autoCompletarReservasExpiradas();
    let query, params;
    if (req.user.rol === 'admin') {
      query = `
        SELECT r.*, 
               COALESCE(
                 json_agg(
                   json_build_object(
                     'mueble_id', ri.mueble_id,
                     'combo_id', ri.combo_id,
                     'mueble', COALESCE(ri.nombre, m.nombre, c.nombre),
                     'cantidad', ri.cantidad,
                     'subtotal', ri.subtotal
                   )
                 ) FILTER (WHERE ri.id IS NOT NULL), '[]'
               ) AS items
        FROM reservas r 
        LEFT JOIN reserva_items ri ON ri.reserva_id = r.id 
        LEFT JOIN muebles m ON m.id = ri.mueble_id 
        LEFT JOIN combos c ON c.id = ri.combo_id
        GROUP BY r.id 
        ORDER BY r.creado_en DESC
      `;
      params = [];
    } else {
      query = `
        SELECT r.*, 
               COALESCE(
                 json_agg(
                   json_build_object(
                     'mueble_id', ri.mueble_id,
                     'combo_id', ri.combo_id,
                     'mueble', COALESCE(ri.nombre, m.nombre, c.nombre),
                     'cantidad', ri.cantidad,
                     'subtotal', ri.subtotal
                   )
                 ) FILTER (WHERE ri.id IS NOT NULL), '[]'
               ) AS items
        FROM reservas r 
        LEFT JOIN reserva_items ri ON ri.reserva_id = r.id 
        LEFT JOIN muebles m ON m.id = ri.mueble_id 
        LEFT JOIN combos c ON c.id = ri.combo_id
        WHERE r.usuario_id = $1 
        GROUP BY r.id 
        ORDER BY r.creado_en DESC
      `;
      params = [req.user.id];
    }
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cambiar estado de reserva (solo admin)
router.patch('/:id/estado', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { estado } = req.body;
    const estados = ['pendiente','confirmada','activa','completada','cancelada'];
    if (!estados.includes(estado)) {
      client.release();
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const reservaRes = await client.query('SELECT estado FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    const estadoAnterior = reservaRes.rows[0].estado;

    const result = await client.query('UPDATE reservas SET estado=$1 WHERE id=$2 RETURNING *', [estado, req.params.id]);
    const reservaActualizada = result.rows[0];

    const vigenteAnterior = ['pendiente', 'confirmada', 'activa'].includes(estadoAnterior);
    const vigenteNuevo = ['pendiente', 'confirmada', 'activa'].includes(estado);

    if (vigenteAnterior !== vigenteNuevo) {
      const itemsRes = await client.query('SELECT mueble_id, combo_id, cantidad FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      
      for (const item of itemsRes.rows) {
        const accion = (vigenteAnterior && !vigenteNuevo) ? 'sumar' : 'restar';
        await actualizarStockItem(client, item, accion);
      }
    }

    await client.query('COMMIT');
    res.json(reservaActualizada);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Editar reserva completa (solo admin)
router.put('/:id', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const {
      fecha_inicio, fecha_fin,
      nombre_cliente, email_cliente, telefono_cliente,
      direccion_entrega, notas, estado, total
    } = req.body;

    const estados = ['pendiente','confirmada','activa','completada','cancelada'];
    if (estado && !estados.includes(estado)) {
      client.release();
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const reservaRes = await client.query('SELECT estado FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    const estadoAnterior = reservaRes.rows[0].estado;

    const result = await client.query(
      `UPDATE reservas 
       SET fecha_inicio=$1, fecha_fin=$2, nombre_cliente=$3, email_cliente=$4, 
           telefono_cliente=$5, direccion_entrega=$6, notas=$7, estado=$8, total=$9
       WHERE id=$10 RETURNING *`,
      [fecha_inicio, fecha_fin, nombre_cliente, email_cliente, telefono_cliente, direccion_entrega, notas, estado, total, req.params.id]
    );
    const reservaActualizada = result.rows[0];

    const vigenteAnterior = ['pendiente', 'confirmada', 'activa'].includes(estadoAnterior);
    const vigenteNuevo = ['pendiente', 'confirmada', 'activa'].includes(estado);

    if (vigenteAnterior !== vigenteNuevo) {
      const itemsRes = await client.query('SELECT mueble_id, combo_id, cantidad FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      
      for (const item of itemsRes.rows) {
        const accion = (vigenteAnterior && !vigenteNuevo) ? 'sumar' : 'restar';
        await actualizarStockItem(client, item, accion);
      }
    }

    await client.query('COMMIT');
    res.json(reservaActualizada);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Editar items de la reserva (solo admin) - Reemplaza los artículos y recalcula total
router.put('/:id/items', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { items } = req.body;
    const reservaId = req.params.id;

    if (!items || !items.length) {
      throw new Error('La reserva debe tener al menos un mueble o combo');
    }

    const reservaRes = await client.query('SELECT * FROM reservas WHERE id = $1', [reservaId]);
    if (!reservaRes.rows.length) {
      throw new Error('Reserva no encontrada');
    }
    const reserva = reservaRes.rows[0];
    const esVigente = ['pendiente', 'confirmada', 'activa'].includes(reserva.estado);

    // 1. Si es vigente, revertir stock antiguo antes de borrar
    if (esVigente) {
      const antiguos = await client.query('SELECT * FROM reserva_items WHERE reserva_id = $1', [reservaId]);
      for (const ant of antiguos.rows) {
        await actualizarStockItem(client, ant, 'sumar');
      }
    }

    // 2. Eliminar items anteriores
    await client.query('DELETE FROM reserva_items WHERE reserva_id = $1', [reservaId]);

    // 3. Procesar nuevos items
    const dias = Math.ceil((new Date(reserva.fecha_fin) - new Date(reserva.fecha_inicio)) / 86400000) + 1;
    let nuevoTotal = 0;
    const itemsProcesados = [];

    for (const item of items) {
      if (item.combo_id) {
        const comboRes = await client.query('SELECT * FROM combos WHERE id = $1 AND activo = true', [item.combo_id]);
        if (!comboRes.rows.length) throw new Error(`Combo ${item.combo_id} no encontrado`);
        const combo = comboRes.rows[0];

        // Verificar disponibilidad en componentes
        const componentes = await client.query(
          `SELECT ci.*, m.nombre, m.stock 
           FROM combo_items ci 
           JOIN muebles m ON m.id = ci.mueble_id 
           WHERE ci.combo_id = $1 AND m.activo = true`,
          [combo.id]
        );

        for (const comp of componentes.rows) {
          const cantidadNecesaria = comp.cantidad * item.cantidad;
          if (comp.stock < cantidadNecesaria) {
            throw new Error(
              `Stock insuficiente de "${comp.nombre}" para el combo "${combo.nombre}". Requeridas: ${cantidadNecesaria}, Disponibles: ${comp.stock}`
            );
          }
        }

        let precio = combo.precio_dia;
        if (dias >= 30 && combo.precio_mes) precio = combo.precio_mes / 30;
        else if (dias >= 7 && combo.precio_semana) precio = combo.precio_semana / 7;

        const subtotal = parseFloat((precio * item.cantidad * dias).toFixed(2));
        nuevoTotal += subtotal;
        itemsProcesados.push({
          combo_id: combo.id,
          mueble_id: null,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad
        });

      } else if (item.mueble_id) {
        const mueble = await client.query('SELECT * FROM muebles WHERE id = $1 AND activo = true', [item.mueble_id]);
        if (!mueble.rows.length) throw new Error(`Mueble ${item.mueble_id} no encontrado`);
        const m = mueble.rows[0];

        if (m.stock < item.cantidad) {
          throw new Error(`Stock insuficiente de "${m.nombre}". Disponibles: ${m.stock}`);
        }

        let precio = m.precio_dia;
        if (dias >= 30 && m.precio_mes) precio = m.precio_mes / 30;
        else if (dias >= 7 && m.precio_semana) precio = m.precio_semana / 7;

        const subtotal = parseFloat((precio * item.cantidad * dias).toFixed(2));
        nuevoTotal += subtotal;
        itemsProcesados.push({
          combo_id: null,
          mueble_id: m.id,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad
        });
      } else if (item.nombre) {
        const precio = parseFloat(item.precio_unitario || 0);
        const subtotal = parseFloat((precio * item.cantidad).toFixed(2));
        nuevoTotal += subtotal;
        itemsProcesados.push({
          combo_id: null,
          mueble_id: null,
          nombre: item.nombre,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad
        });
      }
    }

    // 4. Registrar nuevos items e impactar stock
    for (const item of itemsProcesados) {
      await client.query(
        'INSERT INTO reserva_items (reserva_id, mueble_id, combo_id, cantidad, precio_unitario, subtotal, nombre) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [reservaId, item.mueble_id, item.combo_id, item.cantidad, item.precio_unitario, item.subtotal, item.nombre]
      );
      if (esVigente) {
        await actualizarStockItem(client, item, 'restar');
      }
    }

    // 5. Actualizar el total de la reserva
    await client.query('UPDATE reservas SET total = $1 WHERE id = $2', [nuevoTotal.toFixed(2), reservaId]);

    await client.query('COMMIT');
    res.json({ ok: true, nuevoTotal });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Eliminar reserva (solo admin)
router.delete('/:id', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const reservaRes = await client.query('SELECT estado FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const estadoActual = reservaRes.rows[0].estado;
    const esVigente = ['pendiente', 'confirmada', 'activa'].includes(estadoActual);

    if (esVigente) {
      const itemsRes = await client.query('SELECT mueble_id, combo_id, cantidad FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      for (const item of itemsRes.rows) {
        await actualizarStockItem(client, item, 'sumar');
      }
    }

    await client.query('DELETE FROM pagos WHERE reserva_id = $1', [req.params.id]);
    await client.query('DELETE FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
    await client.query('DELETE FROM reservas WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
