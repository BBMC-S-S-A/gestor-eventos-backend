'use strict';

/* Cuánto se queda la gente: los microsegundos no se tiran.
 *
 * ── El fallo ─────────────────────────────────────────────────────────────
 *
 * `modules/aforo/consultas.js` mide la estancia emparejando cada entrada con
 * su salida. Lo hacía así:
 *
 *     ROUND(AVG(TIMESTAMPDIFF(SECOND, created_at, sig_at)) / 60, 1)
 *
 * `TIMESTAMPDIFF(SECOND, …)` devuelve un ENTERO: tira los microsegundos de
 * cada tramo. La función de Postgres usa `extract(epoch from (b - a))`, que
 * los conserva, y las columnas son `DATETIME(6)`, así que esa parte existe.
 *
 * Medido contra FESTECH: la zona `acc_kic8bme` daba 19.0 minutos de media en
 * MySQL y 19.1 en Postgres. Un decimal — pero no es un redondeo que se
 * compense. **Todos los truncamientos van hacia abajo**, así que la media
 * sale siempre igual o menor, y cuanto más corta es la estancia más pesa:
 * sobre tramos de un minuto, tirar hasta un segundo por tramo es casi un 2%.
 *
 * Y ese es el número con el que se decide si una zona se congestiona.
 *
 * ── Por qué una prueba y no sólo el arreglo ──────────────────────────────
 *
 * `TIMESTAMPDIFF(SECOND, …)` es lo que uno escribe sin pensarlo, y el fallo
 * no se ve: devuelve un número creíble. Lo encontró `comparar-consultas.js`
 * comparando contra Postgres, y eso sólo corre a mano antes de un corte.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const HAY_MYSQL = process.env.MYSQL_PRUEBAS === '1';
const saltar = { skip: HAY_MYSQL ? false : 'requiere MySQL (MYSQL_PRUEBAS=1)' };

test('la consulta no usa TIMESTAMPDIFF(SECOND)', () => {
  /* Sin base: que nadie lo «simplifique» de vuelta. */
  const src = fs.readFileSync('modules/aforo/consultas.js', 'utf8');
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/TIMESTAMPDIFF\(\s*SECOND/i.test(codigo),
    'volvió TIMESTAMPDIFF(SECOND): trunca los microsegundos y la media sale corta');
  assert.match(codigo, /TIMESTAMPDIFF\(\s*MICROSECOND/i);
});

test('un tramo con fracción de segundo no se tira', saltar, async () => {
  /* El caso tiene que CRUZAR el redondeo a un decimal, y eso no se consigue
     con la misma fracción en todos los tramos: el desvío máximo por tramo es
     de un segundo, o sea 1/60 = 0.0167 minutos, y con todos iguales la media
     truncada cae siempre en un múltiplo exacto que no llega a saltar.

     Lo que sí cruza es MEZCLAR fracciones, que es lo que hacen los datos de
     verdad. Tres tramos de 1142.9, 1142.9 y 1143.9 segundos:

         truncados: 1142, 1142, 1143  -> media 1142.33 s -> 19.039 -> 19.0
         exactos:   1142.9, …, 1143.9 -> media 1143.23 s -> 19.054 -> 19.1

     Un decimal de diferencia, igual que en FESTECH. Y siempre hacia abajo. */
  const mysql = require('mysql2/promise');
  const con = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    socketPath: process.env.MYSQL_SOCKET || '/var/run/mysqld/mysqld.sock',
    multipleStatements: true,
  });
  try {
    await con.query(`DROP DATABASE IF EXISTS prueba_estancia;
                     CREATE DATABASE prueba_estancia;`);
    await con.query('USE prueba_estancia');
    await con.query(`CREATE TABLE t (a DATETIME(6), b DATETIME(6))`);
    /* Seis tramos que en segundos enteros dan 19.0 y con microsegundos 19.1,
       que es exactamente el caso de FESTECH. */
    const filas = [
      ['2026-09-17 10:00:00.000000', '2026-09-17 10:19:02.900000'],
      ['2026-09-17 10:00:00.000000', '2026-09-17 10:19:02.900000'],
      ['2026-09-17 10:00:00.000000', '2026-09-17 10:19:03.900000'],
    ];
    await con.query('INSERT INTO t (a, b) VALUES ?', [filas]);

    const [[r]] = await con.query(`
      SELECT ROUND(AVG(TIMESTAMPDIFF(SECOND, a, b)) / 60, 1)                   AS truncado,
             ROUND(AVG(TIMESTAMPDIFF(MICROSECOND, a, b) / 1000000) / 60, 1)    AS exacto
        FROM t`);

    assert.equal(Number(r.exacto), 19.1, 'el cálculo exacto no da lo que da Postgres');
    assert.equal(Number(r.truncado), 19.0, 'el truncado ya no se queda corto: ¿cambió MySQL?');
    assert.ok(Number(r.truncado) < Number(r.exacto),
      'truncar siempre quita tiempo, nunca lo añade');
  } finally {
    await con.query('DROP DATABASE IF EXISTS prueba_estancia').catch(() => {});
    await con.end();
  }
});
