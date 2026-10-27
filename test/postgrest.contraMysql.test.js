'use strict';

/* El adaptador de PostgREST contra un MySQL de verdad.
 *
 * `postgrest.compila.test.js` fija el SQL que se genera. Esto comprueba que ese
 * SQL hace lo que se cree — que es otra cosa, y es la que no se puede deducir
 * leyendo el código.
 *
 * ── Por qué está detrás de una bandera ───────────────────────────────────
 *
 * El CI no tiene MySQL. Una prueba que lo necesite y no lo encuentre falla
 * todos los días, y una prueba que falla todos los días acaba borrada. Corre
 * sólo si se pide:
 *
 *     MYSQL_PRUEBAS=1 npm test
 *
 * Levanta su propia base (`gestek_pruebas_postgrest`), la llena, comprueba y la
 * borra. No toca ninguna base del proyecto.
 *
 * ── El orden de los NULL, medido contra los dos motores ──────────────────
 *
 * El 27 de octubre de 2026, con una tabla de tres filas —una con la fecha a
 * NULL— y ordenando por esa fecha:
 *
 *   |                        | ASC     | DESC    |
 *   |------------------------|---------|---------|
 *   | Postgres 17.6 (Supabase, producción) | `1,3,2` | `2,3,1` |
 *   | MySQL 8.0.46 a pelo    | `2,1,3` | `3,1,2` |
 *   | MySQL con el adaptador | `1,3,2` | `2,3,1` |
 *
 * O sea que a pelo sale distinto EN LOS DOS SENTIDOS, y sale ordenado: la lista
 * no viene vacía ni da error, viene con los sin-fecha donde no van. Eso no se
 * reporta como fallo, se reporta como «se ve raro», si es que se reporta.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const SALTAR = process.env.MYSQL_PRUEBAS !== '1';
const BASE = 'gestek_pruebas_postgrest';

let mysql2, conexion, pg;

/* La base de pruebas se habla directa con mysql2, sin pasar por `core/db`: lo
   que se prueba es el adaptador, no la configuración del proyecto, y atarlo a
   las variables MYSQL_* de alguien haría que fallara por el motivo equivocado. */
