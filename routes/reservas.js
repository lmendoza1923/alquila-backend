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
      // Verificar disponibilidad
      const ocupado = await client.query(`
        SELECT COALESCE(SUM(ri.cantidad),0) AS total
        FROM reserva_items ri JOIN reservas r ON r.id=ri.reserva_id
        WHERE ri.mueble_id=$1 AND r.estado NOT IN ('cancelada')
          AND NOT (r.fecha_fin < $2 OR r.fecha_inicio > $3)
      `, [item.mueble_id, fecha_inicio, fecha_fin]);

      const disponible = m.stock - parseInt(ocupado.rows[0].total);
      if (disponible < item.cantidad)
        throw new Error(`Solo hay ${disponible} unidades disponibles de "${m.nombre}"`);

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
  try {
    const { estado } = req.body;
    const estados = ['pendiente','confirmada','activa','completada','cancelada'];
    if (!estados.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const result = await db.query('UPDATE reservas SET estado=$1 WHERE id=$2 RETURNING *', [estado, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
