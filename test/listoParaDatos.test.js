'use strict';

/* Los números del comprobador de `DATOS_PROPIOS`.
 *
 * `scripts/listo-para-datos.js` dice «84 tablas, 976 columnas, 182 claves
 * ajenas» y falla si no cuadra. Esos tres números están escritos en el
 * archivo, y un número escrito a mano se queda atrás — ya pasó dos veces en
 * este mismo repositorio:
 *
 *   · la lista de claves de `comparar-bases.js` decía «las seis que quedan
 *     fuera del patrón» cuando eran nueve;
 *   · el §10 de `CORTE.md` daba por pendiente el cableado de las rutas, que
 *     el camino B ya había resuelto.
 *
 * Las dos veces el síntoma fue el mismo: un guardia que decía «no se puede
 * cortar» por algo que no era verdad. Un comprobador en el que no se confía
 * no sirve de nada, así que sus números se atan a un cargue desde cero.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const HAY_MYSQL = process.env.MYSQL_PRUEBAS === '1';
const saltar = { skip: HAY_MYSQL ? false : 'requiere MySQL (MYSQL_PRUEBAS=1)' };
const BASE = process.env.MYSQL_BASE_ESQUEMA || 'decero';

const FUENTE = fs.readFileSync('scripts/listo-para-datos.js', 'utf8');

/* Se leen del archivo en vez de exportarlos: el script se corre en el
   servidor y requerirlo abre conexiones. Leerlo es suficiente y no toca
   nada. */
function esperado(clave) {
  const m = FUENTE.match(new RegExp(`${clave}:\\s*(\\d+)`));
  assert.ok(m, `no encontré \`${clave}\` en listo-para-datos.js`);
  return Number(m[1]);
}

async function conMysql(fn) {
  const mysql = require('mysql2/promise');
  const con = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    socketPath: process.env.MYSQL_SOCKET || '/var/run/mysqld/mysqld.sock',
  });
  try { return await fn(con); } finally { await con.end(); }
}

test('los tres números cuadran con un cargue desde cero', saltar, async () => {
  await conMysql(async (con) => {
    const uno = async (sql) => Number(Object.values((await con.query(sql, [BASE]))[0][0])[0]);

    const tablas = await uno(
      `SELECT COUNT(*) FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'archivos'`);
    assert.ok(tablas > 50, `la base ${BASE} no parece cargada (${tablas} tablas)`);

    assert.equal(tablas, esperado('tablas'),
      'el comprobador espera otro número de tablas del que hay');

    const columnas = await uno(
      `SELECT COUNT(*) FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t
           ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
              AND t.TABLE_TYPE = 'BASE TABLE'
        WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME <> 'archivos'`);
    assert.equal(columnas, esperado('columnas'));

    const claves = await uno(
      `SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`);
    assert.equal(claves, esperado('claves'));
  });
});

test('los índices que busca existen de verdad', saltar, async () => {
  /* Si uno se renombra en una migración, el comprobador diría «falta» para
     siempre y nadie podría encender la bandera. */
  await conMysql(async (con) => {
    const lista = FUENTE.slice(FUENTE.indexOf('const UNICOS'), FUENTE.indexOf('];', FUENTE.indexOf('const UNICOS')));
    const nombres = [...lista.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
    assert.ok(nombres.length >= 7, `esperaba al menos 7 índices y leí ${nombres.length}`);

    const [filas] = await con.query(
      `SELECT DISTINCT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?`, [BASE]);
    const hay = new Set(filas.map(f => f.i));
    assert.deepEqual(nombres.filter(n => !hay.has(n)), [],
      'el comprobador busca índices que ya no se llaman así');
  });
});

test('dice que la bandera no se devuelve sola', () => {
  /* Lo único que de verdad distingue a esta bandera de las otras dos, y lo
     que hay que haber leído ANTES de encenderla. Si alguien quita ese aviso
     al limpiar el archivo, el comprobador pasa de advertir a callar. */
  /* Sin atarse a cómo esté partida la frase entre líneas: lo que no puede
     desaparecer es la idea, y la idea son estas dos piezas. */
  assert.match(FUENTE, /lo que se escriba va SÓLO a/,
    'desapareció el aviso de que las escrituras dejan de ir a Supabase');
  assert.match(FUENTE, /Apagarla después no devuelve esos datos a Supabase/,
    'desapareció el aviso de que la bandera no se devuelve quitando la variable');
});
