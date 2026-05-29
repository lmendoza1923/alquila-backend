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
        <thead><tr><th>Mueble</th><th>Cant.</th><th>Precio/día</th><th>Subtotal</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <p><strong>Total: $${reserva.total}</strong></p>
      <p>Nos pondremos en contacto para confirmar los detalles de entrega.</p>
    `
  });
}

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
      return res.status(400).json({ error: 'Debe incluir al menos un mueble' });

    // Calcular total
    let total = 0;
    const dias = Math.ceil((new Date(fecha_fin) - new Date(fecha_inicio)) / 86400000) + 1;
    const itemsDetalle = [];

    for (const item of items) {
      const mueble = await client.query('SELECT * FROM muebles WHERE id=$1 AND activo=true', [item.mueble_id]);
      if (!mueble.rows.length) throw new Error(`Mueble ${item.mueble_id} no encontrado`);

      const m = mueble.rows[0];
      // Verificar disponibilidad física directa
      if (m.stock < item.cantidad)
        throw new Error(`Solo hay ${m.stock} unidades disponibles de "${m.nombre}"`);

      let precio = m.precio_dia;
      if (dias >= 30 && m.precio_mes) precio = m.precio_mes / 30;
      else if (dias >= 7 && m.precio_semana) precio = m.precio_semana / 7;

      const subtotal = parseFloat((precio * item.cantidad * dias).toFixed(2));
      total += subtotal;
      itemsDetalle.push({ ...item, nombre: m.nombre, precio_unitario: precio, subtotal });
    }

    const reservaResult = await client.query(
      `INSERT INTO reservas (fecha_inicio, fecha_fin, nombre_cliente, email_cliente, telefono_cliente, direccion_entrega, notas, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [fecha_inicio, fecha_fin, nombre_cliente, email_cliente, telefono_cliente, direccion_entrega, notas, total.toFixed(2)]
    );
    const reserva = reservaResult.rows[0];

    for (const item of itemsDetalle) {
      await client.query(
        'INSERT INTO reserva_items (reserva_id, mueble_id, cantidad, precio_unitario, subtotal) VALUES ($1,$2,$3,$4,$5)',
        [reserva.id, item.mueble_id, item.cantidad, item.precio_unitario, item.subtotal]
      );
      // Decrementar stock físico en la tabla muebles
      await client.query(
        'UPDATE muebles SET stock = stock - $1 WHERE id = $2',
        [item.cantidad, item.mueble_id]
      );
    }

    await client.query('COMMIT');

    // Enviar email (sin bloquear respuesta)
    enviarConfirmacion(reserva, itemsDetalle).catch(console.error);

    res.status(201).json({ reserva, items: itemsDetalle });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Listar reservas (admin ve todas, cliente ve las suyas)
router.get('/', auth, async (req, res) => {
  try {
    let query, params;
    if (req.user.rol === 'admin') {
      query = `SELECT r.*, json_agg(json_build_object('mueble',m.nombre,'cantidad',ri.cantidad,'subtotal',ri.subtotal)) AS items
               FROM reservas r LEFT JOIN reserva_items ri ON ri.reserva_id=r.id LEFT JOIN muebles m ON m.id=ri.mueble_id
               GROUP BY r.id ORDER BY r.creado_en DESC`;
      params = [];
    } else {
      query = `SELECT r.*, json_agg(json_build_object('mueble',m.nombre,'cantidad',ri.cantidad,'subtotal',ri.subtotal)) AS items
               FROM reservas r LEFT JOIN reserva_items ri ON ri.reserva_id=r.id LEFT JOIN muebles m ON m.id=ri.mueble_id
               WHERE r.usuario_id=$1 GROUP BY r.id ORDER BY r.creado_en DESC`;
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

    // Obtener estado anterior de la reserva
    const reservaRes = await client.query('SELECT estado FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    const estadoAnterior = reservaRes.rows[0].estado;

    // Actualizar el estado de la reserva
    const result = await client.query('UPDATE reservas SET estado=$1 WHERE id=$2 RETURNING *', [estado, req.params.id]);
    const reservaActualizada = result.rows[0];

    const vigenteAnterior = ['pendiente', 'confirmada', 'activa'].includes(estadoAnterior);
    const vigenteNuevo = ['pendiente', 'confirmada', 'activa'].includes(estado);

    // Si cambió la vigencia, actualizar stock de muebles
    if (vigenteAnterior !== vigenteNuevo) {
      const itemsRes = await client.query('SELECT mueble_id, cantidad FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      
      for (const item of itemsRes.rows) {
        if (vigenteAnterior && !vigenteNuevo) {
          // De vigente a no-vigente (completada o cancelada) -> devolver al stock
          await client.query('UPDATE muebles SET stock = stock + $1 WHERE id = $2', [item.cantidad, item.mueble_id]);
        } else if (!vigenteAnterior && vigenteNuevo) {
          // De no-vigente a vigente -> restar del stock
          await client.query('UPDATE muebles SET stock = stock - $1 WHERE id = $2', [item.cantidad, item.mueble_id]);
        }
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

    // Obtener estado anterior de la reserva
    const reservaRes = await client.query('SELECT estado FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    const estadoAnterior = reservaRes.rows[0].estado;

    // Actualizar la reserva
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

    // Si cambió la vigencia, actualizar stock de muebles
    if (vigenteAnterior !== vigenteNuevo) {
      const itemsRes = await client.query('SELECT mueble_id, cantidad FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      
      for (const item of itemsRes.rows) {
        if (vigenteAnterior && !vigenteNuevo) {
          // De vigente a no-vigente (completada o cancelada) -> devolver al stock
          await client.query('UPDATE muebles SET stock = stock + $1 WHERE id = $2', [item.cantidad, item.mueble_id]);
        } else if (!vigenteAnterior && vigenteNuevo) {
          // De no-vigente a vigente -> restar del stock
          await client.query('UPDATE muebles SET stock = stock - $1 WHERE id = $2', [item.cantidad, item.mueble_id]);
        }
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

// === AGREGAR ESTE BLOQUE AL FINAL DE backend/routes/reservas.js (antes de module.exports) ===

// Eliminar reserva (solo admin)
router.delete('/:id', admin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Obtener estado actual para saber si hay que devolver stock
    const reservaRes = await client.query('SELECT estado FROM reservas WHERE id = $1', [req.params.id]);
    if (!reservaRes.rows.length) {
      client.release();
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const estadoActual = reservaRes.rows[0].estado;
    const esVigente = ['pendiente', 'confirmada', 'activa'].includes(estadoActual);

    // Si la reserva es vigente, devolver el stock
    if (esVigente) {
      const itemsRes = await client.query('SELECT mueble_id, cantidad FROM reserva_items WHERE reserva_id = $1', [req.params.id]);
      for (const item of itemsRes.rows) {
        await client.query('UPDATE muebles SET stock = stock + $1 WHERE id = $2', [item.cantidad, item.mueble_id]);
      }
    }

    // Eliminar items, pagos y luego la reserva
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
