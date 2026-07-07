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
      db.query("SELECT COALESCE(SUM(total),0) AS total FROM reservas WHERE estado IN ('confirmada','activa','completada')"),
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

    // Query 1: Total de reservas en el rango de fechas
    const queryReservas = `
      SELECT COUNT(*) AS count 
      FROM reservas 
      WHERE creado_en >= $1::date AND creado_en < $2::date + 1 
        AND estado != 'cancelada'
    `;

    // Query 2: Total de ingresos (pagos registrados) en el rango de fechas
    const queryIngresos = `
      SELECT COALESCE(SUM(monto), 0) AS total 
      FROM pagos 
      WHERE creado_en >= $1::date AND creado_en < $2::date + 1
    `;

    // Query 3: Total de artículos (muebles físicos) alquilados en el rango de fechas
    // Consideramos tanto alquileres individuales como componentes de combos
    const queryArticulosMuebles = `
      SELECT COALESCE(SUM(ri.cantidad), 0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      WHERE r.creado_en >= $1::date AND r.creado_en < $2::date + 1 
        AND r.estado != 'cancelada' 
        AND ri.mueble_id IS NOT NULL
    `;

    const queryArticulosCombos = `
      SELECT COALESCE(SUM(ri.cantidad * ci.cantidad), 0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      JOIN combo_items ci ON ci.combo_id = ri.combo_id
      WHERE r.creado_en >= $1::date AND r.creado_en < $2::date + 1 
        AND r.estado != 'cancelada' 
        AND ri.combo_id IS NOT NULL
    `;

    // Query 4: Top de reservas (muebles más alquilados) en el rango de fechas
    const queryTopMuebles = `
      WITH rentals AS (
        SELECT ri.mueble_id, SUM(ri.cantidad) AS total
        FROM reserva_items ri
        JOIN reservas r ON r.id = ri.reserva_id
        WHERE r.creado_en >= $1::date AND r.creado_en < $2::date + 1 
          AND r.estado != 'cancelada'
          AND ri.mueble_id IS NOT NULL
        GROUP BY ri.mueble_id

        UNION ALL

        SELECT ci.mueble_id, SUM(ri.cantidad * ci.cantidad) AS total
        FROM reserva_items ri
        JOIN reservas r ON r.id = ri.reserva_id
        JOIN combo_items ci ON ci.combo_id = ri.combo_id
        WHERE r.creado_en >= $1::date AND r.creado_en < $2::date + 1 
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
      WHERE r.creado_en >= $1::date AND r.creado_en < $2::date + 1 
        AND r.estado != 'cancelada'
        AND ri.combo_id IS NOT NULL
      GROUP BY c.id, c.nombre
      ORDER BY total_alquilado DESC
      LIMIT 5
    `;

    // Query 6: Ganancias diarias agrupadas por fecha exacta YYYY-MM-DD
    const queryGananciasDiarias = `
      SELECT TO_CHAR(creado_en, 'YYYY-MM-DD') AS fecha, COALESCE(SUM(monto), 0) AS total
      FROM pagos
      WHERE creado_en >= $1::date AND creado_en < $2::date + 1
      GROUP BY TO_CHAR(creado_en, 'YYYY-MM-DD')
      ORDER BY fecha
    `;

    // Query 7: Ganancias generales de todos los meses (para la gráfica histórica)
    const queryGananciasMensualesGenerales = `
      SELECT 
        EXTRACT(YEAR FROM creado_en)::INTEGER AS anio, 
        EXTRACT(MONTH FROM creado_en)::INTEGER AS mes, 
        COALESCE(SUM(monto), 0) AS total
      FROM pagos
      GROUP BY anio, mes
      ORDER BY anio, mes
    `;

    // Query 8: Desglose de ingresos por categoría
    const queryDesglose = `
      SELECT 
        COALESCE(SUM(CASE WHEN ri.mueble_id IS NOT NULL OR ri.combo_id IS NOT NULL THEN ri.subtotal ELSE 0 END), 0) AS mobiliario,
        COALESCE(SUM(CASE WHEN ri.mueble_id IS NULL AND ri.combo_id IS NULL AND (ri.nombre ILIKE '%transporte%' OR ri.nombre ILIKE '%flete%' OR ri.nombre ILIKE '%envio%' OR ri.nombre ILIKE '%envío%') THEN ri.subtotal ELSE 0 END), 0) AS transporte,
        COALESCE(SUM(CASE WHEN ri.mueble_id IS NULL AND ri.combo_id IS NULL AND ri.nombre ILIKE '%decorac%' THEN ri.subtotal ELSE 0 END), 0) AS decoracion,
        COALESCE(SUM(CASE WHEN ri.mueble_id IS NULL AND ri.combo_id IS NULL AND NOT (ri.nombre ILIKE '%transporte%' OR ri.nombre ILIKE '%flete%' OR ri.nombre ILIKE '%envio%' OR ri.nombre ILIKE '%envío%' OR ri.nombre ILIKE '%decorac%') THEN ri.subtotal ELSE 0 END), 0) AS otros
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      WHERE r.creado_en >= $1::date AND r.creado_en < $2::date + 1
        AND r.estado != 'cancelada'
    `;

    const [
      resReservas,
      resIngresos,
      resArtMuebles,
      resArtCombos,
      resTopMuebles,
      resTopCombos,
      resGananciasDiarias,
      resGananciasMensuales,
      resDesglose
    ] = await Promise.all([
      db.query(queryReservas, [fechaInicio, fechaFin]),
      db.query(queryIngresos, [fechaInicio, fechaFin]),
      db.query(queryArticulosMuebles, [fechaInicio, fechaFin]),
      db.query(queryArticulosCombos, [fechaInicio, fechaFin]),
      db.query(queryTopMuebles, [fechaInicio, fechaFin]),
      db.query(queryTopCombos, [fechaInicio, fechaFin]),
      db.query(queryGananciasDiarias, [fechaInicio, fechaFin]),
      db.query(queryGananciasMensualesGenerales),
      db.query(queryDesglose, [fechaInicio, fechaFin])
    ]);

    const totalReservas = parseInt(resReservas.rows[0].count);
    const totalIngresos = parseFloat(resIngresos.rows[0].total);
    const totalArticulos = parseInt(resArtMuebles.rows[0].total) + parseInt(resArtCombos.rows[0].total);

    const rowDesglose = resDesglose.rows[0];
    const ingresoMobiliario = parseFloat(rowDesglose.mobiliario || 0);
    const ingresoTransporte = parseFloat(rowDesglose.transporte || 0);
    const ingresoDecoracion = parseFloat(rowDesglose.decoracion || 0);
    const ingresoOtros = parseFloat(rowDesglose.otros || 0);
    const totalReservado = ingresoMobiliario + ingresoTransporte + ingresoDecoracion + ingresoOtros;
    
    res.json({
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      total_reservas: totalReservas,
      total_ingresos: totalIngresos,
      total_articulos: totalArticulos,
      top_muebles: resTopMuebles.rows.map(r => ({ nombre: r.nombre, total: parseInt(r.total_alquilado) })),
      top_combos: resTopCombos.rows.map(r => ({ nombre: r.nombre, total: parseInt(r.total_alquilado) })),
      ganancias_diarias: resGananciasDiarias.rows.map(r => ({ fecha: r.fecha, total: parseFloat(r.total) })),
      ganancias_mensuales_generales: resGananciasMensuales.rows.map(r => ({ anio: r.anio, mes: r.mes, total: parseFloat(r.total) })),
      desglose: {
        total_reservado: totalReservado,
        mobiliario: ingresoMobiliario,
        transporte: ingresoTransporte,
        decoracion: ingresoDecoracion,
        otros: ingresoOtros
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
