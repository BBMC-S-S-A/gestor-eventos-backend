'use strict';

/* El adaptador de PostgREST sobre MySQL: la parte que se prueba sin base.
 *
 * `compilar()` es pura —plan dentro, SQL fuera—, y eso es a propósito: el CI no
 * tiene MySQL, y la semántica es justo la parte que, si se equivoca, no da
 * error. Aquí se fija el SQL que se genera; `postgrest.contraMysql.test.js`
 * comprueba que ese SQL hace lo que se cree contra un MySQL de verdad.
 *
 * Lo que más importa de este archivo son dos cosas:
 *
 *   · **Que lo no soportado LANCE.** No que devuelva `{ error }`: que lance.
 *     Muchas de las 1.152 llamadas recogen `data` y tiran el `error`, así que
 *     un error devuelto sería una lista vacía en silencio — el fallo que este
 *     adaptador existe para evitar.
 *   · **El orden de los NULL**, que es donde Postgres y MySQL no coinciden y
 *     donde la diferencia no se ve: la lista sale ordenada, sale mal, y nadie
 *     lo llama un fallo.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const pg = require('../core/db/postgrest.js');

const sql = (b) => b._compilar().sql;
const ps  = (b) => b._compilar().params;

/* ── Lo básico ─────────────────────────────────────────────────────────── */

test('un select sin columnas trae todo', () => {
  assert.equal(sql(pg.from('eventos').select()), 'SELECT * FROM `eventos`');
});

test('las columnas van entrecomilladas, no pegadas', () => {
  /* Con comillas invertidas una columna que se llame como una palabra
     reservada de MySQL —`order`, `key`, `status`— sigue funcionando. Sin
     ellas, revienta sólo en esa tabla y sólo en producción. */
  assert.equal(sql(pg.from('t').select('id, nombre')), 'SELECT `id`, `nombre` FROM `t`');
});

test('los valores van como parámetros, nunca pegados al SQL', () => {
  const b = pg.from('t').select('*').eq('nombre', "'; DROP TABLE t; --");
  assert.equal(sql(b), 'SELECT * FROM `t` WHERE `nombre` = ?');
  assert.deepEqual(ps(b), ["'; DROP TABLE t; --"]);
});

test('varios eq se unen con AND', () => {
  const b = pg.from('t').select('*').eq('a', 1).eq('b', 2);
  assert.equal(sql(b), 'SELECT * FROM `t` WHERE `a` = ? AND `b` = ? LIMIT 0'.replace(' LIMIT 0', ''));
  assert.deepEqual(ps(b), [1, 2]);
});

test('eq con null es IS NULL, no = NULL', () => {
  /* En SQL `= NULL` no casa con nada, nunca. PostgREST lo traduce a `IS NULL`.
     Sin esto, un `.eq('borrado_at', null)` devolvería CERO filas en silencio
     en vez de todas las no borradas — y una lista vacía no parece un fallo. */
  const b = pg.from('t').select('*').eq('borrado_at', null);
  assert.equal(sql(b), 'SELECT * FROM `t` WHERE `borrado_at` IS NULL');
  assert.deepEqual(ps(b), []);
});

/* ── El orden de los NULL ──────────────────────────────────────────────── */

test('ascendente: los NULL al FINAL, como Postgres', () => {
  /* Postgres ASC pone los NULL al final; MySQL los pone al principio. La
     comparación `IS NULL` es lo que lo iguala: 0 (no nulo) antes que 1. */
  assert.equal(
    sql(pg.from('t').select('*').order('fecha')),
    'SELECT * FROM `t` ORDER BY (`fecha` IS NULL) ASC, `fecha` ASC');
});

test('descendente: los NULL al PRINCIPIO, como Postgres', () => {
  assert.equal(
    sql(pg.from('t').select('*').order('fecha', { ascending: false })),
    'SELECT * FROM `t` ORDER BY (`fecha` IS NULL) DESC, `fecha` DESC');
});

test('nullsFirst explícito manda sobre el valor por defecto', () => {
  /* El único uso hoy es `routes/vacantes.js:73`: destacadas primero por fecha
     descendente, pero las que no están destacadas (NULL) al final. Sin
     `nullsFirst: false` saldrían arriba del todo. */
  assert.equal(
    sql(pg.from('t').select('*').order('destacada_hasta', { ascending: false, nullsFirst: false })),
    'SELECT * FROM `t` ORDER BY (`destacada_hasta` IS NULL) ASC, `destacada_hasta` DESC');
});

test('varios order se encadenan en el orden en que se pidieron', () => {
  assert.equal(
    sql(pg.from('t').select('*').order('a').order('b', { ascending: false })),
    'SELECT * FROM `t` ORDER BY (`a` IS NULL) ASC, `a` ASC, (`b` IS NULL) DESC, `b` DESC');
});

/* ── Una fila ──────────────────────────────────────────────────────────── */

test('single pide dos filas para poder distinguir «una» de «más de una»', () => {
  /* No es optimización: `single()` tiene que fallar si vienen dos. Con LIMIT 2
     se sabe, sin traer las 40.000 que pudiera haber. */
  assert.equal(sql(pg.from('t').select('*').eq('id', 1).single()),
    'SELECT * FROM `t` WHERE `id` = ? LIMIT 2');
});

