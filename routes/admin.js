const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');
const reservasRouter = require('./reservas');

// Dashboard stats
router.get('/stats', admin, async (req, res) => {
  try {
    await reservasRouter.autoCompletarReservasExpiradas();
    const [reservas, ingresos, muebles, pendientes, combos] = await Promise.all([
      db.query("SELECT COUNT(*) FROM reservas WHERE estado != 'cancelada'"),
      db.query("SELECT COALESCE(SUM(monto),0) AS total FROM pagos"),
      db.query('SELECT COUNT(*) FROM muebles WHERE activo=true'),
      db.query("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'"),
      db.query('SELECT COUNT(*) FROM combos WHERE activo=true')
    ]);

    res.json({
      total_reservas: parseInt(reservas.rows[0].count),
      ingresos_total: parseFloat(ingresos.rows[0].total),
      total_muebles: parseInt(muebles.rows[0].count),
      reservas_pendientes: parseInt(pendientes.rows[0].count),
      total_combos: parseInt(combos.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reservas recientes
router.get('/reservas-recientes', admin, async (req, res) => {
  try {
    await reservasRouter.autoCompletarReservasExpiradas();
    const result = await db.query(
      `SELECT id, alias_cliente, nombre_cliente, email_cliente, fecha_inicio, fecha_fin, estado, total, creado_en
       FROM reservas ORDER BY creado_en DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reportes y estadísticas mensuales/personalizados
router.get('/reportes', admin, async (req, res) => {
  try {
    await reservasRouter.autoCompletarReservasExpiradas();
    
    const tipo = req.query.tipo || 'mes';
    let fechaInicio, fechaFin;

    if (tipo === 'personalizado') {
      fechaInicio = req.query.fechaInicio;
      fechaFin = req.query.fechaFin;
      if (!fechaInicio || !fechaFin) {
        return res.status(400).json({ error: 'Faltan parámetros de fechaInicio o fechaFin' });
      }
    } else {
      const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
      const anio = parseInt(req.query.anio) || new Date().getFullYear();
      const mesStr = String(mes).padStart(2, '0');
      fechaInicio = `${anio}-${mesStr}-01`;
      const ultimoDia = new Date(anio, mes, 0).getDate();
      fechaFin = `${anio}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;
    }
    // Query 1: Total de reservas en el rango de fechas (por fecha de inicio/evento)
    const queryReservas = `
      SELECT COUNT(*) AS count 
      FROM reservas 
      WHERE fecha_inicio >= $1::date AND fecha_inicio < $2::date + 1 
        AND estado != 'cancelada'
    `;

    // Query 3: Total de artículos (muebles físicos) alquilados en el rango de fechas
    const queryArticulosMuebles = `
      SELECT COALESCE(SUM(ri.cantidad), 0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      WHERE r.fecha_inicio >= $1::date AND r.fecha_inicio < $2::date + 1 
        AND r.estado != 'cancelada' 
        AND ri.mueble_id IS NOT NULL
    `;

    const queryArticulosCombos = `
      SELECT COALESCE(SUM(ri.cantidad * ci.cantidad), 0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      JOIN combo_items ci ON ci.combo_id = ri.combo_id
      WHERE r.fecha_inicio >= $1::date AND r.fecha_inicio < $2::date + 1 
        AND r.estado != 'cancelada' 
        AND ri.combo_id IS NOT NULL
    `;

    // Query 4: Top de reservas (muebles más alquilados) en el rango de fechas
    const queryTopMuebles = `
      WITH rentals AS (
        SELECT ri.mueble_id, SUM(ri.cantidad) AS total
        FROM reserva_items ri
        JOIN reservas r ON r.id = ri.reserva_id
        WHERE r.fecha_inicio >= $1::date AND r.fecha_inicio < $2::date + 1 
          AND r.estado != 'cancelada'
          AND ri.mueble_id IS NOT NULL
        GROUP BY ri.mueble_id

        UNION ALL

        SELECT ci.mueble_id, SUM(ri.cantidad * ci.cantidad) AS total
        FROM reserva_items ri
        JOIN reservas r ON r.id = ri.reserva_id
        JOIN combo_items ci ON ci.combo_id = ri.combo_id
        WHERE r.fecha_inicio >= $1::date AND r.fecha_inicio < $2::date + 1 
          AND r.estado != 'cancelada'
          AND ri.combo_id IS NOT NULL
        GROUP BY ci.mueble_id
      )
      SELECT m.nombre, COALESCE(SUM(r.total), 0) AS total_alquilado
      FROM rentals r
      JOIN muebles m ON m.id = r.mueble_id
      GROUP BY m.id, m.nombre
      ORDER BY total_alquilado DESC
      LIMIT 5
    `;

    // Query 5: Top de combos en el rango de fechas
    const queryTopCombos = `
      SELECT c.nombre, COALESCE(SUM(ri.cantidad), 0) AS total_alquilado
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      JOIN combos c ON c.id = ri.combo_id
      WHERE r.fecha_inicio >= $1::date AND r.fecha_inicio < $2::date + 1 
        AND r.estado != 'cancelada'
        AND ri.combo_id IS NOT NULL
      GROUP BY c.id, c.nombre
      ORDER BY total_alquilado DESC
      LIMIT 5
    `;

    // Query 6: Ganancias diarias agrupadas por fecha de evento
    const queryGananciasDiarias = `
      SELECT TO_CHAR(r.fecha_inicio, 'YYYY-MM-DD') AS fecha, COALESCE(SUM(p.monto), 0) AS total
      FROM pagos p
      JOIN reservas r ON r.id = p.reserva_id
      WHERE r.fecha_inicio >= $1::date AND r.fecha_inicio < $2::date + 1
        AND r.estado != 'cancelada'
      GROUP BY TO_CHAR(r.fecha_inicio, 'YYYY-MM-DD')
      ORDER BY fecha
    `;

    // Query 7: Ganancias generales de todos los meses (para la gráfica histórica por fecha de evento)
    const queryGananciasMensualesGenerales = `
      SELECT 
        EXTRACT(YEAR FROM r.fecha_inicio)::INTEGER AS anio, 
        EXTRACT(MONTH FROM r.fecha_inicio)::INTEGER AS mes, 
        COALESCE(SUM(p.monto), 0) AS total
      FROM pagos p
      JOIN reservas r ON r.id = p.reserva_id
      WHERE r.estado != 'cancelada'
      GROUP BY anio, mes
      ORDER BY anio, mes
    `;

    // Función para calcular ingresos y desglose por categoría de las reservas del período:
    // Regla: Los abonos se cargan a mobiliario (no se reparten a transporte ni decoración).
    // Solo cuando se cancela el saldo completo de la reserva, se distribuyen los ingresos
    // a donde corresponde (transporte, decoración, otros y el resto a mobiliario).
    async function calcularIngresosYDesglose(fInicio, fFin) {
      const reservasPeriodoRes = await db.query(
        `SELECT id, total FROM reservas 
         WHERE fecha_inicio >= $1::date AND fecha_inicio < $2::date + 1 
           AND estado != 'cancelada'`,
        [fInicio, fFin]
      );

      const reservaIds = reservasPeriodoRes.rows.map(r => r.id);
      let totalIngresos = 0;
      let totalBrutoReservas = 0;
      let desgloseRecibido = { total_recibido: 0, total_reservado: 0, mobiliario: 0, transporte: 0, decoracion: 0, otros: 0 };
      let desgloseBruto = { total_bruto: 0, mobiliario: 0, transporte: 0, decoracion: 0, otros: 0 };

      if (reservaIds.length === 0) {
        return {
          totalIngresos: 0,
          totalBrutoReservas: 0,
          saldoPendiente: 0,
          porcentajeRecaudado: 0,
          desglose: desgloseRecibido,
          desgloseRecibido,
          desgloseBruto
        };
      }

      const [itemsRes, pagosRes] = await Promise.all([
        db.query('SELECT reserva_id, mueble_id, combo_id, nombre, subtotal FROM reserva_items WHERE reserva_id = ANY($1)', [reservaIds]),
        db.query('SELECT id, reserva_id, monto FROM pagos WHERE reserva_id = ANY($1)', [reservaIds])
      ]);

      const itemsPorReserva = {};
      for (const item of itemsRes.rows) {
        if (!itemsPorReserva[item.reserva_id]) {
          itemsPorReserva[item.reserva_id] = { mobiliario: 0, transporte: 0, decoracion: 0, otros: 0 };
        }
        const subtotal = parseFloat(item.subtotal || 0);
        const nombre = (item.nombre || '').toLowerCase();
        if (item.mueble_id !== null || item.combo_id !== null) {
          itemsPorReserva[item.reserva_id].mobiliario += subtotal;
        } else if (nombre.includes('transporte') || nombre.includes('flete') || nombre.includes('envio') || nombre.includes('envío')) {
          itemsPorReserva[item.reserva_id].transporte += subtotal;
        } else if (nombre.includes('decorac')) {
          itemsPorReserva[item.reserva_id].decoracion += subtotal;
        } else {
          itemsPorReserva[item.reserva_id].otros += subtotal;
        }
      }

      const pagosPorReserva = {};
      for (const p of pagosRes.rows) {
        if (!pagosPorReserva[p.reserva_id]) pagosPorReserva[p.reserva_id] = [];
        pagosPorReserva[p.reserva_id].push(parseFloat(p.monto || 0));
      }

      for (const r of reservasPeriodoRes.rows) {
        const totalReserva = parseFloat(r.total || 0);
        totalBrutoReservas += totalReserva;

        const items = itemsPorReserva[r.id] || { mobiliario: totalReserva, transporte: 0, decoracion: 0, otros: 0 };

        // Acumular al desglose bruto pactado en reservas
        desgloseBruto.mobiliario += items.mobiliario;
        desgloseBruto.transporte += items.transporte;
        desgloseBruto.decoracion += items.decoracion;
        desgloseBruto.otros += items.otros;

        const pagos = pagosPorReserva[r.id] || [];
        const pagadoEnReserva = pagos.reduce((s, m) => s + m, 0);
        totalIngresos += pagadoEnReserva;

        const saldoCancelado = (pagadoEnReserva >= totalReserva - 0.001);

        if (!saldoCancelado) {
          // Es un abono: se carga íntegramente a mobiliario (nada a transporte ni decoración)
          desgloseRecibido.mobiliario += pagadoEnReserva;
        } else {
          // Se cancela el saldo: se distribuye donde corresponde
          desgloseRecibido.transporte += items.transporte;
          desgloseRecibido.decoracion += items.decoracion;
          desgloseRecibido.otros += items.otros;
          desgloseRecibido.mobiliario += Math.max(0, pagadoEnReserva - items.transporte - items.decoracion - items.otros);
        }
      }

      desgloseBruto.total_bruto = totalBrutoReservas;
      desgloseRecibido.total_recibido = desgloseRecibido.mobiliario + desgloseRecibido.transporte + desgloseRecibido.decoracion + desgloseRecibido.otros;
      desgloseRecibido.total_reservado = desgloseRecibido.total_recibido;

      const saldoPendiente = Math.max(0, totalBrutoReservas - totalIngresos);
      const porcentajeRecaudado = totalBrutoReservas > 0 ? (totalIngresos / totalBrutoReservas) * 100 : 0;

      return {
        totalIngresos,
        totalBrutoReservas,
        saldoPendiente,
        porcentajeRecaudado,
        desglose: desgloseRecibido,
        desgloseRecibido,
        desgloseBruto
      };
    }

    const [
      resReservas,
      resArtMuebles,
      resArtCombos,
      resTopMuebles,
      resTopCombos,
      resGananciasDiarias,
      resGananciasMensuales,
      resCalculo
    ] = await Promise.all([
      db.query(queryReservas, [fechaInicio, fechaFin]),
      db.query(queryArticulosMuebles, [fechaInicio, fechaFin]),
      db.query(queryArticulosCombos, [fechaInicio, fechaFin]),
      db.query(queryTopMuebles, [fechaInicio, fechaFin]),
      db.query(queryTopCombos, [fechaInicio, fechaFin]),
      db.query(queryGananciasDiarias, [fechaInicio, fechaFin]),
      db.query(queryGananciasMensualesGenerales),
      calcularIngresosYDesglose(fechaInicio, fechaFin)
    ]);

    const totalReservas = parseInt(resReservas.rows[0].count);
    const totalIngresos = resCalculo.totalIngresos;
    const totalBrutoReservas = resCalculo.totalBrutoReservas;
    const saldoPendiente = resCalculo.saldoPendiente;
    const porcentajeRecaudado = resCalculo.porcentajeRecaudado;
    const totalArticulos = parseInt(resArtMuebles.rows[0].total) + parseInt(resArtCombos.rows[0].total);
    const desglose = resCalculo.desglose;
    const desgloseBruto = resCalculo.desgloseBruto;
    const desgloseRecibido = resCalculo.desgloseRecibido;
    
    res.json({
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      total_reservas: totalReservas,
      total_bruto_reservas: totalBrutoReservas,
      total_ingresos: totalIngresos,
      saldo_pendiente: saldoPendiente,
      porcentaje_recaudado: porcentajeRecaudado,
      total_articulos: totalArticulos,
      top_muebles: resTopMuebles.rows.map(r => ({ nombre: r.nombre, total: parseInt(r.total_alquilado) })),
      top_combos: resTopCombos.rows.map(r => ({ nombre: r.nombre, total: parseInt(r.total_alquilado) })),
      ganancias_diarias: resGananciasDiarias.rows.map(r => ({ fecha: r.fecha, total: parseFloat(r.total) })),
      ganancias_mensuales_generales: resGananciasMensuales.rows.map(r => ({ anio: r.anio, mes: r.mes, total: parseFloat(r.total) })),
      desglose: desglose,
      desglose_recibido: desgloseRecibido,
      desglose_bruto: desgloseBruto
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
