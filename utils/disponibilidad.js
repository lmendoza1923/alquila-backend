const db = require('../db');

/**
 * Retorna un mapa { [mueble_id]: cantidad_comprometida } para el rango [fechaInicio, fechaFin].
 * Se consideran reservas en estado 'pendiente', 'confirmada' o 'activa'.
 * Si excludeReservaId está presente, esa reserva se ignora (útil para edición).
 */
async function obtenerStockComprometido(client, fechaInicio, fechaFin, excludeReservaId = null) {
  const query = `
    WITH reservas_rango AS (
      SELECT id
      FROM reservas
      WHERE estado IN ('pendiente', 'confirmada', 'activa')
        AND fecha_inicio <= $2
        AND fecha_fin >= $1
        AND ($3::uuid IS NULL OR id != $3::uuid)
    ),
    directos AS (
      SELECT ri.mueble_id, SUM(ri.cantidad) AS cantidad
      FROM reserva_items ri
      JOIN reservas_rango rr ON rr.id = ri.reserva_id
      WHERE ri.mueble_id IS NOT NULL
      GROUP BY ri.mueble_id
    ),
    en_combos AS (
      SELECT rci.mueble_id, SUM(rci.cantidad * COALESCE(ri.cantidad, 1)) AS cantidad
      FROM reserva_combo_items rci
      JOIN reservas_rango rr ON rr.id = rci.reserva_id
      LEFT JOIN reserva_items ri ON ri.reserva_id = rci.reserva_id AND ri.combo_id = rci.combo_id
      WHERE rci.mueble_id IS NOT NULL
      GROUP BY rci.mueble_id
    )
    SELECT mueble_id, SUM(cantidad)::int AS total_ocupado
    FROM (
      SELECT mueble_id, cantidad FROM directos
      UNION ALL
      SELECT mueble_id, cantidad FROM en_combos
    ) c
    GROUP BY mueble_id
  `;

  const runner = client || db;
  const res = await runner.query(query, [fechaInicio, fechaFin, excludeReservaId]);
  const mapa = {};
  for (const row of res.rows) {
    mapa[row.mueble_id] = parseInt(row.total_ocupado) || 0;
  }
  return mapa;
}

/**
 * Valida si una lista de items (muebles o combos con componentes) puede ser reservada
 * en el rango [fechaInicio, fechaFin] sin superar el stock total de bodega.
 */
async function validarDisponibilidadItems(client, items, fechaInicio, fechaFin, excludeReservaId = null) {
  if (!items || !items.length) return;

  const runner = client || db;
  const mapaComprometido = await obtenerStockComprometido(runner, fechaInicio, fechaFin, excludeReservaId);

  // Acumular cantidades totales requeridas por mueble_id
  const requeridos = {}; // { [mueble_id]: { cantidad: number, nombre: string, combos: string[] } }

  for (const item of items) {
    if (item.combo_id) {
      const comboRes = await runner.query('SELECT id, nombre FROM combos WHERE id = $1', [item.combo_id]);
      const comboNombre = comboRes.rows[0]?.nombre || 'Combo';

      let componentes = [];
      if (item.componentes && item.componentes.length > 0) {
        componentes = item.componentes;
      } else {
        const stdComps = await runner.query(
          'SELECT ci.mueble_id, ci.cantidad, m.nombre FROM combo_items ci JOIN muebles m ON m.id = ci.mueble_id WHERE ci.combo_id = $1',
          [item.combo_id]
        );
        componentes = stdComps.rows;
      }

      const cantCombo = parseInt(item.cantidad) || 1;
      for (const comp of componentes) {
        if (!comp.mueble_id) continue;
        const cantComp = (parseInt(comp.cantidad) || 1) * cantCombo;
        if (!requeridos[comp.mueble_id]) {
          requeridos[comp.mueble_id] = { cantidad: 0, nombre: comp.nombre || null, contextos: [] };
        }
        requeridos[comp.mueble_id].cantidad += cantComp;
        requeridos[comp.mueble_id].contextos.push(`${comboNombre} (${cantComp} uds)`);
      }
    } else if (item.mueble_id) {
      const cant = parseInt(item.cantidad) || 1;
      if (!requeridos[item.mueble_id]) {
        requeridos[item.mueble_id] = { cantidad: 0, nombre: item.nombre || null, contextos: [] };
      }
      requeridos[item.mueble_id].cantidad += cant;
      requeridos[item.mueble_id].contextos.push(`Individual (${cant} uds)`);
    }
  }

  // Validar cada mueble requerido contra stock físico base y comprometido
  const muebleIds = Object.keys(requeridos);
  if (!muebleIds.length) return;

  const mueblesDb = await runner.query('SELECT id, nombre, stock FROM muebles WHERE id = ANY($1)', [muebleIds]);
  const muebleInfoMap = {};
  for (const m of mueblesDb.rows) {
    muebleInfoMap[m.id] = m;
  }

  for (const muebleId of muebleIds) {
    const m = muebleInfoMap[muebleId];
    if (!m) {
      throw new Error(`Mueble con ID ${muebleId} no encontrado en el catálogo.`);
    }

    const stockTotal = parseInt(m.stock) || 0;
    const yaComprometido = mapaComprometido[muebleId] || 0;
    const disponible = Math.max(0, stockTotal - yaComprometido);
    const solicitado = requeridos[muebleId].cantidad;

    if (solicitado > disponible) {
      const contextoMsg = requeridos[muebleId].contextos.length > 1
        ? ` (requerido por: ${requeridos[muebleId].contextos.join(', ')})`
        : '';
      throw new Error(
        `Stock insuficiente de "${m.nombre}" para las fechas ${fechaInicio} al ${fechaFin}${contextoMsg}. Disponibles: ${disponible} (Total en bodega: ${stockTotal}, ya reservadas: ${yaComprometido}), Solicitadas: ${solicitado}.`
      );
    }
  }
}

module.exports = {
  obtenerStockComprometido,
  validarDisponibilidadItems
};
