'use strict';

/* El cableado de `sincronizar.js`: de dónde lee y dónde escribe.
 *
 * Separado de la lógica a propósito. `sincronizar.js` no importa nada —
 * recibe sus dependencias— y por eso se puede probar sin Supabase y sin
 * MySQL. Aquí es donde se le dice cuáles son de verdad, y este archivo no
 * tiene lógica que probar.
 *
 * ── Cuándo hace falta, y cuándo no ───────────────────────────────────────
 *
 * Sólo durante la convivencia: identidad en Supabase, datos en MySQL. Si las
 * dos banderas están del mismo lado no hay hueco que tapar:
 *
 *   · `DATOS_PROPIOS` apagada → todo sigue en Supabase, el perfil ya está.
 *   · `AUTH_PROPIA` encendida → la cuenta se crea en MySQL al registrarse,
 *      y esto sobra. Cuando esa bandera lleve tiempo encendida, este módulo
 *      y su llamada en `middleware/auth.js` se pueden borrar.
 */

const config = require('../../core/config');

/* Los dos se cargan tarde. `core/db/mysql.js` exige las variables `MYSQL_*`
   en cuanto le piden una conexión, y `lib/supabaseCliente.js` las suyas:
   importarlos arriba haría que un backend sin MySQL —o sin Supabase, el día
   que se apague— fallara al arrancar por un módulo que ni siquiera va a
   usar. */
function base()   { return require('../../core/db/mysql.js').bd('datos'); }
function origen() { return require('../../lib/supabaseCliente.js'); }

const { sincronizar, COLUMNAS } = require('./sincronizar.js');

/* ¿Hay hueco que tapar ahora mismo? */
function haceFalta() {
  return Boolean(config.DATOS_PROPIOS) && !config.AUTH_PROPIA;
}

/* Lee el perfil de Supabase. Sólo las columnas que se van a copiar: pedir
   `*` traería también las que MySQL no tiene, y además los secretos de pagos
   de esa persona, que no hacen falta aquí. */
async function leerDeOrigen(id) {
  const { data, error } = await origen()
    .from('profiles').select(COLUMNAS.join(', ')).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/* Lo que llama `middleware/auth.js`. No se espera el resultado allí: esto no
   debe meterse en el tiempo de respuesta de la petición. */
async function asegurar(id) {
  if (!haceFalta()) return 'no-hace-falta';
  return sincronizar(id, {
    base: base(),
    leerDeOrigen,
    avisar: (m) => console.warn(m),
  });
}

module.exports = { asegurar, haceFalta };