async function abrir() {
  mysql2 = require('mysql2/promise');
  const raiz = await mysql2.createConnection({
    host: process.env.MYSQL_PRUEBAS_HOST || '127.0.0.1',
    user: process.env.MYSQL_PRUEBAS_USER || 'root',
    password: process.env.MYSQL_PRUEBAS_PASS || '',
    socketPath: process.env.MYSQL_PRUEBAS_SOCKET || undefined,
    multipleStatements: true,
  });
  await raiz.query(`DROP DATABASE IF EXISTS \`${BASE}\`;
    CREATE DATABASE \`${BASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
  await raiz.end();

  conexion = await mysql2.createConnection({
    host: process.env.MYSQL_PRUEBAS_HOST || '127.0.0.1',
    user: process.env.MYSQL_PRUEBAS_USER || 'root',
    password: process.env.MYSQL_PRUEBAS_PASS || '',
    socketPath: process.env.MYSQL_PRUEBAS_SOCKET || undefined,
    database: BASE,
    multipleStatements: true,
  });

  await conexion.query(`
    CREATE TABLE eventos (
      id        VARCHAR(36) PRIMARY KEY,
      nombre    VARCHAR(120) NOT NULL,
      owner_id  VARCHAR(36),
      fecha     DATE NULL,
      aforo     INT NULL,
      borrado_at DATETIME NULL
    ) COLLATE=utf8mb4_0900_as_ci;
  `);
    /* El cotejo de la tabla es el de las 91 tablas de datos, no el de la base:
       es el de la COLUMNA el que manda en una comparación, así que probar con
       otro mediría algo que no es lo que va a correr en producción. */
    for (const fila of [
      ['a', 'Primero',  'juan', '2026-01-01', 100,  null],
      ['b', 'Sin fecha','juan', null,         null, null],
      ['c', 'Tercero',  'juan', '2026-03-01', 50,   null],
      ['d', 'Borrado',  'ana',  '2026-02-01', 10,   '2026-02-02 10:00:00'],
      ['e', 'Bogota',   'ana',  '2026-04-01', 5,    null],
      ['f', 'Bogotá',   'ana',  '2026-05-01', 7,    null],
      ['g', 'BOGOTÁ',   'ana',  '2026-06-01', 9,    null],
    ]) await conexion.execute('INSERT INTO eventos VALUES (?,?,?,?,?,?)', fila);

  /* El adaptador habla con `core/db`, así que se le pasa una base que cumple el
     mismo contrato (`consultar`) apuntando a la de pruebas. Es el seam: así no
     hace falta configurar MYSQL_* del proyecto para probar esto. */
  const base = { consultar: async (sql, params = []) => (await conexion.execute(sql, params))[0] };
  pg = require('../core/db/postgrest.js').crear({ base });
}

test('adaptador contra MySQL de verdad', { skip: SALTAR && 'pon MYSQL_PRUEBAS=1' }, async (t) => {
  await abrir();
  t.after(async () => {
    await conexion.query(`DROP DATABASE IF EXISTS \`${BASE}\``);
    await conexion.end();
  });

  await t.test('select con eq devuelve las filas y error null', async () => {
    const { data, error } = await pg.from('eventos').select('id, nombre').eq('owner_id', 'juan');
    assert.equal(error, null);
    assert.deepEqual(data.map(f => f.id).sort(), ['a', 'b', 'c']);
    /* Sólo las columnas pedidas: si viniera `fecha`, el `select` no estaría
       haciendo nada y nadie se enteraría hasta que una tabla ancha fuera lenta. */
    assert.deepEqual(Object.keys(data[0]).sort(), ['id', 'nombre']);
  });

  await t.test('eq con null trae las no borradas, no cero filas', async () => {
    const { data } = await pg.from('eventos').select('id').eq('borrado_at', null);
    assert.deepEqual(data.map(f => f.id).sort(), ['a', 'b', 'c', 'e', 'f', 'g']);
  });

  await t.test('ASC pone los NULL al final, como Postgres', async () => {
    const { data } = await pg.from('eventos').select('id').eq('owner_id', 'juan').order('fecha');
    assert.deepEqual(data.map(f => f.id), ['a', 'c', 'b'],
      'MySQL a pelo daría b,a,c — el NULL arriba. Medido contra Postgres: a,c,b.');
  });

  await t.test('DESC pone los NULL al principio, como Postgres', async () => {
    const { data } = await pg.from('eventos').select('id').eq('owner_id', 'juan')
      .order('fecha', { ascending: false });
    assert.deepEqual(data.map(f => f.id), ['b', 'c', 'a'],
      'MySQL a pelo daría c,a,b — el NULL abajo. Medido contra Postgres: b,c,a.');
  });

  await t.test('nullsFirst false con DESC deja los NULL al final', async () => {
    const { data } = await pg.from('eventos').select('id').eq('owner_id', 'juan')
      .order('fecha', { ascending: false, nullsFirst: false });
    assert.deepEqual(data.map(f => f.id), ['c', 'a', 'b']);
  });

  await t.test('limit corta', async () => {
    const { data } = await pg.from('eventos').select('id').order('id').limit(2);
    assert.equal(data.length, 2);
  });

  await t.test('single con una fila la devuelve', async () => {
    const { data, error } = await pg.from('eventos').select('nombre').eq('id', 'a').single();
    assert.equal(error, null);
    assert.equal(data.nombre, 'Primero');
  });

  await t.test('single con cero filas da PGRST116', async () => {
    const { data, error } = await pg.from('eventos').select('*').eq('id', 'noexiste').single();
    assert.equal(data, null);
    assert.equal(error.code, 'PGRST116');
  });

  await t.test('single con varias filas da PGRST116, no la primera', async () => {
    /* Es la comprobación que separa «hay una» de «hay varias y cojo cualquiera».
       Devolver la primera callando es como se acaba mostrando el dato de otro. */
    const { data, error } = await pg.from('eventos').select('*').eq('owner_id', 'juan').single();
    assert.equal(data, null);
    assert.equal(error.code, 'PGRST116');
  });

  await t.test('maybeSingle con cero filas da null SIN error', async () => {
    /* La diferencia entera entre los dos métodos, y hay 378 `maybeSingle` que
       dependen de ella: si esto devolviera error, 378 caminos que hoy tratan
       «no hay» como un caso normal empezarían a tratarlo como un fallo. */
    const { data, error } = await pg.from('eventos').select('*').eq('id', 'noexiste').maybeSingle();
    assert.equal(data, null);
    assert.equal(error, null);
  });

  await t.test('maybeSingle con varias SÍ da error', async () => {
    const { error } = await pg.from('eventos').select('*').eq('owner_id', 'juan').maybeSingle();
    assert.equal(error.code, 'PGRST116');
  });

  await t.test('un error de SQL vuelve como error, no lanzado', async () => {
    /* Es lo que hace supabase-js y lo que el código de alrededor espera. Lo que
       LANZA es lo no soportado, que es cosa distinta y salta antes de llegar
       a la base. */
    const { data, error } = await pg.from('tabla_que_no_existe').select('*');
    assert.equal(data, null);
    assert.ok(error, 'una tabla inexistente tiene que dar error, no lista vacía');
    assert.match(error.message, /tabla_que_no_existe/);
  });

  /* ── Tramo 2: el resto de filtros ──────────────────────────────────── */

  await t.test('in con valores, y la lista VACÍA sin reventar', async () => {
    /* `IN ()` es un error de sintaxis en MySQL, así que esto comprueba que el
       `1 = 0` sale de verdad y que MySQL lo traga. Es la diferencia entre
       «cero filas» y «la petición revienta» para los 18 usos que pasan una
       lista salida de un `.map()`. */
    const conValores = await pg.from('eventos').select('id').in('id', ['a', 'c']);
    assert.deepEqual(conValores.data.map(f => f.id).sort(), ['a', 'c']);

    const vacia = await pg.from('eventos').select('id').in('id', []);
    assert.equal(vacia.error, null, 'la lista vacía reventó en vez de dar cero filas');
    assert.deepEqual(vacia.data, []);
  });

  await t.test('not in con lista vacía deja pasar todas', async () => {
    const { data, error } = await pg.from('eventos').select('id').not('id', 'in', []);
    assert.equal(error, null);
    assert.equal(data.length, 7);
  });

  await t.test('is null y not is null se reparten las filas', async () => {
    const sinFecha = await pg.from('eventos').select('id').is('fecha', null);
    assert.deepEqual(sinFecha.data.map(f => f.id), ['b']);

    const conFecha = await pg.from('eventos').select('id').not('fecha', 'is', null);
    assert.equal(conFecha.data.length, 6);
  });

  await t.test('neq excluye también las filas con NULL, como Postgres', async () => {
    /* `col <> 'x'` con `col` a NULL da NULL, que no es verdadero: la fila no
       entra. Pasa igual en los dos motores, pero sorprende lo bastante como
       para dejarlo escrito: de 7 filas, una tiene el aforo a NULL y no sale
       ni en `= 100` ni en `<> 100`. */
    const { data } = await pg.from('eventos').select('id').neq('aforo', 100);
    assert.ok(!data.some(f => f.id === 'b'), 'la fila con aforo NULL no debe salir en un <>');
    assert.ok(!data.some(f => f.id === 'a'), 'la fila con aforo 100 tampoco');
    assert.equal(data.length, 5);
  });

  await t.test('los rangos', async () => {
    const { data } = await pg.from('eventos').select('id').gte('aforo', 9).lte('aforo', 100).order('aforo');
    assert.deepEqual(data.map(f => f.id), ['g', 'd', 'c', 'a']);
    /* El aforo de 'b' es NULL y no entra en ningún rango, ni por arriba ni por
       abajo. Pasa igual en los dos motores. */
    assert.ok(!data.some(f => f.id === 'b'));
  });

  await t.test('ilike casa como ILIKE de Postgres: ciego a mayúsculas, NO a acentos', async () => {
    /* La medida que justifica que `ilike` sea un `LIKE` pelado. Contra el
       Postgres 17.6 de producción, con estas mismas tres filas:
       '%bogotá%' → Bogotá, BOGOTÁ ;  '%bogota%' → Bogota. */
    const conTilde = await pg.from('eventos').select('nombre').ilike('nombre', '%bogotá%');
    assert.deepEqual(conTilde.data.map(f => f.nombre).sort(), ['BOGOTÁ', 'Bogotá'],
      'con el cotejo bueno, la tilde distingue pero la mayúscula no');

    const sinTilde = await pg.from('eventos').select('nombre').ilike('nombre', '%bogota%');
    assert.deepEqual(sinTilde.data.map(f => f.nombre), ['Bogota'],
      'si salieran las tres, el cotejo sería ciego a los acentos y la búsqueda devolvería de más');
  });

  await t.test('los comodines de ilike pasan tal cual', async () => {
    /* `%` y `_` son comodines en los dos motores, así que no se escapan. Un
       `_` casa un carácter cualquiera: «Bogota» y «Bogotá» pero no «BOGOTÁ»
       —esa sí, que el cotejo ignora mayúsculas—. */
    const { data } = await pg.from('eventos').select('nombre').ilike('nombre', 'Bogot_');
    assert.equal(data.length, 3);
  });

  await t.test('varios filtros se combinan de verdad contra la base', async () => {
    const { data } = await pg.from('eventos').select('id')
      .eq('owner_id', 'ana').is('borrado_at', null).gte('aforo', 7).order('id');
    assert.deepEqual(data.map(f => f.id), ['f', 'g']);
  });

  await t.test('un método no soportado LANZA aunque haya base detrás', async () => {
    await assert.rejects(
      async () => { await pg.from('eventos').select('*').or('a.eq.1,b.eq.2'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO');
  });
});
