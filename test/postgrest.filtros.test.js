'use strict';

/* Los filtros del adaptador de PostgREST (tramo 2).
 *
 * Medido sobre el código del 27 de octubre de 2026, que es lo que decide qué
 * hacía falta de verdad:
 *
 *     eq 1.330 · neq 31 · is 65 · in 18 · ilike 29 · not 22
 *     gte 12 · gt 5 · lt 5 · lte 3 · match 0 · like 0 · textSearch 0
 *
 * Las dos cosas que no son mecánicas, y por eso son casi todo este archivo:
 *
 *   · **`.in(col, [])`**. Los 18 usos pasan listas que salen de un `.map()`, o
 *     sea que pueden venir vacías. PostgREST devuelve cero filas; `IN ()` en
 *     MySQL es un error de sintaxis. Son dos resultados distintos ante la
 *     misma llamada.
 *   · **El cotejo**, que decide si `ilike` casa igual en los dos motores. La
 *     respuesta es que sí, pero sólo con el cotejo de las tablas de datos —y
 *     por eso hay una prueba que lo vigila.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pg = require('../core/db/postgrest.js');

const donde = (b) => b._compilar().sql.replace(/^SELECT \* FROM `t` WHERE /, '');
const ps    = (b) => b._compilar().params;
const t      = () => pg.from('t').select('*');

const lanza = (fn, trozo) => assert.throws(fn, (e) => {
  assert.equal(e.code, 'PGRST_NO_SOPORTADO', `no lanzó lo del adaptador: ${e.message}`);
  assert.match(e.message, trozo);
  return true;
});

/* ── Los comparadores ──────────────────────────────────────────────────── */

test('los comparadores de orden y desigualdad', () => {
  assert.equal(donde(t().neq('estado', 'pagado')), '`estado` <> ?');
  assert.equal(donde(t().gt('n', 1)),   '`n` > ?');
  assert.equal(donde(t().gte('n', 1)),  '`n` >= ?');
  assert.equal(donde(t().lt('n', 1)),   '`n` < ?');
  assert.equal(donde(t().lte('n', 1)),  '`n` <= ?');
  assert.deepEqual(ps(t().gte('n', 5).lt('n', 10)), [5, 10]);
});

test('neq y los de orden con null lanzan en vez de no casar con nada', () => {
  /* En SQL `col <> NULL` no casa con ninguna fila, en los dos motores. Es
     correcto y es inútil: quien lo escribe quería `is` o `not(col,'is',null)`.
     Cero usos hoy, así que se cierra la puerta antes de que entre el primero. */
  lanza(() => donde(t().neq('x', null)), /neq\(col, null\)/);
  lanza(() => donde(t().gt('x', null)),  /gt\(col, null\)/);
});

/* ── is ────────────────────────────────────────────────────────────────── */

test('is admite null y los dos booleanos, nada más', () => {
  assert.equal(donde(t().is('borrado', null)),  '`borrado` IS NULL');
  assert.equal(donde(t().is('activo', true)),   '`activo` IS TRUE');
  assert.equal(donde(t().is('activo', false)),  '`activo` IS FALSE');
  assert.deepEqual(ps(t().is('borrado', null)), []);
});

test('is con cualquier otra cosa lanza', () => {
  /* Convertirlo en `= ?` parecería funcionar y devolvería otra cosa. */
  lanza(() => donde(t().is('n', 5)), /is\(col, 5\)/);
  lanza(() => donde(t().is('s', 'null')), /is\(col, "null"\)/);
});

/* ── in, y la lista vacía ──────────────────────────────────────────────── */

test('in con valores', () => {
  assert.equal(donde(t().in('id', [1, 2, 3])), '`id` IN (?, ?, ?)');
  assert.deepEqual(ps(t().in('id', [1, 2, 3])), [1, 2, 3]);
});

test('in con lista VACÍA da cero filas, no un error de sintaxis', () => {
  /* La trampa de este tramo. Los 18 usos pasan listas que salen de un `.map()`.
   *
   *   PostgREST : `col = ANY('{}')` → 0 filas. Medido contra el Postgres 17.6
   *               de producción.
   *   MySQL     : `col IN ()` es un ERROR DE SINTAXIS.
   *
   * `1 = 0` es la traducción fiel. Dejar que reventara sería ruidoso, sí, pero
   * rompería código que hoy funciona: la regla de reventar es para lo que NO
   * sabemos hacer. */
  assert.equal(donde(t().in('id', [])), '1 = 0');
  assert.deepEqual(ps(t().in('id', [])), []);
});

test('not in con lista vacía deja pasar todo', () => {
  /* El reverso, y también medido contra Postgres: `not (id = any('{}'))` son
     las tres filas de tres. */
  assert.equal(donde(t().not('id', 'in', [])), 'NOT (1 = 0)');
});