test('un limit propio manda sobre el 2 de single', () => {
  /* `.limit(5).single()` tiene que fallar igual que falla hoy contra Supabase,
     no arreglarse solo por culpa del adaptador. */
  assert.equal(sql(pg.from('t').select('*').limit(5).single()), 'SELECT * FROM `t` LIMIT 5');
});

test('sin single no se pone límite ninguno', () => {
  assert.equal(sql(pg.from('t').select('*')), 'SELECT * FROM `t`');
});

/* ── LA REGLA: lo no soportado LANZA ───────────────────────────────────── */

const lanza = (fn, trozo) => {
  assert.throws(fn, (e) => {
    assert.equal(e.code, 'PGRST_NO_SOPORTADO', `no lanzó el error del adaptador: ${e.message}`);
    assert.match(e.message, trozo);
    return true;
  });
};

test('un método que no existe lanza y dice cuál era', () => {
  /* Sin el Proxy esto sería «or is not a function», que no distingue entre
     «falta implementarlo» y «está mal escrito».

     Esta lista se va vaciando sola: `ilike`, `in` e `is` salieron en el tramo
     2, `range` en el 4 y `or` en el 6. Sus pruebas viven en
     `postgrest.filtros.test.js`, `postgrest.contar.test.js` y
     `postgrest.or.test.js`; aquí quedan los que de verdad siguen sin soporte,
     que ya son sólo los operadores de array de Postgres y la búsqueda de
     texto. */
  lanza(() => pg.from('t').select('*').contains('zonas', ['vip']), /\.contains\(\)/);
  lanza(() => pg.from('t').select('*').containedBy('zonas', ['vip']), /\.containedBy\(\)/);
  lanza(() => pg.from('t').select('*').overlaps('zonas', ['vip']), /\.overlaps\(\)/);
  lanza(() => pg.from('t').select('*').textSearch('nombre', 'ana'), /\.textSearch\(\)/);
});

/* Aquí había una prueba de que `insert`, `update` y `delete` lanzaban. El
   tramo 3 las implementó, así que dejó de ser verdad y sus pruebas viven ahora
   en `postgrest.escrituras.test.js` y `postgrest.contraMysql.test.js`.

   Que una prueba así falle al implementar el tramo siguiente es la señal buena:
   decía la verdad sobre el estado anterior y avisa de que ha cambiado. */

/* Aquí había una prueba de que los JOIN embebidos lanzaban. El tramo 5 los
   implementó; se prueban en `postgrest.embebidos.test.js`, empezando por el de
   `lib/acceso.js` —el guardia de las 378 rutas—, que es el que más daño haría
   si volviera como lista en vez de como objeto. */

/* Aquí había una prueba de que `count` lanzaba y mandaba al tramo 4. Ese
   tramo lo implementó; contar y paginar se prueban en
   `postgrest.contar.test.js`. */

test('una función que el adaptador no conoce lanza y manda al tramo 7', () => {
  /* Las 14 que sí conoce se prueban en `postgrest.funciones.test.js`, con una
     que recorre el código buscando `.rpc('…')` y comprueba que están todas.
     Aquí queda el caso contrario: pedir una que no existe es un fallo de
     cableado, y tiene que saltar en vez de pasar por una rama de «no se pudo»
     que nadie mira. */
  lanza(() => pg.rpc('una_que_nadie_escribio', { p: 1 }), /tramo 7/);
});

test('storage y auth lanzan: son otras banderas', () => {
  /* Si alguien los pide desde el adaptador de DATOS es que se cableó mal.
     Mejor saltar que devolver algo a medias. */
  lanza(() => pg.storage, /ARCHIVOS_PROPIOS/);
  lanza(() => pg.auth, /AUTH_PROPIA/);
});

test('un nombre de tabla o columna raro lanza antes de tocar la base', () => {
  /* Los identificadores no pueden ir como parámetro, así que se validan por
     forma. Lo que no case, salta aquí — no en un error de sintaxis de MySQL. */
  lanza(() => sql(pg.from('t; DROP TABLE x').select('*')), /t; DROP TABLE x/);
  lanza(() => sql(pg.from('t').select('a, b; --')), /b; --/);
});

test('un limit que no es un entero lanza', () => {
  lanza(() => sql(pg.from('t').select('*').limit('5')), /limit/);
  lanza(() => sql(pg.from('t').select('*').limit(-1)), /limit/);
});

/* ── Que se pueda mirar sin que estalle ────────────────────────────────── */

test('console.log y JSON.stringify sobre el constructor no lanzan', () => {
  /* El Proxy lanza ante cualquier propiedad desconocida, y las herramientas de
     JavaScript preguntan por varias solas. Si esto lanzara, no se podría ni
     poner un `console.log` para depurar. */
  const b = pg.from('t').select('*');
  assert.doesNotThrow(() => JSON.stringify(b));
  assert.doesNotThrow(() => `${String(b.toString)}`);
  assert.doesNotThrow(() => require('node:util').inspect(b));
});
