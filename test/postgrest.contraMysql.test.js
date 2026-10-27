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
      borrado_at DATETIME NULL
    );
    INSERT INTO eventos VALUES
      ('a', 'Primero', 'juan', '2026-01-01', NULL),
      ('b', 'Sin fecha', 'juan', NULL,        NULL),
      ('c', 'Tercero', 'juan', '2026-03-01', NULL),
      ('d', 'Borrado', 'ana',  '2026-02-01', '2026-02-02 10:00:00');
  `);

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
    assert.deepEqual(data.map(f => f.id).sort(), ['a', 'b', 'c']);
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

  await t.test('un método no soportado LANZA aunque haya base detrás', async () => {
    await assert.rejects(
      async () => { await pg.from('eventos').select('*').ilike('nombre', '%pri%'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO');
  });
});
