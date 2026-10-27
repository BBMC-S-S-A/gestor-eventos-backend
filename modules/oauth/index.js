'use strict';

/* `oauth_barrer`, traída al código.
 *
 * Original: migración 0126. Dos borrados de limpieza, sin más misterio: los
 * códigos de autorización caducados hace más de un día y los tokens revocados
 * que llevan más de treinta días caducados.
 *
 * ── Los plazos son los del original, a propósito ─────────────────────────
 *
 * El día de los códigos y los treinta días de los tokens no son redondeos:
 * dan margen para mirar un fallo de integración después de que ocurra. Un
 * código que caducó hace diez minutos todavía sirve para entender por qué
 * alguien no pudo entrar; borrado al instante, no.
 *
 * ── Por qué los tokens piden ADEMÁS estar revocados ──────────────────────
 *
 * Un token caducado y NO revocado puede seguir teniendo un refresco vivo
 * colgando. Borrarlo dejaría al cliente sin poder renovar y sin saber por qué.
 */

const { bd } = require('../../core/db/mysql.js');

async function barrer() {
  const base = bd('datos');
  const codigos = await base.consultar(
    'DELETE FROM oauth_codes WHERE expira_at < NOW(6) - INTERVAL 1 DAY');
  const tokens = await base.consultar(
    'DELETE FROM oauth_tokens WHERE expira_at < NOW(6) - INTERVAL 30 DAY AND revocado = 1');
  /* El original devuelve void. Aquí se devuelve cuánto se barrió: no cuesta
     nada y es lo que querría ver quien lo llama desde un cron. */
  return { codigos: codigos.affectedRows, tokens: tokens.affectedRows };
}

module.exports = { barrer };