test('in con algo que no es lista lanza', () => {
  lanza(() => donde(t().in('id', 'uno,dos')), /no es una lista/);
});

/* ── not ───────────────────────────────────────────────────────────────── */

test('las dos formas de not que existen en el código', () => {
  /* 18 son `not(col,'is',null)` y 4 son `not(col,'in',[…])`. No hay más. */
  assert.equal(donde(t().not('fecha', 'is', null)), 'NOT (`fecha` IS NULL)');
  assert.equal(donde(t().not('id', 'in', [7, 8])), 'NOT (`id` IN (?, ?))');
  assert.deepEqual(ps(t().not('id', 'in', [7, 8])), [7, 8]);
});

test('not sobre un operador que no existe lanza', () => {
  lanza(() => donde(t().not('x', 'cs', ['a'])), /`cs`/);
});

/* ── ilike ─────────────────────────────────────────────────────────────── */

test('ilike es un LIKE pelado: lo demás lo hace el cotejo', () => {
  assert.equal(donde(t().ilike('nombre', '%ana%')), '`nombre` LIKE ?');
  assert.deepEqual(ps(t().ilike('nombre', '%ana%')), ['%ana%']);
});

test('ilike con algo que no es texto lanza', () => {
  lanza(() => donde(t().ilike('nombre', 5)), /no es texto/);
});

test('like lanza, y dice por qué no es lo mismo', () => {
  /* En Postgres `LIKE` distingue mayúsculas; en MySQL con cotejo `_ci` NO. Un
     `.like()` traducido a `LIKE` se comportaría como `ilike` y devolvería de
     más, en silencio. Cero usos hoy. */
  lanza(() => t().like('nombre', 'Ana%'), /COLLATE/);
});

test('match lanza: cero usos medidos', () => {
  /* El documento del plan contaba 6 y eran `String.prototype.match(/regex/)`,
     el mismo recuento ingenuo que daba 200 `.filter` de supabase cuando son 0. */
  lanza(() => t().match({ a: 1 }), /cero usos/);
});

/* ── Que se combinen ───────────────────────────────────────────────────── */

test('varios filtros distintos se unen con AND y los parámetros van en orden', () => {
  const b = t().eq('owner', 'juan').is('borrado', null).in('estado', ['a', 'b'])
    .ilike('nombre', '%ana%').gte('n', 5);
  assert.equal(donde(b),
    '`owner` = ? AND `borrado` IS NULL AND `estado` IN (?, ?) AND `nombre` LIKE ? AND `n` >= ?');
  assert.deepEqual(ps(b), ['juan', 'a', 'b', '%ana%', 5]);
});

/* ── El cotejo, que es lo que hace que `ilike` valga ───────────────────── */

test('las tablas de datos siguen en utf8mb4_0900_as_ci', () => {
  /* `ilike` se traduce a un `LIKE` pelado porque el cotejo de la COLUMNA manda
   * en la comparación, y `utf8mb4_0900_as_ci` es insensible a mayúsculas y
   * SENSIBLE a acentos — justo lo que hace `ILIKE` en Postgres. Medido el
   * 27-oct sobre «Bogota», «Bogotá» y «BOGOTÁ»:
   *
   *   buscando   Postgres ILIKE   0900_as_ci       unicode_ci
   *   %bogotá%   Bogotá, BOGOTÁ   Bogotá, BOGOTÁ   los tres  ✗
   *   %bogota%   Bogota           Bogota           los tres  ✗
   *
   * Si una tabla de datos entrara con `utf8mb4_unicode_ci` o `…_ai_ci`, las
   * búsquedas del mostrador empezarían a devolver de más sin que nada fallara.
   * Por eso esto se vigila desde aquí y no se deja en un comentario. */
  const esquema = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'esquema', '01_tablas.sql'), 'utf8');

  const cotejos = [...esquema.matchAll(/COLLATE\s*=?\s*([a-z0-9_]+)/gi)].map(m => m[1].toLowerCase());
  assert.ok(cotejos.length > 50, `sólo se encontraron ${cotejos.length} cotejos: ¿cambió el formato del volcado?`);

  const intrusos = [...new Set(cotejos.filter(c => c !== 'utf8mb4_0900_as_ci'))];
  assert.deepEqual(intrusos, [],
    'Hay tablas de datos con un cotejo que no es `utf8mb4_0900_as_ci`. Los cotejos ' +
    '`_ai_ci` son CIEGOS A LOS ACENTOS: «Bogota» casaría con «Bogotá» y las búsquedas ' +
    'devolverían de más, sin error y sin que nadie lo note.\n' +
    `Encontrados: ${intrusos.join(', ')}`);
});
