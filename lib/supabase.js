/* La costura de datos: Supabase o MySQL, según `DATOS_PROPIOS`.
 *
 * Las 1.152 llamadas `supabase.from(...)` repartidas en 95 archivos siguen
 * escritas igual. Lo único que cambia es qué les contesta — y lo decide esta
 * línea, no ellas.
 *
 *   DATOS_PROPIOS apagada (hoy)  → el cliente de Supabase, por PostgREST.
 *   DATOS_PROPIOS encendida      → `core/db/postgrest.js`, contra MySQL.
 *
 * El adaptador habla el mismo idioma: `from`, `select`, los filtros, las
 * escrituras, `count`, `range`, los 66 embebidos, `.or()` y las 14 funciones.
 * El razonamiento, lo medido y lo que lanza a propósito están en
 * `db/EL-RESTO-DE-LAS-RUTAS.md`.
 *
 * ── Volver atrás es apagar la bandera ────────────────────────────────────
 *
 * No hay nada que deshacer: ni migración de código, ni ramas a medias. Se
 * apaga `DATOS_PROPIOS`, se reinicia, y las 1.152 vuelven a hablar con
 * Supabase. Por eso el camino B valía la pena.
 *
 * ── Lo que esta costura NO cubre ─────────────────────────────────────────
 *
 * El login y los archivos. Son otras dos banderas —`AUTH_PROPIA` y
 * `ARCHIVOS_PROPIOS`— y se mueven por su cuenta: quien necesite el Supabase de
 * verdad para eso pide `lib/supabaseCliente.js`, no esto. El adaptador LANZA
 * si alguien le pide `.auth` o `.storage`, justamente para que un cableado mal
 * hecho salte en vez de devolver algo a medias.
 *
 * ── Por qué el `require` va dentro del `if` ──────────────────────────────
 *
 * `core/db/postgrest.js` arrastra `core/db/mysql.js`, que exige las variables
 * `MYSQL_*` en cuanto le piden una conexión. Cargarlo con la bandera apagada
 * no rompería nada hoy, pero haría que un fallo de configuración de MySQL se
 * notara en una instalación que todavía no usa MySQL — ruido que confunde el
 * día que algo de verdad falla.
 */

const config = require('../core/config');

if (config.DATOS_PROPIOS) {
  console.log('[datos] DATOS_PROPIOS encendido: las consultas van a MySQL (core/db/postgrest.js).');
  module.exports = require('../core/db/postgrest.js');
} else {
  module.exports = require('./supabaseCliente.js');
}
