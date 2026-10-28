'use strict';

/* Por dónde ordena el comparador cada tabla.
 *
 * ── El fallo ─────────────────────────────────────────────────────────────
 *
 * `scripts/comparar-bases.js` ordena y empareja las filas por `id`, y llevaba
 * una lista escrita a mano de las que no lo tienen. El comentario decía «las
 * seis que quedan fuera del patrón».
 *
 * Eran nueve. Las tres que faltaban —`ticket_type_espacios`,
 * `torneo_jurados`, `torneo_ronda_participantes`— llegaron con las
 * migraciones 006 y 009, después de escribirse la lista.
 *
 * Y lo que salía no era «esto no se comprobó»:
 *
 *     ! ticket_type_espacios   ERROR   Unknown column 'id' in 'order clause'
 *     5 tabla(s) no cuadran. NO se corta todavía.
 *
 * El paso que decide si se corta decía que NO por tres tablas que estaban
 * perfectas. Y esas tres nunca llegaron a compararse: el guardia que dice
 * «todas iguales» hablaba de menos tablas de las que hay.
 *
 * El arreglo no es añadir las tres a la lista —eso se vuelve a quedar atrás
 * con la décima—: es preguntarle la `PRIMARY KEY` a la base. Una lista que no
 * existe no puede desactualizarse.
 *
 * Esta prueba cubre las dos mitades:
 *
 *   · que el mapa escrito a mano, que sigue haciendo falta cuando el origen
 *     se lee por PostgREST, esté completo HOY;
 *   · que el script le pregunte a `information_schema` y no se quede sólo con
 *     el mapa.
 *
 * Con MySQL (`MYSQL_PRUEBAS=1`) comprueba lo primero contra la base de
 * verdad. Sin MySQL, al menos lo segundo, leyendo el código.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { CLAVE_POR_TABLA, TABLAS } = require('../scripts/comparar-bases.js');

const HAY_MYSQL = process.env.MYSQL_PRUEBAS === '1';
const saltar = { skip: HAY_MYSQL ? false : 'requiere MySQL (MYSQL_PRUEBAS=1)' };

/* La base contra la que se mira. `decero` es el cargue desde cero que usan
   las pruebas de esquema; si no está, se dice en vez de pasar en falso. */
const BASE = process.env.MYSQL_BASE_ESQUEMA || 'decero';

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

test('el script pregunta la clave a la base, no sólo a la lista', () => {
  /* Lo esencial del arreglo. Si alguien vuelve a dejarlo apoyado sólo en el
     mapa, la décima tabla con clave compuesta repite el fallo entero. */
  const src = fs.readFileSync('scripts/comparar-bases.js', 'utf8');
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(codigo, /KEY_COLUMN_USAGE/,
    'ya no le pregunta a information_schema por la PRIMARY KEY');
  assert.match(codigo, /CONSTRAINT_NAME = 'PRIMARY'/);
  assert.match(codigo, /CLAVE_DE_LA_BASE\.get\(tabla\) \|\| CLAVE_POR_TABLA\[tabla\]/,
    'la base tiene que mandar sobre la lista escrita a mano');
});

test('ninguna tabla del catálogo se queda sin clave que exista', saltar, async () => {
  /* El fallo original, medido: para cada tabla que el comparador recorre, la
     clave por la que ordenaría tiene que ser de columnas que existan. */
  await conMysql(async (con) => {
    const [tablas] = await con.query(
      `SELECT TABLE_NAME t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [BASE]);
    assert.ok(tablas.length > 50,
      `la base ${BASE} no parece cargada (${tablas.length} tablas). ` +
      'Cárguela o ponga MYSQL_BASE_ESQUEMA.');

    const [cols] = await con.query(
      `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?`, [BASE]);
    const tiene = new Set(cols.map(f => `${f.t}.${f.c}`));

    const malas = [];
    for (const nombre of TABLAS) {
      if (!tablas.some(x => x.t === nombre)) continue;      // no está: otro asunto
      const clave = CLAVE_POR_TABLA[nombre] || ['id'];
      const faltan = clave.filter(c => !tiene.has(`${nombre}.${c}`));
      if (faltan.length) malas.push(`${nombre}: ordenaría por ${faltan.join(', ')}, que no existe`);
    }
    assert.deepEqual(malas, [],
      'el mapa escrito a mano se quedó atrás otra vez — y eso sale como ' +
      '«ERROR Unknown column \'id\'» y como «no se corta todavía»');
  });
});

test('el mapa coincide con la PRIMARY KEY de verdad', saltar, async () => {
  /* Lo de arriba comprueba que las columnas existan. Esto, que sean LAS de la
     clave primaria: ordenar por una columna que existe pero no es única
     empareja filas distintas entre sí, y eso no da error — da diferencias
     inventadas, o peor, iguales que no lo son. */
  await conMysql(async (con) => {
    const [filas] = await con.query(
      `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'
        ORDER BY TABLE_NAME, ORDINAL_POSITION`, [BASE]);
    const real = new Map();
    for (const f of filas) {
      if (!real.has(f.t)) real.set(f.t, []);
      real.get(f.t).push(f.c);
    }

    const malas = [];
    for (const [tabla, clave] of Object.entries(CLAVE_POR_TABLA)) {
      const pk = real.get(tabla);
      if (!pk) continue;                                    // tabla que ya no está
      if (JSON.stringify(pk) !== JSON.stringify(clave)) {
        malas.push(`${tabla}: el mapa dice [${clave}], la base dice [${pk}]`);
      }
    }
    assert.deepEqual(malas, []);
  });
});
