'use strict';

/* Las escrituras del adaptador (tramo 3): lo que se puede comprobar sin base.
 *
 * Casi todo el tramo 3 necesita MySQL —generar la clave, releer lo escrito,
 * la transacción— y vive en `postgrest.contraMysql.test.js`. Aquí queda lo que
 * se decide ANTES de tocar la base, que es justo lo que tiene que saltar
 * pronto: una fila mal formada, un `upsert` con una opción que no se sostiene,
 * un `update` sin objeto.
 *
 * Lo que decide el diseño, medido el 27 de octubre de 2026:
 *
 *   insert 140 (79 con `.select()`) · update 190 (71) ·
 *   delete 112 (1)  · upsert 13 (5)
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const pg = require('../core/db/postgrest.js');

const lanza = (fn, trozo) => assert.throws(fn, (e) => {
  assert.equal(e.code, 'PGRST_NO_SOPORTADO', `no lanzó lo del adaptador: ${e.message}`);
  assert.match(e.message, trozo);
  return true;
});

/* ── El plan que se arma ───────────────────────────────────────────────── */

test('cada escritura deja apuntada su acción', () => {
  assert.equal(pg.from('t').insert({ a: 1 })._plan().accion, 'insert');
  assert.equal(pg.from('t').update({ a: 1 })._plan().accion, 'update');
  assert.equal(pg.from('t').delete()._plan().accion, 'delete');
  assert.equal(pg.from('t').upsert({ a: 1 })._plan().accion, 'upsert');
});

test('un .select() detrás de una escritura pide las filas de vuelta', () => {
  /* Detrás de una escritura, `.select()` no elige qué leer: es el `RETURNING`
     de Postgres. Si esto no se distinguiera, un `insert` normal pagaría la
     transacción y la relectura que no le hacen falta — y son 61 inserciones y
     111 borrados los que NO lo piden. */
  assert.equal(pg.from('t').insert({ a: 1 })._plan().devolver, false);
  assert.equal(pg.from('t').insert({ a: 1 }).select('id')._plan().devolver, true);
  assert.equal(pg.from('t').delete().eq('id', 1)._plan().devolver, false);
  assert.equal(pg.from('t').update({ a: 1 }).select()._plan().devolver, true);
});

test('un select normal no se marca como devolución', () => {
  assert.equal(pg.from('t').select('*')._plan().devolver, false);
});

/* ── Las filas ─────────────────────────────────────────────────────────── */

test('una fila sola y una lista se tratan igual', () => {
  assert.equal(pg.from('t').insert({ a: 1 })._plan().filas.length, 1);
  assert.equal(pg.from('t').insert([{ a: 1 }, { a: 2 }])._plan().filas.length, 2);
});

test('insertar filas con columnas distintas LANZA', () => {
  /* PostgREST lo rechaza, y con razón: rellenar con NULL lo que falte es como
     se escriben filas a medias sin que nadie se entere. */
  lanza(() => pg.from('t').insert([{ a: 1 }, { b: 2 }]), /columnas distintas/);
  lanza(() => pg.from('t').insert([{ a: 1 }, { a: 2, b: 3 }]), /columnas distintas/);
});

test('insertar nada, o algo que no es un objeto, LANZA', () => {
  lanza(() => pg.from('t').insert([]), /sin ninguna fila/);
  lanza(() => pg.from('t').insert({}), /objeto vacío/);
  lanza(() => pg.from('t').insert('hola'), /no es un objeto/);
  lanza(() => pg.from('t').insert([[1, 2]]), /no es un objeto/);
});

test('update con algo que no es un objeto LANZA', () => {
  lanza(() => pg.from('t').update('nombre'), /no es un objeto/);
  lanza(() => pg.from('t').update([{ a: 1 }]), /no es un objeto/);
});

/* ── upsert ────────────────────────────────────────────────────────────── */

test('upsert guarda su onConflict', () => {
  assert.equal(pg.from('t').upsert({ a: 1 }, { onConflict: 'evento_id' })._plan().onConflict, 'evento_id');
});

test('upsert con ignoreDuplicates LANZA', () => {
  /* Sería `INSERT IGNORE`, y `INSERT IGNORE` no ignora sólo la clave repetida:
     se traga TODOS los errores recuperables. Un texto demasiado largo se corta
     y una fecha inválida se vuelve ceros, en silencio — con los datos ya
     escritos. Cero usos hoy. */
  lanza(() => pg.from('t').upsert({ a: 1 }, { ignoreDuplicates: true }), /ignoreDuplicates/);
});

/* ── Los valores que se escriben ───────────────────────────────────────── */

test('los arrays y los objetos se convierten a texto JSON', () => {
  /* Medido contra mysql2 3.24.2: con `execute()` un array crudo ya se guarda
     bien, pero con `query()` el mismo array se expande como lista de valores y
     revienta. Convertirlo aquí hace que dé igual cuál se use. */
  const v = pg._valorEscribible;
  assert.equal(v(['vip', 'general']), '["vip","general"]');
  assert.equal(v({ a: 1 }), '{"a":1}');
});

test('las fechas y los Buffer NO se tocan', () => {
  /* Pasar una fecha por JSON.stringify la convertiría en texto ISO entre
     comillas dentro de una columna DATETIME. mysql2 las sabe escribir. */
  const v = pg._valorEscribible;
  const d = new Date('2026-01-01T00:00:00Z');
  assert.equal(v(d), d);
  const b = Buffer.from('x');
  assert.equal(v(b), b);
});

test('lo demás pasa tal cual', () => {
  const v = pg._valorEscribible;
  assert.equal(v('hola'), 'hola');
  assert.equal(v(5), 5);
  assert.equal(v(true), true);
  assert.equal(v(null), null);
});

/* ── throwOnError ──────────────────────────────────────────────────────── */

test('throwOnError lanza en vez de fingir', () => {
  /* Devolverse a sí mismo sería mentir a medias: el error seguiría volviendo
     en `{ error }` en vez de lanzarse. Cero usos. */
  lanza(() => pg.from('t').select('*').throwOnError(), /throwOnError/);
});
