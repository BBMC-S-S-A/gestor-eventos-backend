'use strict';

/* Qué columnas se excluyen de un INSERT, y cuáles NO.
 *
 * ── El fallo ─────────────────────────────────────────────────────────────
 *
 * `scripts/migrar-datos.js` y `scripts/volcar-datos.js` tienen que saltarse
 * las columnas GENERADAS: escribir en una da `ER_NON_INSERTABLE_TABLE`.
 *
 * Los dos lo preguntaban así:
 *
 *     !/GENERATED/i.test(fila.EXTRA)
 *
 * Parece lo obvio. Y MySQL 8 pone **`DEFAULT_GENERATED`** en `EXTRA` a toda
 * columna que tenga un `DEFAULT` con expresión:
 *
 *     created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)   -> DEFAULT_GENERATED
 *     branding   JSON        DEFAULT (CAST('{}' AS JSON))   -> DEFAULT_GENERATED
 *     estado     VARCHAR(255) DEFAULT ('borrador')          -> DEFAULT_GENERATED
 *
 * Medido contra el esquema real: **204 columnas en 81 de las 84 tablas**.
 * Ninguna es generada. Todas quedaban fuera del INSERT.
 *
 * Y el modo de fallo es el que este proyecto lleva persiguiendo todo el rato:
 * **no da error**. Las filas entran todas, los conteos cuadran, el script
 * imprime «todas las tablas cuadran» — y dentro, cada `page_json` es `{}`,
 * cada `estado` es 'borrador' y cada `created_at` es la hora de la migración.
 * 38.421 filas cargadas con la mitad del contenido en su valor por defecto,
 * y nada que lo diga.
 *
 * La pregunta buena es `GENERATION_EXPRESSION`, que está vacía salvo en las
 * generadas de verdad — 7 en todo el esquema. No hay cadena que interpretar.
 *
 * ── Cómo se corre ────────────────────────────────────────────────────────
 *
 * Necesita un MySQL de verdad, porque lo que se prueba es qué contesta MySQL:
 *
 *     MYSQL_PRUEBAS=1 npm test
 *
 * Sin eso se salta. Una prueba que simulara la respuesta de
 * `information_schema` no habría encontrado nunca este fallo: el error estaba
 * justo en creer saber lo que MySQL contesta. */

const test = require('node:test');
const assert = require('node:assert');

const HAY_MYSQL = process.env.MYSQL_PRUEBAS === '1';
const saltar = { skip: HAY_MYSQL ? false : 'requiere MySQL (MYSQL_PRUEBAS=1)' };

const BASE = 'prueba_columnas_insertables';

async function conMysql(fn) {
  const mysql = require('mysql2/promise');
  const con = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    socketPath: process.env.MYSQL_SOCKET || '/var/run/mysqld/mysqld.sock',
    multipleStatements: true,
  });
  try {
    await con.query(`DROP DATABASE IF EXISTS \`${BASE}\`;
                     CREATE DATABASE \`${BASE}\`;`);
    await con.query(`USE \`${BASE}\``);
    return await fn(con);
  } finally {
    await con.query(`DROP DATABASE IF EXISTS \`${BASE}\``).catch(() => {});
    await con.end();
  }
}

/* LA función de `volcar-datos.js`, no una copia de su consulta pegada aquí.
   Una copia se queda atrás en cuanto alguien toque el script, y entonces esta
   prueba seguiría pasando mientras el fallo vuelve. Por eso el script sólo
   arranca si lo invocan directamente. */
const { columnasDe } = require('../scripts/volcar-datos.js');

/* `columnasDe` espera el objeto de `core/db/mysql.js`, que tiene `consultar`.
   Se le pasa uno que envuelve la conexión de la prueba. */
const comoBase = (con) => ({
  consultar: async (sql, params) => (await con.query(sql, params))[0],
});

