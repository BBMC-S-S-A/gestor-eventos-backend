'use strict';

/* Las tres funciones de reserva de espacios, traídas al código.
 *
 * Original: `retener_espacio`, `liberar_espacio` y `confirmar_espacio` de
 * Postgres (migración 0092). Un «espacio» es un stand, una mesa o una silla
 * que se vende por separado, y las tres funciones son los tres momentos de su
 * compra: lo aparto, lo suelto, lo pago.
 *
 * ── Lo que NO se pierde al portarlas ─────────────────────────────────────
 *
 * La unicidad. En Postgres hay un índice único parcial —`espacio_reservas_una_viva`,
 * UNIQUE (espacio_id) WHERE estado IN ('retenido','vendido')— que es lo que
 * impide vender dos veces la misma silla. MySQL no tiene índices parciales,
 * pero el volcado lo reproduce con una columna generada:
 *
 *     espacio_activo = IF(estado IN ('retenido','vendido'), espacio_id, NULL)
 *     UNIQUE (espacio_activo)
 *
 * O sea que la carrera la sigue cortando LA BASE, no JavaScript. Dos personas
 * pidiendo la misma silla en el mismo instante: una entra y la otra se lleva
 * un `ER_DUP_ENTRY`, igual que en Postgres se llevaba un `unique_violation`.
 * Eso es lo que aquí se traduce a `ESPACIO_OCUPADO`.
 *
 * Comprobarlo en JavaScript —leer si está libre y luego insertar— sería el
 * fallo clásico: los dos leen «libre», los dos insertan, y la silla se vende
 * dos veces. Por eso no se comprueba: se intenta y se mira el error.
 *
 * ── Los errores son los mismos nombres ───────────────────────────────────
 *
 * `ESPACIO_NO_EXISTE`, `ESPACIO_NO_VENDIBLE`, `ESPACIO_DE_OTRO_EVENTO` y
 * `ESPACIO_OCUPADO`. Las rutas los miran por el texto, así que cambiarlos
 * rompería el mensaje que ve quien compra sin que ninguna prueba se enterara.
 */

const crypto = require('node:crypto');
const { bd } = require('../../core/db/mysql.js');

/* Los minutos que dura una retención, con los topes del original
   (`greatest(1, least(p_minutos, 30))`). Diez por defecto. */
function minutosValidos(minutos) {
  const n = Number.isFinite(Number(minutos)) ? Math.trunc(Number(minutos)) : 10;
  return Math.max(1, Math.min(n, 30));
}

/* ── Retener ─────────────────────────────────────────────────────────────
 *
 * Aparta un espacio para una sesión de compra. Devuelve la reserva creada.
 */
async function retener(espacioId, eventoId, sesion, minutos = 10) {
  const mins = minutosValidos(minutos);

  return bd('datos').transaccion(async (tx) => {
    const esp = await tx.unaFila(
      'SELECT modo, evento_id FROM espacios WHERE id = ?', [espacioId]);

    if (!esp)                      throw new Error('ESPACIO_NO_EXISTE');
    if (esp.modo !== 'vendible')   throw new Error('ESPACIO_NO_VENDIBLE');
    if (esp.evento_id !== eventoId) throw new Error('ESPACIO_DE_OTRO_EVENTO');

    /* Esto va aquí y no sólo en un cron, igual que en el original: si el cron
       falla, las sillas se siguen liberando cuando alguien intenta tomarlas.
       Sin esta línea, una retención caducada bloquearía el espacio para
       siempre y nadie entendería por qué. */
    await tx.consultar(
      `UPDATE espacio_reservas SET estado = 'liberado', updated_at = NOW(6)
        WHERE espacio_id = ? AND estado = 'retenido' AND expira_at < NOW(6)`,
      [espacioId]);

    /* El `id` se genera aquí: el volcado de MySQL no pone DEFAULT en las
       columnas `id` (ver db/EL-RESTO-DE-LAS-RUTAS.md §7). */
    const id = crypto.randomUUID();
    try {
      await tx.consultar(
        `INSERT INTO espacio_reservas (id, espacio_id, evento_id, estado, sesion_compra, expira_at)
         VALUES (?, ?, ?, 'retenido', ?, NOW(6) + INTERVAL ? MINUTE)`,
        [id, espacioId, eventoId, sesion, mins]);
    } catch (e) {
      /* El índice único sobre la columna generada es quien decide. */
      if (e.code === 'ER_DUP_ENTRY') throw new Error('ESPACIO_OCUPADO');
      throw e;
    }

    return tx.unaFila('SELECT * FROM espacio_reservas WHERE id = ?', [id]);
  });
}

/* ── Liberar ─────────────────────────────────────────────────────────────
 *
 * Suelta lo que esta sesión tenía retenido. Devuelve si soltó algo.
 *
 * El `sesion_compra` en el WHERE no es de adorno: sin él, cualquiera que
 * conociera el id del espacio podría soltar la reserva de otro.
 */
async function liberar(espacioId, sesion) {
  const r = await bd('datos').consultar(
    `UPDATE espacio_reservas SET estado = 'liberado', updated_at = NOW(6)
      WHERE espacio_id = ? AND estado = 'retenido' AND sesion_compra = ?`,
    [espacioId, sesion]);
  return r.affectedRows > 0;
}

/* ── Confirmar ───────────────────────────────────────────────────────────
 *
 * La retención pasa a venta y se le ata la boleta. Devuelve si confirmó algo.
 *
 * El `expira_at > NOW()` es lo que impide confirmar una retención caducada —o
 * sea, cobrarle a alguien un espacio que ya se soltó y que puede haber cogido
 * otro—. Quitarlo no daría error: cobraría igual.
 */
async function confirmar(espacioId, sesion, ticketId) {
  const r = await bd('datos').consultar(
    `UPDATE espacio_reservas
        SET estado = 'vendido', ticket_id = ?, expira_at = NULL, updated_at = NOW(6)
      WHERE espacio_id = ? AND estado = 'retenido'
        AND sesion_compra = ? AND expira_at > NOW(6)`,
    [ticketId, espacioId, sesion]);
  return r.affectedRows > 0;
}

module.exports = { retener, liberar, confirmar, _minutosValidos: minutosValidos };
