const router = require('express').Router();
const db = require('../db');
const { admin } = require('../middleware/auth');

// Dashboard stats
router.get('/stats', admin, async (req, res) => {
  try {
    const [reservas, ingresos, muebles, pendientes] = await Promise.all([
      db.query("SELECT COUNT(*) FROM reservas WHERE estado != 'cancelada'"),
      db.query("SELECT COALESCE(SUM(total),0) AS total FROM reservas WHERE estado IN ('confirmada','activa','completada')"),
      db.query('SELECT COUNT(*) FROM muebles WHERE activo=true'),
      db.query("SELECT COUNT(*) FROM reservas WHERE estado='pendiente'")
    ]);

    res.json({
      total_reservas: parseInt(reservas.rows[0].count),
      ingresos_total: parseFloat(ingresos.rows[0].total),
      total_muebles: parseInt(muebles.rows[0].count),
      reservas_pendientes: parseInt(pendientes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reservas recientes
router.get('/reservas-recientes', admin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre_cliente, email_cliente, fecha_inicio, fecha_fin, estado, total, creado_en
       FROM reservas ORDER BY creado_en DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reportes y estadísticas mensuales
router.get('/reportes', admin, async (req, res) => {
  try {
    const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
    const anio = parseInt(req.query.anio) || new Date().getFullYear();

    // Query 1: Total de reservas en el mes filtrado
    const queryReservas = `
      SELECT COUNT(*) AS count 
      FROM reservas 
      WHERE EXTRACT(MONTH FROM creado_en) = $1 
        AND EXTRACT(YEAR FROM creado_en) = $2 
        AND estado != 'cancelada'
    `;

    // Query 2: Total de ingresos (pagos registrados) en el mes filtrado
    const queryIngresos = `
      SELECT COALESCE(SUM(monto), 0) AS total 
      FROM pagos 
      WHERE EXTRACT(MONTH FROM creado_en) = $1 
        AND EXTRACT(YEAR FROM creado_en) = $2
    `;

    // Query 3: Total de artículos (muebles físicos) alquilados en el mes
    // Consideramos tanto alquileres individuales como componentes de combos
    const queryArticulosMuebles = `
      SELECT COALESCE(SUM(ri.cantidad), 0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      WHERE EXTRACT(MONTH FROM r.creado_en) = $1 
        AND EXTRACT(YEAR FROM r.creado_en) = $2 
        AND r.estado != 'cancelada' 
        AND ri.mueble_id IS NOT NULL
    `;

    const queryArticulosCombos = `
      SELECT COALESCE(SUM(ri.cantidad * ci.cantidad), 0) AS total
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      JOIN combo_items ci ON ci.combo_id = ri.combo_id
      WHERE EXTRACT(MONTH FROM r.creado_en) = $1 
        AND EXTRACT(YEAR FROM r.creado_en) = $2 
        AND r.estado != 'cancelada' 
        AND ri.combo_id IS NOT NULL
    `;

    // Query 4: Top de reservas (muebles más alquilados)
    const queryTopMuebles = `
      WITH rentals AS (
        SELECT ri.mueble_id, SUM(ri.cantidad) AS total
        FROM reserva_items ri
        JOIN reservas r ON r.id = ri.reserva_id
        WHERE EXTRACT(MONTH FROM r.creado_en) = $1 
          AND EXTRACT(YEAR FROM r.creado_en) = $2 
          AND r.estado != 'cancelada'
          AND ri.mueble_id IS NOT NULL
        GROUP BY ri.mueble_id

        UNION ALL

        SELECT ci.mueble_id, SUM(ri.cantidad * ci.cantidad) AS total
        FROM reserva_items ri
        JOIN reservas r ON r.id = ri.reserva_id
        JOIN combo_items ci ON ci.combo_id = ri.combo_id
        WHERE EXTRACT(MONTH FROM r.creado_en) = $1 
          AND EXTRACT(YEAR FROM r.creado_en) = $2 
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

    // Query 5: Top de combos
    const queryTopCombos = `
      SELECT c.nombre, COALESCE(SUM(ri.cantidad), 0) AS total_alquilado
      FROM reserva_items ri
      JOIN reservas r ON r.id = ri.reserva_id
      JOIN combos c ON c.id = ri.combo_id
      WHERE EXTRACT(MONTH FROM r.creado_en) = $1 
        AND EXTRACT(YEAR FROM r.creado_en) = $2 
        AND r.estado != 'cancelada'
        AND ri.combo_id IS NOT NULL
      GROUP BY c.id, c.nombre
      ORDER BY total_alquilado DESC
      LIMIT 5
    `;

    // Query 6: Ganancias diarias del mes filtrado (para la gráfica de ganancias del mes)
    const queryGananciasDiarias = `
      SELECT EXTRACT(DAY FROM creado_en)::INTEGER AS dia, COALESCE(SUM(monto), 0) AS total
      FROM pagos
      WHERE EXTRACT(MONTH FROM creado_en) = $1 
        AND EXTRACT(YEAR FROM creado_en) = $2
      GROUP BY dia
      ORDER BY dia
    `;

    // Query 7: Ganancias generales de todos los meses (para la gráfica general)
    const queryGananciasMensualesGenerales = `
      SELECT 
        EXTRACT(YEAR FROM creado_en)::INTEGER AS anio, 
        EXTRACT(MONTH FROM creado_en)::INTEGER AS mes, 
        COALESCE(SUM(monto), 0) AS total
      FROM pagos
      GROUP BY anio, mes
      ORDER BY anio, mes
    `;

    const [
      resReservas,
      resIngresos,
      resArtMuebles,
      resArtCombos,
      resTopMuebles,
      resTopCombos,
      resGananciasDiarias,
      resGananciasMensuales
    ] = await Promise.all([
      db.query(queryReservas, [mes, anio]),
      db.query(queryIngresos, [mes, anio]),
      db.query(queryArticulosMuebles, [mes, anio]),
      db.query(queryArticulosCombos, [mes, anio]),
      db.query(queryTopMuebles, [mes, anio]),
      db.query(queryTopCombos, [mes, anio]),
      db.query(queryGananciasDiarias, [mes, anio]),
      db.query(queryGananciasMensualesGenerales)
    ]);

    const totalReservas = parseInt(resReservas.rows[0].count);
    const totalIngresos = parseFloat(resIngresos.rows[0].total);
    const totalArticulos = parseInt(resArtMuebles.rows[0].total) + parseInt(resArtCombos.rows[0].total);
    
    res.json({
      total_reservas: totalReservas,
      total_ingresos: totalIngresos,
      total_articulos: totalArticulos,
      top_muebles: resTopMuebles.rows.map(r => ({ nombre: r.nombre, total: parseInt(r.total_alquilado) })),
      top_combos: resTopCombos.rows.map(r => ({ nombre: r.nombre, total: parseInt(r.total_alquilado) })),
      ganancias_diarias: resGananciasDiarias.rows.map(r => ({ dia: r.dia, total: parseFloat(r.total) })),
      ganancias_mensuales_generales: resGananciasMensuales.rows.map(r => ({ anio: r.anio, mes: r.mes, total: parseFloat(r.total) }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
