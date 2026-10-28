'use strict';

/* Las 14 funciones del adaptador: que lo de detrás se pueda LLAMAR.
 *
 * ── El fallo ─────────────────────────────────────────────────────────────
 *
 * `core/db/postgrest.js` traduce cada `supabase.rpc('nombre', args)` a una
 * llamada a un módulo. Dos de las catorce estaban mal cableadas:
 *
 *     find_pending_reminders: (a) => …pendientesDeCorreo(a.p_limit)
 *
 * `modules/recordatorios/index.js` recibe `bd` POR PARÁMETRO —al revés que
 * `espacios`, `promociones` o `contadores`, que lo importan ellos— así que
 * ahí le llegaba el número 50 en el sitio de la base. Dentro hace
 * `bd('datos')`, y eso es `bd is not a function`. Además el límite nunca
 * llegaba a su sitio: es el segundo argumento, dentro de un objeto de
 * opciones.
 *
 * ── Por qué no lo vio nadie ──────────────────────────────────────────────
 *
 * `postgrest.funciones.test.js` recorre el código buscando `.rpc('…')` y
 * comprueba que las catorce estén en la tabla. Eso protege de llamar a una
 * que no existe, que era el fallo que se tenía en mente. No protege de que
 * la que existe esté mal llamada — y una tabla de despacho es justo donde
 * eso pasa, porque cada entrada es una línea suelta que nadie ejecuta hasta
 * el día que se usa.
 *
 * Lo encontró `comparar-consultas.js` contra la base cargada. Esta prueba lo
 * baja a `npm test`, que es donde tiene que doler.
 *
 * ── Qué comprueba ────────────────────────────────────────────────────────
 *
 * Para cada entrada: a qué módulo y a qué función llama, y si esa función
 * espera `bd` de primero, que el cableado se lo pase. Sin base de datos y sin
 * llamar a nada — dos de las catorce ESCRIBEN (`generar_recordatorios_inapp`
 * mete notificaciones), y una prueba no tiene por qué ejecutarlas para saber
 * que están mal enchufadas.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { _FUNCIONES } = require('../core/db/postgrest.js');

/* `(a) => require('../../modules/x/index.js').metodo(a.p_uno, …)`
   → { modulo: '../../modules/x/index.js', metodo: 'metodo', args: 'a.p_uno, …' } */
function leerCableado(fn) {
  const src = fn.toString().replace(/\s+/g, ' ');
  const m = src.match(/require\('([^']+)'\)\s*\.\s*(\w+)\s*\(([\s\S]*)\)\s*$/);
  if (!m) return null;
  return { modulo: m[1], metodo: m[2], args: m[3].trim() };
}

/* Los parámetros que DECLARA una función, leídos de su fuente.
 *
 * No vale `fn.length`: no cuenta los que tienen valor por defecto. Las tres
 * firmas de esta tabla que llevan opciones —`pendientesDeCorreo(bd, { … } =
 * {})`, `retener(a, b, c, d = 15)`, `serie(x, { … } = {})`— dan `length` uno
 * menos de lo que reciben, así que medir por ahí marcaba como mal cableadas
 * tres entradas que están bien. */
function parametrosDe(fn) {
  const src = fn.toString();
  const abre = src.indexOf('(');
  if (abre < 0) return [];
  let nivel = 0, fin = -1;
  for (let i = abre; i < src.length; i++) {
    if (src[i] === '(') nivel++;
    else if (src[i] === ')') { nivel--; if (!nivel) { fin = i; break; } }
  }
  if (fin < 0) return [];
  return trocearPorComas(src.slice(abre + 1, fin));
}

/* Partir por las comas de ARRIBA, sin bajar a las de dentro de un objeto o
   de una llamada: `{ limite: a.p_limit }, b` son dos, no tres. */
function trocearPorComas(txt) {
  if (!txt.trim()) return [];
  const out = [];
  let nivel = 0, actual = '';
  for (const ch of txt) {
    if ('([{'.includes(ch)) nivel++;
    else if (')]}'.includes(ch)) nivel--;
    if (ch === ',' && nivel === 0) { out.push(actual.trim()); actual = ''; continue; }
    actual += ch;
  }
  out.push(actual.trim());
  return out;
}

const primerParametro = (fn) =>
  ((parametrosDe(fn)[0] || '').match(/^\w+/) || [null])[0];

const entradas = Object.entries(_FUNCIONES);

test('las catorce entradas llaman a un módulo que existe', () => {
  const malas = [];
  for (const [nombre, fn] of entradas) {
    const c = leerCableado(fn);
    if (!c) { malas.push(`${nombre}: no pude leer a qué llama`); continue; }
    let mod;
    try { mod = require(path.join(__dirname, '..', 'core', 'db', c.modulo)); }
    catch (e) { malas.push(`${nombre}: no carga ${c.modulo} — ${e.message}`); continue; }
    if (typeof mod[c.metodo] !== 'function') {
      malas.push(`${nombre}: ${c.modulo} no exporta ${c.metodo}()`);
    }
  }
  assert.deepEqual(malas, []);
});

test('si el módulo espera `bd` de primero, el cableado se lo pasa', () => {
  /* EL fallo. `recordatorios` recibe la base por parámetro y recibía el
     límite: `bd('datos')` sobre un número, que es «bd is not a function» la
     primera vez que alguien pide recordatorios — en un cron, de madrugada. */
  const malas = [];
  for (const [nombre, fn] of entradas) {
    const c = leerCableado(fn);
    if (!c) continue;
    let mod;
    try { mod = require(path.join(__dirname, '..', 'core', 'db', c.modulo)); } catch { continue; }
    const destino = mod[c.metodo];
    if (typeof destino !== 'function') continue;

    if (primerParametro(destino) !== 'bd') continue;      // lo importa él, nada que pasar

    const primerArg = (c.args.split(',')[0] || '').trim();
    if (primerArg !== 'bd') {
      malas.push(`${nombre}: ${c.metodo}() espera bd de primero y recibe «${primerArg || '(nada)'}»`);
    }
  }
  assert.deepEqual(malas, [],
    'eso revienta con «bd is not a function» la primera vez que se use');
});

test('ninguna entrada le pasa un argumento al hueco de otro', () => {
  /* La otra mitad del mismo fallo: con `bd` puesto de primero, lo que venga
     detrás tiene que caber en lo que la función declara. `pendientesDeCorreo`
     recibe `(bd, opciones)`, así que el límite va dentro de un objeto —
     pasarlo suelto lo dejaría en `undefined` y la consulta traería 200 en vez
     de los que se pidieron, sin que nada lo dijera. */
  const malas = [];
  for (const [nombre, fn] of entradas) {
    const c = leerCableado(fn);
    if (!c) continue;
    let mod;
    try { mod = require(path.join(__dirname, '..', 'core', 'db', c.modulo)); } catch { continue; }
    const destino = mod[c.metodo];
    if (typeof destino !== 'function') continue;

    const manda = trocearPorComas(c.args).length;
    const recibe = parametrosDe(destino).length;
    if (manda > recibe) {
      malas.push(`${nombre}: manda ${manda} argumento(s) y ${c.metodo}() declara ${recibe}`);
    }
  }
  assert.deepEqual(malas, []);
});
