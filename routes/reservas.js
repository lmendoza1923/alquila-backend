const router = require('express').Router();
const db = require('../db');
const { auth, admin } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const googleCalendar = require('../services/googleCalendar');
const { validarDisponibilidadItems } = require('../utils/disponibilidad');

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

// Ayudante de compatibilidad: el inventario ahora se calcula dinámicamente por calendario
async function actualizarStockItem(client, item, accion) {
  return;
}

// Procesar y actualizar items de una reserva dentro de una transacción activa
async function procesarYActualizarItemsReserva(client, reservaId, items, reqTotal, fechaInicio, fechaFin, esVigenteNuevo) {
  if (!items || !items.length) {
    throw new Error('La reserva debe tener al menos un mueble o combo');
  }

  // 1. Eliminar items anteriores de las tablas hijas
  await client.query('DELETE FROM reserva_items WHERE reserva_id = $1', [reservaId]);
  await client.query('DELETE FROM reserva_combo_items WHERE reserva_id = $1', [reservaId]);

  // 2. Validar disponibilidad dinámica en las fechas seleccionadas si la reserva es vigente
  if (esVigenteNuevo) {
    await validarDisponibilidadItems(client, items, fechaInicio, fechaFin, reservaId);
  }

  // 3. Procesar nuevos items
  const dias = Math.ceil((new Date(fechaFin) - new Date(fechaInicio)) / 86400000) + 1;
  let nuevoTotal = 0;
  const itemsProcesados = [];

  for (const item of items) {
    if (item.combo_id) {
      const comboRes = await client.query('SELECT * FROM combos WHERE id = $1', [item.combo_id]);
      if (!comboRes.rows.length) throw new Error(`Combo ${item.combo_id} no encontrado`);
      const combo = comboRes.rows[0];

      // Determinar componentes a guardar
      let componentesParaGuardar = [];
      if (item.componentes && item.componentes.length > 0) {
        componentesParaGuardar = item.componentes;
      } else {
        const standardComps = await client.query(
          'SELECT ci.mueble_id, ci.cantidad, m.nombre FROM combo_items ci JOIN muebles m ON m.id = ci.mueble_id WHERE ci.combo_id = $1',
          [combo.id]
        );
        componentesParaGuardar = standardComps.rows;
      }

      let precio;
      if (item.precio_unitario !== undefined && item.precio_unitario !== null && !isNaN(item.precio_unitario)) {
        precio = parseFloat(item.precio_unitario);
      } else {
        precio = combo.precio_dia;
        if (dias >= 30 && combo.precio_mes) precio = combo.precio_mes / 30;
        else if (dias >= 7 && combo.precio_semana) precio = combo.precio_semana / 7;
      }

      const subtotal = parseFloat((precio * (parseInt(item.cantidad) || 1) * dias).toFixed(2));
      nuevoTotal += subtotal;
      itemsProcesados.push({
        combo_id: combo.id,
        mueble_id: null,
        nombre: combo.nombre,
        precio_unitario: precio,
        subtotal,
        cantidad: parseInt(item.cantidad) || 1,
        componentes: componentesParaGuardar
      });

    } else if (item.mueble_id) {
      const mueble = await client.query('SELECT * FROM muebles WHERE id = $1', [item.mueble_id]);
      if (!mueble.rows.length) throw new Error(`Mueble ${item.mueble_id} no encontrado`);
      const m = mueble.rows[0];

      let precio;
      if (item.precio_unitario !== undefined && item.precio_unitario !== null && !isNaN(item.precio_unitario)) {
        precio = parseFloat(item.precio_unitario);
      } else {
        precio = m.precio_dia;
        if (dias >= 30 && m.precio_mes) precio = m.precio_mes / 30;
        else if (dias >= 7 && m.precio_semana) precio = m.precio_semana / 7;
      }

      const subtotal = parseFloat((precio * (parseInt(item.cantidad) || 1) * dias).toFixed(2));
      nuevoTotal += subtotal;
      itemsProcesados.push({
        combo_id: null,
        mueble_id: m.id,
        nombre: m.nombre,
        precio_unitario: precio,
        subtotal,
        cantidad: parseInt(item.cantidad) || 1
      });

    } else if (item.nombre) {
      const precio = parseFloat(item.precio_unitario || 0);
      const subtotal = parseFloat((precio * (parseInt(item.cantidad) || 1)).toFixed(2));
      nuevoTotal += subtotal;
      itemsProcesados.push({
        combo_id: null,
        mueble_id: null,
        nombre: item.nombre,
        precio_unitario: precio,
        subtotal,
        cantidad: parseInt(item.cantidad) || 1
      });
    }
  }

  // 4. Registrar nuevos items en base de datos
  for (const item of itemsProcesados) {
    await client.query(
      'INSERT INTO reserva_items (reserva_id, mueble_id, combo_id, cantidad, precio_unitario, subtotal, nombre) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [reservaId, item.mueble_id, item.combo_id, item.cantidad, item.precio_unitario, item.subtotal, item.nombre]
    );

    if (item.combo_id && item.componentes && item.componentes.length > 0) {
      for (const comp of item.componentes) {
        await client.query(
          'INSERT INTO reserva_combo_items (reserva_id, combo_id, mueble_id, cantidad) VALUES ($1, $2, $3, $4)',
          [reservaId, item.combo_id, comp.mueble_id, comp.cantidad]
        );
      }
    }
  }

  const finalTotal = (reqTotal !== undefined && reqTotal !== null && !isNaN(reqTotal) && parseFloat(reqTotal) > 0)
    ? parseFloat(reqTotal)
    : nuevoTotal;

  await client.query('UPDATE reservas SET total = $1 WHERE id = $2', [finalTotal.toFixed(2), reservaId]);

  return { itemsProcesados, finalTotal };
}

