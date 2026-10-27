'use strict';

/* `.or()` y su gramática (tramo 6).
 *
 * 28 usos. PostgREST se inventa aquí un idioma propio DENTRO de una cadena, y
 * las cinco formas que hay en el código están todas abajo, copiadas de donde
 * viven. Medido el 27 de octubre de 2026.
 *
 * ── Las dos cosas que importan ───────────────────────────────────────────
 *
 * **1 · Los paréntesis al compilar.** En SQL, `a = 1 AND b = 2 OR c = 3` se
 * lee `(a AND b) OR c`. Si el `or` no se envuelve, una consulta que combine
 * `.eq()` con `.or()` devuelve filas de MÁS — y en este proyecto eso es la
 * lista de clientes de un evento enseñando los de otro. Sin error.
 *
 * **2 · Las comas no son todas iguales.** Hay comas que separan condiciones y
 * comas que están dentro de un `and(…)` o de un `in.(…)`. Un `split(',')`
 * parte `id.in.(a,b,c)` en tres trozos.
 *
 * ── Lo que esto NO arregla, porque no es suyo ────────────────────────────
 *
 * Estas cadenas se arman interpolando (`ilike.%${q}%`). Si lo que teclea el
 * usuario lleva una coma, la condición se parte mal — y eso pasa YA HOY contra
 * PostgREST, que hace el mismo análisis. No es una regresión del adaptador, y
 * arreglarlo aquí dejaría los dos motores comportándose distinto. La solución
 * es entrecomillar el valor en el sitio que construye la cadena.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const pg = require('../core/db/postgrest.js');

const t = () => pg.from('t').select('*');
const donde = (b) => b._compilar().sql.replace(/^SELECT \* FROM `t` WHERE /, '');
const ps = (b) => b._compilar().params;
const lanza = (fn, trozo) => assert.throws(fn, (e) => {
  assert.equal(e.code, 'PGRST_NO_SOPORTADO', `no lanzó lo del adaptador: ${e.message}`);
  assert.match(e.message, trozo);
  return true;
});

/* ── Las cinco formas que hay en el código ─────────────────────────────── */

test('forma 1 · dos condiciones sueltas', () => {
  /* `routes/tickets.js`: la boleta es mía o va a mi correo. */
  const b = t().or('user_id.eq.abc,guest_email.eq.ana@x.com');
  assert.equal(donde(b), '(`user_id` = ? OR `guest_email` = ?)');
  assert.deepEqual(ps(b), ['abc', 'ana@x.com']);
});

test('forma 2 · con is null', () => {
  /* `is.null` es el único sitio donde el texto NO es el valor: quiere decir
     NULL, no la cadena «null». */
  const b = t().or('fecha_fin.is.null,fecha_fin.gte.2026-10-27');
  assert.equal(donde(b), '(`fecha_fin` IS NULL OR `fecha_fin` >= ?)');
  assert.deepEqual(ps(b), ['2026-10-27'], 'el null no puede viajar como parámetro');
});

test('forma 3 · anidada con and() — el cursor de la lista de clientes', () => {
  /* `routes/clientes.js`: «dame lo anterior a esta fila», desempatando por id.
     Si el `and` se aplanara, la paginación por cursor repetiría filas. */
  const b = t().or('created_at.lt.X,and(created_at.eq.X,id.lt.Y)');
  assert.equal(donde(b), '(`created_at` < ? OR (`created_at` = ? AND `id` < ?))');
  assert.deepEqual(ps(b), ['X', 'X', 'Y']);
});

test('forma 4 · con una lista in.(…)', () => {
  /* `routes/eventos.js`: míos o de los eventos donde soy miembro. Las comas de
     dentro del paréntesis son de la lista, no separan condiciones. */
  const b = t().or('owner_id.eq.abc,id.in.(a,b,c)');
  assert.equal(donde(b), '(`owner_id` = ? OR `id` IN (?, ?, ?))');
  assert.deepEqual(ps(b), ['abc', 'a', 'b', 'c']);
});

