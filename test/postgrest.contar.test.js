'use strict';

/* Contar y paginar (tramo 4).
 *
 * Medido el 27 de octubre de 2026: **54 `count: 'exact'`** —de los cuales
 * **44 con `head: true`**, o sea «cuéntalas y no me las traigas»— y **18
 * `.range()`**. Ni un `planned`, ni un `estimated`.
 *
 * ── Las dos cosas que importan ───────────────────────────────────────────
 *
 * **1 · El conteo ignora el `range`.** Y esto no es una interpretación de la
 * documentación: `routes/eventos.js:142` pide `count: 'exact'` junto con
 * `.range(tramo.desde, tramo.hasta)` y usa el `count` para paginar. Si el
 * conteo respetara el rango, esa pantalla diría «10 de 10» en vez de «10 de
 * 1234», o sea que la paginación de producción ya estaría rota hoy. No lo
 * está, luego el conteo es el total.
 *
 * **2 · `range` tiene los dos extremos dentro.** `range(0, 9)` son DIEZ filas.
 * Equivocarse en ese borde no da error: da páginas que se solapan por una
 * fila, y la última de cada página vuelve a salir la primera de la siguiente.
 * Un fallo que se ve como «este cliente aparece dos veces en la lista».
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const pg = require('../core/db/postgrest.js');

const sql = (b) => b._compilar().sql;
const lanza = (fn, trozo) => assert.throws(fn, (e) => {
  assert.equal(e.code, 'PGRST_NO_SOPORTADO', `no lanzó lo del adaptador: ${e.message}`);
  assert.match(e.message, trozo);
  return true;
});

/* ── range ─────────────────────────────────────────────────────────────── */

test('range(0, 9) son DIEZ filas, no nueve', () => {
  assert.equal(sql(pg.from('t').select('*').range(0, 9)), 'SELECT * FROM `t` LIMIT 10 OFFSET 0');
});

test('range(20, 29) salta las veinte primeras', () => {
  assert.equal(sql(pg.from('t').select('*').range(20, 29)), 'SELECT * FROM `t` LIMIT 10 OFFSET 20');
});

test('range de una sola fila', () => {
  assert.equal(sql(pg.from('t').select('*').range(5, 5)), 'SELECT * FROM `t` LIMIT 1 OFFSET 5');
});

test('el range va después del filtro y del orden', () => {
  assert.equal(
    sql(pg.from('t').select('*').eq('a', 1).order('n').range(10, 19)),
    'SELECT * FROM `t` WHERE `a` = ? ORDER BY (`n` IS NULL) ASC, `n` ASC LIMIT 10 OFFSET 10');
});

test('un range al revés o negativo LANZA', () => {
  lanza(() => sql(pg.from('t').select('*').range(9, 0)), /el final va antes del principio/);
  lanza(() => sql(pg.from('t').select('*').range(-1, 5)), /range\(-1, 5\)/);
  lanza(() => sql(pg.from('t').select('*').range(0, 1.5)), /range\(0, 1\.5\)/);
});

test('range y limit a la vez LANZAN', () => {
  /* Uno pisaría al otro y no está dicho cuál. Cero usos hoy: mejor saltar que
     elegir en silencio. */
  lanza(() => sql(pg.from('t').select('*').range(0, 9).limit(5)), /a la vez/);
});

/* ── count ─────────────────────────────────────────────────────────────── */

test('el conteo tira el ORDER BY y el LIMIT, y se queda con el WHERE', () => {
  /* El orden no cambia cuántas hay y cuesta; el límite es justo lo que NO debe
     aplicarse. El filtro sí: se cuenta lo que casa. */
  const b = pg.from('t').select('*', { count: 'exact' }).eq('a', 1).order('n').range(0, 9);
  const c = pg._compilarConteo(b._plan());
  assert.equal(c.sql, 'SELECT COUNT(*) AS n FROM `t` WHERE `a` = ?');
  assert.deepEqual(c.params, [1]);
});

test('sin filtros, el conteo es de toda la tabla', () => {
  const b = pg.from('t').select('*', { count: 'exact' }).range(0, 9);
  assert.equal(pg._compilarConteo(b._plan()).sql, 'SELECT COUNT(*) AS n FROM `t`');
});

test('head: true queda apuntado como «sólo contar»', () => {
  const con = pg.from('t').select('*', { count: 'exact', head: true })._plan();
  assert.equal(con.contar, 'exact');
  assert.equal(con.soloContar, true);

  const sin = pg.from('t').select('*', { count: 'exact' })._plan();
  assert.equal(sin.soloContar, false, 'sin head hay que traer las filas además de contarlas');
});

test('un select normal no cuenta nada', () => {
  const p = pg.from('t').select('*')._plan();
  assert.equal(p.contar, null);
  assert.equal(p.soloContar, false);
});

test('count planned o estimated LANZAN', () => {
  /* Salen del planificador de Postgres y son APROXIMADOS. Traducirlos a un
     COUNT(*) de verdad sería «mejor» y por eso mismo sería mentira: quien pide
     una estimación espera que sea barata, no exacta. Cero usos: los 54 son
     `exact`. */
  lanza(() => pg.from('t').select('*', { count: 'planned' }), /planned/);
  lanza(() => pg.from('t').select('*', { count: 'estimated' }), /estimated/);
});

test('head sin count LANZA', () => {
  /* No devolvería ni filas ni cuenta: quien lo escribe se equivocó. */
  lanza(() => pg.from('t').select('*', { head: true }), /head.*sin.*count/i);
});

test('count detrás de una escritura LANZA', () => {
  /* `.insert(…).select('*', {count:'exact'})` — contar qué, y respecto a qué.
     Cero usos. */
  lanza(() => pg.from('t').insert({ a: 1 }).select('*', { count: 'exact' }), /escritura/);
});
