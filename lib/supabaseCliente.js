/* El cliente de Supabase de verdad. Siempre el de verdad, nunca el adaptador.
 *
 * ── Por qué está separado de `lib/supabase.js` ───────────────────────────
 *
 * `lib/supabase.js` es la COSTURA DE DATOS: devuelve el adaptador de MySQL o
 * este cliente, según `DATOS_PROPIOS`. Pero hay dos usos que NO son datos y
 * que no pueden seguir esa bandera:
 *
 *   · `middleware/auth.js` llama a `supabase.auth.getUser(token)` mientras
 *     `AUTH_PROPIA` esté apagada. Si eso pasara por la costura, encender
 *     `DATOS_PROPIOS` dejaría sin `.auth` a TODAS las peticiones — el
 *     adaptador lanza ahí a propósito.
 *   · Los dos comparadores (`scripts/comparar-*.js`) tienen que hablar con
 *     PostgREST de verdad: si cogieran la costura con la bandera encendida,
 *     compararían el adaptador CONTRA SÍ MISMO y dirían que todo cuadra.
 *
 * Las tres banderas son independientes a propósito (`core/config`), y esto es
 * lo que hace que lo sigan siendo.
 *
 * ── Por qué se crea tarde ────────────────────────────────────────────────
 *
 * Antes esto se creaba al importar y hacía `process.exit(1)` si faltaban las
 * variables. Eso valía mientras Supabase fuera obligatorio; cuando las tres
 * banderas estén encendidas ya no lo será, y un `exit` al arrancar dejaría la
 * aplicación sin levantar por una variable que ya no hace falta.
 *
 * Ahora se crea en el primer uso y, si falta algo, lanza AHÍ con el mismo
 * mensaje. Lo que antes mataba el proceso al arrancar ahora revienta la
 * petición que de verdad necesitaba Supabase — ruidoso igual, y sólo para
 * quien lo usa.
 */

const config = require('../core/config');

/* Sin esto, un `await supabase.from(...)` que tropieza con una red que se
   degrada —no que se cae limpio, sino que se cuelga— se queda esperando para
   siempre: ninguna respuesta, ni error ni éxito, y quien hizo la petición ve
   la rueda de carga eternamente. `fetch` de Node no trae timeout por
   defecto, y `supabase-js` tampoco pone uno. Visto en producción: "crear
   torneo" (y potencialmente cualquier otra ruta) sin responder nunca, ni con
   un 500.

   20s porque hay consultas reales que tardan (reportes, exportar CSV) y un
   timeout corto las tiraría con el mismo síntoma que se quiere evitar. Lo que
   esto arregla no es la lentitud — es el cuelgue infinito: ahora, en el peor
   caso, hay un error a los 20s en vez de nunca. */
const CONSULTA_TIMEOUT_MS = 20_000;

let _cliente = null;

function crear() {
  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!URL || !KEY) {
    throw new Error(
      '[supabase] Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY, y algo las acaba de pedir.\n' +
      (config.DATOS_PROPIOS
        ? '  `DATOS_PROPIOS` está encendida, así que los DATOS ya no las necesitan: esto viene de\n' +
          '  otro sitio — el login (`AUTH_PROPIA` apagada) o uno de los comparadores.'
        : '  Ver CONFIGURAR.md.')
    );
  }

  const { createClient } = require('@supabase/supabase-js');
  return createClient(URL, KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (url, options = {}) => fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(CONSULTA_TIMEOUT_MS),
      }),
    },
  });
}

function cliente() {
  if (!_cliente) _cliente = crear();
  return _cliente;
}

/* Se exporta un Proxy y no el cliente, para que `require` no lo cree.
 *
 * Las funciones se atan (`bind`) al cliente: sin eso, `const { from } =
 * require(...)` perdería el `this` y supabase-js fallaría por dentro con un
 * error que no diría nada. Lo que no son funciones —`auth`, `storage`— se
 * devuelven tal cual, y llamar `.getUser()` sobre ellas conserva su `this`.
 *
 * ── Por qué el Proxy admite ESCRITURA ────────────────────────────────────
 *
 * Varias pruebas sustituyen `supabase.from` por una función falsa y lo
 * devuelven al terminar (`accesoRecuerda.test.js`, entre otras). Con un Proxy
 * que sólo lea, esa asignación se escribiría en el objeto vacío de dentro y el
 * `get` seguiría devolviendo el cliente de verdad: la prueba parecería montada
 * y estaría saliendo a la red. Lo descubrió justamente eso — `fetch failed`
 * donde antes había una función falsa.
 *
 * Así que lo que se escribe encima manda, y borrar la propiedad vuelve a
 * descubrir el cliente de abajo. */
module.exports = new Proxy({}, {
  get(destino, prop) {
    if (Object.prototype.hasOwnProperty.call(destino, prop)) return destino[prop];
    const c = cliente();
    const v = c[prop];
    return typeof v === 'function' ? v.bind(c) : v;
  },
  set(destino, prop, valor) { destino[prop] = valor; return true; },
  deleteProperty(destino, prop) { delete destino[prop]; return true; },
  has(destino, prop) {
    return Object.prototype.hasOwnProperty.call(destino, prop) || prop in cliente();
  },
});

/* Para las pruebas: olvidar el cliente ya creado. */
module.exports._olvidar = () => { _cliente = null; };