// Función para saldar el saldo pendiente de una reserva específica
async function saldarSaldoPendienteReserva(client, reservaId, fechaFinStr) {
  const checkRes = await client.query(
    `SELECT r.id, r.total, TO_CHAR(r.fecha_fin, 'YYYY-MM-DD') AS fecha_fin_str,
            COALESCE(SUM(p.monto), 0) AS pagado 
     FROM reservas r 
     LEFT JOIN pagos p ON p.reserva_id = r.id 
     WHERE r.id = $1 
     GROUP BY r.id, r.total, r.fecha_fin`,
    [reservaId]
  );
  if (!checkRes.rows.length) return 0;
  
  const r = checkRes.rows[0];
  const actualPendiente = parseFloat(r.total || 0) - parseFloat(r.pagado || 0);
  if (actualPendiente > 0.001) {
    const montoFinal = parseFloat(actualPendiente.toFixed(2));
    const fechaRef = fechaFinStr || r.fecha_fin_str;
    if (fechaRef) {
      await client.query(
        `INSERT INTO pagos (reserva_id, monto, metodo, notas, creado_en)
         VALUES ($1, $2, $3, $4, ($5::date + TIME '20:00:00'))`,
        [r.id, montoFinal, 'efectivo', 'Saldo cancelado automáticamente al finalizar la reserva', fechaRef]
      );
    } else {
      await client.query(
        `INSERT INTO pagos (reserva_id, monto, metodo, notas, creado_en)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [r.id, montoFinal, 'efectivo', 'Saldo cancelado automáticamente al finalizar la reserva']
      );
    }
    console.log(`[Auto-saldar] Saldo de $${montoFinal} saldado automáticamente para la reserva ${r.id}.`);
    return montoFinal;
  }
  return 0;
}

// Función para completar automáticamente y saldar reservas que ya pasaron su fecha de fin o finalizaron
async function autoCompletarReservasExpiradas() {
  const client = await db.connect();
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock(987654321) AS locked');
    if (!lockRes.rows[0].locked) {
      return;
    }

    try {
      // 1. Marcar como completadas las reservas cuya fecha_fin ya pasó (< CURRENT_DATE) y siguen pendientes/activas/confirmadas
      const queryExpiradas = `
        SELECT id, fecha_fin, TO_CHAR(fecha_fin, 'YYYY-MM-DD') AS fecha_fin_str
        FROM reservas 
        WHERE fecha_fin < CURRENT_DATE 
          AND estado IN ('pendiente', 'confirmada', 'activa')
      `;
      const resExpiradas = await client.query(queryExpiradas);
      for (const r of resExpiradas.rows) {
        try {
          await client.query('BEGIN');
          await client.query("UPDATE reservas SET estado = 'completada' WHERE id = $1", [r.id]);
          const itemsRes = await client.query(
            "SELECT * FROM reserva_items WHERE reserva_id = $1", 
            [r.id]
          );
          for (const item of itemsRes.rows) {
            await actualizarStockItem(client, { ...item, reserva_id: r.id }, 'sumar');
          }
          await client.query('COMMIT');
          console.log(`[Auto-completar] Reserva ${r.id} completada automáticamente (fecha vencida).`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[Auto-completar] Error en reserva ${r.id}:`, err.message);
        }
      }

      // 2. Saldar el saldo pendiente de todas las reservas que ya finalizaron o están completadas
      // (fecha_fin < CURRENT_DATE OR estado = 'completada') y no están canceladas
      const queryPendientes = `
        SELECT r.id, r.total, TO_CHAR(r.fecha_fin, 'YYYY-MM-DD') AS fecha_fin_str,
               COALESCE(SUM(p.monto), 0) AS total_pagado,
               ROUND(r.total - COALESCE(SUM(p.monto), 0), 2) AS saldo_pendiente
        FROM reservas r
        LEFT JOIN pagos p ON p.reserva_id = r.id
        WHERE r.estado != 'cancelada'
          AND (r.fecha_fin < CURRENT_DATE OR r.estado = 'completada')
        GROUP BY r.id, r.total, r.fecha_fin
        HAVING ROUND(r.total - COALESCE(SUM(p.monto), 0), 2) > 0.001
        ORDER BY r.fecha_fin ASC
      `;
      const resPendientes = await client.query(queryPendientes);

      for (const r of resPendientes.rows) {
        try {
          await client.query('BEGIN');
          await saldarSaldoPendienteReserva(client, r.id, r.fecha_fin_str);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[Auto-saldar] Error al saldar reserva ${r.id}:`, err.message);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(987654321)');
    }
  } catch (err) {
    console.error('[Auto-completar/saldar] Error general:', err.message);
  } finally {
    client.release();
  }
}
router.autoCompletarReservasExpiradas = autoCompletarReservasExpiradas;
router.saldarSaldoPendienteReserva = saldarSaldoPendienteReserva;

// Crear reserva (público o autenticado)
router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const {
      fecha_inicio, fecha_fin,
      alias_cliente, nombre_cliente, cedula_cliente, email_cliente, telefono_cliente,
      contacto2_nombre, contacto2_telefono,
      direccion_entrega, notas, items
    } = req.body;

    if (!items || !items.length)
      return res.status(400).json({ error: 'Debe incluir al menos un mueble o combo' });

    // Validar disponibilidad por rango de fechas
    await validarDisponibilidadItems(client, items, fecha_inicio, fecha_fin, null);

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

        let precio;
        if (item.precio_unitario !== undefined && item.precio_unitario !== null && !isNaN(item.precio_unitario)) {
          precio = parseFloat(item.precio_unitario);
        } else {
          precio = combo.precio_dia;
          if (dias >= 30 && combo.precio_mes) precio = combo.precio_mes / 30;
          else if (dias >= 7 && combo.precio_semana) precio = combo.precio_semana / 7;
        }

        const subtotal = parseFloat((precio * item.cantidad * dias).toFixed(2));
        total += subtotal;
        itemsDetalle.push({
          combo_id: combo.id,
          mueble_id: null,
          nombre: combo.nombre,
          precio_unitario: precio,
          subtotal,
          cantidad: item.cantidad,
          componentes: item.componentes || null
        });

      } else if (item.mueble_id) {
        // Es mueble individual
        const mueble = await client.query('SELECT * FROM muebles WHERE id=$1 AND activo=true', [item.mueble_id]);
        if (!mueble.rows.length) throw new Error(`Mueble ${item.mueble_id} no encontrado`);
        const m = mueble.rows[0];

        let precio;
        if (item.precio_unitario !== undefined && item.precio_unitario !== null && !isNaN(item.precio_unitario)) {
          precio = parseFloat(item.precio_unitario);
        } else {
          precio = m.precio_dia;
          if (dias >= 30 && m.precio_mes) precio = m.precio_mes / 30;
          else if (dias >= 7 && m.precio_semana) precio = m.precio_semana / 7;
        }

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

    let finalClienteId = req.body.cliente_id || null;
    const ced = cedula_cliente ? cedula_cliente.trim() : null;
    const tel = telefono_cliente ? telefono_cliente.trim() : null;
    const nom = nombre_cliente ? nombre_cliente.trim() : null;
    const ali = alias_cliente ? alias_cliente.trim() : null;
    const c2Nom = contacto2_nombre ? contacto2_nombre.trim() : null;
    const c2Tel = contacto2_telefono ? contacto2_telefono.trim() : null;

    if (finalClienteId) {
      // Si el cliente fue jalado / seleccionado, actualizar datos para mantenerlos al día sin duplicar
      await client.query(`
        UPDATE clientes SET
          alias = COALESCE($1, alias),
          nombre = COALESCE($2, nombre),
          cedula = COALESCE($3, cedula),
          telefono = COALESCE($4, telefono),
          contacto2_nombre = COALESCE($5, contacto2_nombre),
          contacto2_telefono = COALESCE($6, contacto2_telefono),
          email = COALESCE($7, email),
          direccion = COALESCE($8, direccion),
          actualizado_en = CURRENT_TIMESTAMP
        WHERE id = $9
      `, [ali, nom, ced, tel, c2Nom, c2Tel, email_cliente || null, direccion_entrega || null, finalClienteId]);
    } else if (ced || tel || nom || ali) {
      if (ced) {
        const findCed = await client.query('SELECT id FROM clientes WHERE LOWER(TRIM(cedula)) = LOWER($1)', [ced]);
        if (findCed.rows.length) finalClienteId = findCed.rows[0].id;
      }
      if (!finalClienteId && tel) {
        const findTel = await client.query('SELECT id FROM clientes WHERE TRIM(telefono) = $1', [tel]);
        if (findTel.rows.length) finalClienteId = findTel.rows[0].id;
      }
      if (!finalClienteId && nom && nom.length > 2) {
        const findNom = await client.query('SELECT id FROM clientes WHERE LOWER(TRIM(nombre)) = LOWER($1)', [nom]);
        if (findNom.rows.length) finalClienteId = findNom.rows[0].id;
      }

      if (!finalClienteId && (nom || ali)) {
        const insCli = await client.query(`
          INSERT INTO clientes (alias, nombre, cedula, telefono, contacto2_nombre, contacto2_telefono, email, direccion, notas)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
        `, [ali || null, nom || ali || 'Cliente sin nombre', ced || null, tel || null, c2Nom, c2Tel, email_cliente || null, direccion_entrega || null, notas || null]);
        finalClienteId = insCli.rows[0].id;
      }
    }

    const resReserva = await client.query(
      `INSERT INTO reservas (fecha_inicio, fecha_fin, alias_cliente, nombre_cliente, cedula_cliente, email_cliente, telefono_cliente, direccion_entrega, notas, total, estado, cliente_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [fecha_inicio, fecha_fin, alias_cliente, nombre_cliente, cedula_cliente ? cedula_cliente.trim() : null, email_cliente, telefono_cliente, direccion_entrega, notas, total.toFixed(2), 'activa', finalClienteId]
    );
    const reserva = resReserva.rows[0];

    for (const item of itemsDetalle) {
      await client.query(
        'INSERT INTO reserva_items (reserva_id, mueble_id, combo_id, cantidad, precio_unitario, subtotal, nombre) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [reserva.id, item.mueble_id, item.combo_id, item.cantidad, item.precio_unitario, item.subtotal, item.nombre]
      );

      if (item.combo_id) {
        if (item.componentes && item.componentes.length > 0) {
          for (const comp of item.componentes) {
            await client.query(
              'INSERT INTO reserva_combo_items (reserva_id, combo_id, mueble_id, cantidad) VALUES ($1, $2, $3, $4)',
              [reserva.id, item.combo_id, comp.mueble_id, comp.cantidad]
            );
          }
        } else {
          const standardComps = await client.query('SELECT mueble_id, cantidad FROM combo_items WHERE combo_id = $1', [item.combo_id]);
          for (const comp of standardComps.rows) {
            await client.query(
              'INSERT INTO reserva_combo_items (reserva_id, combo_id, mueble_id, cantidad) VALUES ($1, $2, $3, $4)',
              [reserva.id, item.combo_id, comp.mueble_id, comp.cantidad]
            );
          }
        }
      }
    }

    await client.query('COMMIT');

    enviarConfirmacion(reserva, itemsDetalle).catch(console.error);
    googleCalendar.crearEventoReserva(reserva, itemsDetalle).catch(e => console.error('Error Google Calendar crearEvento:', e.message));

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
                     'subtotal', ri.subtotal,
                     'precio_unitario', ri.precio_unitario,
                     'componentes', (
                       SELECT COALESCE(json_agg(
                         json_build_object(
                           'mueble_id', rci.mueble_id,
                           'nombre', m2.nombre,
                           'cantidad', rci.cantidad
                         )
                       ), '[]')
                       FROM reserva_combo_items rci
                       JOIN muebles m2 ON m2.id = rci.mueble_id
                       WHERE rci.reserva_id = r.id AND rci.combo_id = ri.combo_id
                     )
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
                     'subtotal', ri.subtotal,
                     'precio_unitario', ri.precio_unitario,
                     'componentes', (
                       SELECT COALESCE(json_agg(
                         json_build_object(
                           'mueble_id', rci.mueble_id,
                           'nombre', m2.nombre,
                           'cantidad', rci.cantidad
                         )
                       ), '[]')
                       FROM reserva_combo_items rci
                       JOIN muebles m2 ON m2.id = rci.mueble_id
                       WHERE rci.reserva_id = r.id AND rci.combo_id = ri.combo_id
                     )
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
      const itemsRes = await client.query('SELECT * FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      
      for (const item of itemsRes.rows) {
        const accion = (vigenteAnterior && !vigenteNuevo) ? 'sumar' : 'restar';
        await actualizarStockItem(client, { ...item, reserva_id: req.params.id }, accion);
      }
    }

    if (estado === 'completada') {
      const fechaFinStr = reservaActualizada.fecha_fin ? (typeof reservaActualizada.fecha_fin === 'string' ? reservaActualizada.fecha_fin.substring(0, 10) : reservaActualizada.fecha_fin.toISOString().substring(0, 10)) : null;
      await saldarSaldoPendienteReserva(client, req.params.id, fechaFinStr);
    }

    await client.query('COMMIT');

    // Sincronizar con Google Calendar
    if (estado === 'cancelada' && reservaActualizada.google_event_id) {
      googleCalendar.eliminarEventoReserva(reservaActualizada.google_event_id).catch(e => console.error('Error Google Calendar:', e.message));
    } else {
      db.query('SELECT nombre, cantidad, precio_unitario, subtotal FROM reserva_items WHERE reserva_id = $1', [req.params.id])
        .then(rItems => googleCalendar.actualizarEventoReserva(reservaActualizada.google_event_id, reservaActualizada, rItems.rows))
        .catch(e => console.error('Error Google Calendar:', e.message));
    }

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
      alias_cliente, nombre_cliente, cedula_cliente, email_cliente, telefono_cliente,
      direccion_entrega, notas, estado, total, items, cliente_id
    } = req.body;

    const estados = ['pendiente','confirmada','activa','completada','cancelada'];
    if (estado && !estados.includes(estado)) {
      client.release();
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const reservaRes = await client.query('SELECT * FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    const reservaPrevia = reservaRes.rows[0];
    const estadoAnterior = reservaPrevia.estado;
    const nuevoEstado = estado || estadoAnterior;

    const vigenteAnterior = ['pendiente', 'confirmada', 'activa'].includes(estadoAnterior);
    const vigenteNuevo = ['pendiente', 'confirmada', 'activa'].includes(nuevoEstado);

    const fInicio = fecha_inicio || (reservaPrevia.fecha_inicio ? reservaPrevia.fecha_inicio.toISOString().substring(0, 10) : '');
    const fFin = fecha_fin || (reservaPrevia.fecha_fin ? reservaPrevia.fecha_fin.toISOString().substring(0, 10) : '');

    let itemsFinalesParaCalendario = null;

    if (items && Array.isArray(items) && items.length > 0) {
      // Procesar e insertar nuevos items y validar disponibilidad dinámica
      const resultadoItems = await procesarYActualizarItemsReserva(
        client,
        req.params.id,
        items,
        total,
        fInicio,
        fFin,
        vigenteNuevo
      );
      itemsFinalesParaCalendario = resultadoItems.itemsProcesados;
    }

    const result = await client.query(
      `UPDATE reservas 
       SET fecha_inicio=$1, fecha_fin=$2, alias_cliente=$3, nombre_cliente=$4, cedula_cliente=$5, email_cliente=$6, 
           telefono_cliente=$7, direccion_entrega=$8, notas=$9, estado=$10, total=COALESCE($11, total),
           cliente_id=COALESCE($12, cliente_id)
       WHERE id=$13 RETURNING *`,
      [
        fInicio,
        fFin,
        alias_cliente !== undefined ? alias_cliente : reservaPrevia.alias_cliente,
        nombre_cliente !== undefined ? nombre_cliente : reservaPrevia.nombre_cliente,
        cedula_cliente !== undefined ? (cedula_cliente ? cedula_cliente.trim() : null) : reservaPrevia.cedula_cliente,
        email_cliente !== undefined ? email_cliente : reservaPrevia.email_cliente,
        telefono_cliente !== undefined ? telefono_cliente : reservaPrevia.telefono_cliente,
        direccion_entrega !== undefined ? direccion_entrega : reservaPrevia.direccion_entrega,
        notas !== undefined ? notas : (reservaPrevia.notas || reservaPrevia.notes),
        nuevoEstado,
        (total !== undefined && total !== null && !isNaN(total)) ? parseFloat(total) : null,
        cliente_id !== undefined ? cliente_id : null,
        req.params.id
      ]
    );
    const reservaActualizada = result.rows[0];

    if (nuevoEstado === 'completada') {
      const fechaFinStr = fFin || (reservaActualizada.fecha_fin ? (typeof reservaActualizada.fecha_fin === 'string' ? reservaActualizada.fecha_fin.substring(0, 10) : reservaActualizada.fecha_fin.toISOString().substring(0, 10)) : null);
      await saldarSaldoPendienteReserva(client, req.params.id, fechaFinStr);
    }

    await client.query('COMMIT');

    // Sincronizar con Google Calendar
    if (nuevoEstado === 'cancelada' && reservaActualizada.google_event_id) {
      googleCalendar.eliminarEventoReserva(reservaActualizada.google_event_id).catch(e => console.error('Error Google Calendar:', e.message));
    } else {
      const fetchItems = itemsFinalesParaCalendario 
        ? Promise.resolve({ rows: itemsFinalesParaCalendario })
        : db.query('SELECT nombre, cantidad, precio_unitario, subtotal FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      
      fetchItems
        .then(rItems => googleCalendar.actualizarEventoReserva(reservaActualizada.google_event_id, reservaActualizada, rItems.rows))
        .catch(e => console.error('Error Google Calendar:', e.message));
    }

    res.json(reservaActualizada);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Editar items de la reserva (solo admin) - Reemplaza los artículos y recalcula total
router.put('/:id/items', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { items, total } = req.body;
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

    // Procesar y actualizar items con disponibilidad dinámica
    const { itemsProcesados, finalTotal } = await procesarYActualizarItemsReserva(
      client,
      reservaId,
      items,
      total,
      reserva.fecha_inicio,
      reserva.fecha_fin,
      esVigente
    );

    await client.query('COMMIT');

    db.query('SELECT * FROM reservas WHERE id = $1', [reservaId])
      .then(resv => {
        if (resv.rows.length) {
          googleCalendar.actualizarEventoReserva(resv.rows[0].google_event_id, resv.rows[0], itemsProcesados).catch(e => console.error('Error Google Calendar:', e.message));
        }
      })
      .catch(e => console.error('Error Google Calendar:', e.message));

    res.json({ ok: true, nuevoTotal: finalTotal });
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

    const reservaRes = await client.query('SELECT estado, google_event_id FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const estadoActual = reservaRes.rows[0].estado;
    const googleEvtId = reservaRes.rows[0].google_event_id;
    const esVigente = ['pendiente', 'confirmada', 'activa'].includes(estadoActual);



    await client.query('DELETE FROM pagos WHERE reserva_id = $1', [req.params.id]);
    await client.query('DELETE FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
    await client.query('DELETE FROM reservas WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');

    if (googleEvtId) {
      googleCalendar.eliminarEventoReserva(googleEvtId).catch(e => console.error('Error Google Calendar:', e.message));
    }

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
