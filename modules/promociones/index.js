'use strict';

/* `promocion_consumir`, traída al código.
 *
 * Original: migración 0113. Gasta un uso de una promoción y dice si pudo.
 *
 * ── Por qué es UNA sentencia y no dos ────────────────────────────────────
 *
 * La tentación es leer `usos` y `limite_usos`, comparar en JavaScript y luego
 * actualizar. Con dos personas usando el último cupón a la vez, las dos leen
 * «queda uno», las dos actualizan, y la promoción se usa de más. El original
 * ya lo evitaba metiendo la condición en el WHERE, y aquí igual: un solo
 * UPDATE, y el número de filas tocadas es la respuesta.
 *
 * `affectedRows` es cuántas filas casaron con el WHERE. Cero significa que no
 * encajó, y con este WHERE eso sólo puede ser una cosa: el límite ya estaba
 * lleno (o la promoción no existe).
 *
 * ── El detalle de mysql2 que puede morder ────────────────────────────────
 *
 * `affectedRows` cuenta las filas que CASARON, no las que cambiaron de valor
 * —eso es `changedRows`—. Aquí da igual porque `usos = usos + 1` siempre
 * cambia algo, pero conviene saberlo: en un UPDATE que escribe el mismo valor
 * que ya había, `changedRows` sería 0 y parecería que no encajó.
 */

const { bd } = require('../../core/db/mysql.js');

async function consumir(promocionId) {
  const r = await bd('datos').consultar(
    `UPDATE promociones
        SET usos = usos + 1
      WHERE id = ?
        AND (limite_usos IS NULL OR usos < limite_usos)`,
    [promocionId]);
  return r.affectedRows > 0;
}

module.exports = { consumir };