test('forma 5 · dos and() sueltos — el enfrentamiento del torneo', () => {
  /* `routes/torneos.js`: A contra B, o B contra A. */
  const b = t().or('and(equipo_a_id.eq.1,equipo_b_id.eq.2),and(equipo_a_id.eq.2,equipo_b_id.eq.1)');
  assert.equal(donde(b), '((`equipo_a_id` = ? AND `equipo_b_id` = ?) OR (`equipo_a_id` = ? AND `equipo_b_id` = ?))');
  assert.deepEqual(ps(b), ['1', '2', '2', '1']);
});

/* ── Los paréntesis, que es lo que no se ve ────────────────────────────── */

test('el or va ENTRE PARÉNTESIS cuando hay otros filtros', () => {
  /* En SQL, `a = 1 AND b = 2 OR c = 3` se lee `(a AND b) OR c`. Sin el
     paréntesis, esta consulta devolvería las filas de OTROS eventos —las que
     casen con el `or` aunque su `evento_id` sea otro—. Sin error. */
  const b = t().eq('evento_id', 'e1').or('guest_nombre.ilike.%ana%,codigo.ilike.%ana%');
  assert.equal(donde(b), '`evento_id` = ? AND (`guest_nombre` LIKE ? OR `codigo` LIKE ?)');
  assert.deepEqual(ps(b), ['e1', '%ana%', '%ana%']);
});

test('los parámetros salen en el orden en que se leen', () => {
  const b = t().eq('a', 1).or('b.eq.2,and(c.eq.3,d.eq.4)').eq('e', 5);
  assert.deepEqual(ps(b), [1, '2', '3', '4', 5]);
});

/* ── Los valores ───────────────────────────────────────────────────────── */

test('un valor con puntos dentro no se parte', () => {
  /* Una fecha o un correo llevan puntos. Se parte por los DOS primeros, no por
     todos. */
  const b = t().or('creado.gte.2026-10-27T10:30:00.000Z,email.eq.ana.perez@x.com');
  assert.deepEqual(ps(b), ['2026-10-27T10:30:00.000Z', 'ana.perez@x.com']);
});

test('un valor entrecomillado pierde las comillas y conserva su coma', () => {
  /* Es la salida que PostgREST da para los valores con comas, y por eso se
     leen: así el sitio que construye la cadena puede arreglarlo sin tocar el
     adaptador. */
  const b = t().or('nombre.eq."Pérez, Juan"');
  assert.deepEqual(ps(b), ['Pérez, Juan']);
});

test('is sólo admite null, true y false', () => {
  assert.equal(donde(t().or('a.is.true')), '(`a` IS TRUE)');
  assert.equal(donde(t().or('a.is.false')), '(`a` IS FALSE)');
  lanza(() => donde(t().or('a.is.5')), /is\.5/);
});

test('una lista vacía da cero filas, no un error', () => {
  /* Como en el tramo 2: `IN ()` es un error de sintaxis en MySQL. */
  assert.equal(donde(t().or('id.in.()')), '(1 = 0)');
});

/* ── Lo que lanza ──────────────────────────────────────────────────────── */

test('una condición sin la forma columna.operador.valor LANZA', () => {
  lanza(() => t().or('esto no es una condicion'), /se esperaba/);
  lanza(() => t().or('solo.dospartes'), /se esperaba/);
});

test('un operador que no existe LANZA', () => {
  lanza(() => t().or('a.cs.{1,2}'), /operador `cs`/);
});

test('like dentro de un or LANZA', () => {
  /* Lo mismo que fuera: en Postgres distingue mayúsculas y en MySQL con cotejo
     `_ci` no. Se comportaría como `ilike` y devolvería de más. */
  lanza(() => t().or('n.like.Ana%'), /like.*or/i);
});

test('los paréntesis descuadrados LANZAN', () => {
  lanza(() => t().or('a.eq.1,and(b.eq.2'), /descuadrados/);
});

test('un and() vacío LANZA', () => {
  lanza(() => t().or('a.eq.1,and()'), /vacío/);
});

test('un or sobre una tabla relacionada LANZA', () => {
  lanza(() => t().or('a.eq.1', { referencedTable: 'otra' }), /tabla relacionada/);
});

test('una lista in sin paréntesis LANZA', () => {
  lanza(() => t().or('id.in.a,b'), /entre paréntesis/);
});