const TABLA = `
  CREATE TABLE t (
    id          CHAR(36) NOT NULL,
    -- normales, sin DEFAULT: nunca estuvieron en duda
    titulo      VARCHAR(255) NOT NULL,
    nota        TEXT NULL,
    -- las 204: DEFAULT con expresión -> EXTRA = 'DEFAULT_GENERATED'
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    branding    JSON NOT NULL DEFAULT (CAST('{}' AS JSON)),
    estado      VARCHAR(255) NOT NULL DEFAULT ('borrador'),
    -- DEFAULT literal: EXTRA vacío. Tampoco debe excluirse.
    aforo       INT NOT NULL DEFAULT 0,
    -- la de verdad: EXTRA = 'VIRTUAL GENERATED'
    estado_vivo VARCHAR(255) AS (IF(estado = 'publicado', estado, NULL)) VIRTUAL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

test('MySQL de verdad marca DEFAULT_GENERATED en las que tienen DEFAULT con expresión', saltar, async () => {
  /* Esta prueba no comprueba nuestro código: comprueba la premisa. Si algún
     día MySQL dejara de hacerlo, el comentario de los scripts sería mentira y
     conviene enterarse por aquí. */
  await conMysql(async (con) => {
    await con.query(TABLA);
    const [filas] = await con.query(
      `SELECT COLUMN_NAME c, EXTRA e FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't'`);
    const extra = Object.fromEntries(filas.map(f => [f.c, f.e]));
    assert.match(extra.created_at, /DEFAULT_GENERATED/);
    assert.match(extra.branding,   /DEFAULT_GENERATED/);
    assert.match(extra.estado,     /DEFAULT_GENERATED/);
    assert.match(extra.estado_vivo, /VIRTUAL GENERATED/);
    /* Y aquí está el choque: el filtro viejo no distingue entre las cuatro. */
    for (const c of ['created_at', 'branding', 'estado', 'estado_vivo']) {
      assert.ok(/GENERATED/i.test(extra[c]),
        `${c}: el filtro viejo la habría excluido, y sólo una debía serlo`);
    }
  });
});

test('la consulta buena excluye SÓLO la generada', saltar, async () => {
  await conMysql(async (con) => {
    await con.query(TABLA);
    const cols = [...await columnasDe(comoBase(con), 't')].sort();
    assert.deepEqual(cols,
      ['aforo', 'branding', 'created_at', 'estado', 'id', 'nota', 'titulo'],
      'o se coló la generada, o se perdió una columna con DEFAULT');
    assert.ok(!cols.includes('estado_vivo'), 'la generada tiene que quedar fuera');
  });
});

test('y el INSERT con esas columnas entra de verdad', saltar, async () => {
  /* Lo que de verdad importa: que la lista sirva para insertar. Incluir la
     generada da ER_NON_INSERTABLE_TABLE; excluir una normal pierde el dato en
     silencio, que es el fallo que se está arreglando. */
  await conMysql(async (con) => {
    await con.query(TABLA);
    const cols = [...await columnasDe(comoBase(con), 't')];
    const valores = { id: 'abc', titulo: 'FESTECH', nota: null,
                      created_at: '2026-01-02 03:04:05.000000',
                      branding: '{"color":"rojo"}', estado: 'publicado', aforo: 500 };

    await con.query(
      `INSERT INTO t (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map(c => valores[c]));

    const [[fila]] = await con.query('SELECT * FROM t');
    /* Los valores llegaron: no se quedaron en su DEFAULT. */
    assert.equal(fila.estado, 'publicado', 'el estado se quedó en su valor por defecto');
    assert.equal(fila.aforo, 500);
    assert.deepEqual(fila.branding, { color: 'rojo' }, 'el branding se quedó en {}');
    assert.equal(new Date(fila.created_at).toISOString(), '2026-01-02T03:04:05.000Z',
      'el created_at se quedó en la hora de la migración');
    /* Y la generada la calculó MySQL sola. */
    assert.equal(fila.estado_vivo, 'publicado');
  });
});

test('los dos scripts preguntan por GENERATION_EXPRESSION, no por EXTRA', () => {
  /* Sin MySQL también hay algo que proteger: que nadie vuelva al filtro de
     cadenas. Es el tipo de «simplificación» que parece inofensiva. */
  const fs = require('node:fs');
  for (const f of ['scripts/migrar-datos.js', 'scripts/volcar-datos.js']) {
    const src = fs.readFileSync(f, 'utf8');
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '');   // sin comentarios
    assert.match(codigo, /GENERATION_EXPRESSION/,
      `${f}: ya no pregunta por GENERATION_EXPRESSION`);
    assert.ok(!/\/GENERATED\/i\.test/.test(codigo),
      `${f}: volvió el filtro sobre EXTRA, que se lleva 204 columnas por delante`);
  }
});
