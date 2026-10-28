#!/usr/bin/env node
'use strict';

/* scripts/listo-para-datos.js — ¿se puede encender `DATOS_PROPIOS`?
 *
 *   node scripts/listo-para-datos.js
 *
 * Se corre EN EL SERVIDOR, con las variables del cPanel puestas, y antes de
 * tocar el interruptor. No escribe nada: se puede correr en producción y
 * cuantas veces haga falta.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────
 *
 * `comprobar-base.js` mira la base de identidad y la tabla `archivos`. Lo que
 * `DATOS_PROPIOS` necesita es otra cosa: las 84 tablas del volcado con sus
 * datos dentro, y una conexión que las lea bien.
 *
 * Y hace falta porque esta bandera no se parece a las otras dos:
 *
 *   · `AUTH_PROPIA` se apaga y las cuentas siguen en Supabase.
 *   · `ARCHIVOS_PROPIOS` se apaga y los archivos siguen en Supabase.
 *   · `DATOS_PROPIOS` se apaga y **lo que se escribió mientras estuvo
 *     encendida se queda en MySQL**. La costura devuelve un motor o el otro
 *     (`lib/supabase.js`), nunca los dos, así que Supabase no se entera de
 *     nada de lo que pase en esa ventana.
 *
 * Devolverse no es imposible —se vuelve a migrar al revés— pero tampoco es
 * quitar una variable. Por eso esto comprueba antes y no después.
 *
 * ── Lo que NO comprueba ──────────────────────────────────────────────────
 *
 * Que el adaptador conteste lo mismo que PostgREST. Eso es
 * `comparar-consultas.js`, necesita las dos bases a la vez y tarda. Aquí sólo
 * se mira que el lado de MySQL esté como tiene que estar.
 */

const mysql = require('../core/db/mysql.js');
const config = require('../core/config');

const datos = mysql.bd('datos');

/* Lo que tiene que haber, medido contra un cargue desde cero el 28-oct-2026.
   Si el esquema crece, estos números suben: se actualizan aquí, que es donde
   se mira, y no en un comentario de otro archivo. */
const ESPERADO = {
  tablas: 84,            // las del volcado; `archivos` va aparte
  columnas: 976,         // sólo de tablas base, sin vistas ni `archivos`
  claves: 182,
};

/* Los que impiden duplicados. No son de rendimiento: si falta alguno, la base
   acepta dos filas que no pueden existir a la vez. */
const UNICOS = [
  'catalogo_roles_slug_global_uidx',
  'sesion_inscripciones_email_uidx',
  'torneo_categorias_unica_raiz',
  'torneo_categorias_unica_hija',
  'espacio_reservas_una_viva',
  'ticket_puestos_token_idx',
  'derecho_consumo_unico',
];

/* Tablas que, si están vacías, quieren decir que el cargue no se hizo o se
   quedó a medias. Se eligen por ser las que SIEMPRE tienen filas en una
   instalación viva, no por ser las más grandes. */
const NO_PUEDEN_ESTAR_VACIAS = ['profiles', 'eventos', 'tickets', 'ticket_types', 'event_members'];

const malas = [], avisos = [];
const ok    = (t) => console.log(`  ✓ ${t}`);
const mal   = (t) => { console.log(`  ✗ ${t}`); malas.push(t); };
const aviso = (t) => { console.log(`  ⚠ ${t}`); avisos.push(t); };

async function main() {
  console.log('\n¿Está MySQL listo para DATOS_PROPIOS?\n');

  /* ── 1 · Que se pueda llegar ──────────────────────────────────────────*/
  if (!datos.configurada()) {
    mal('MySQL no está configurada: faltan MYSQL_HOST, MYSQL_USER o MYSQL_DATABASE');
    return terminar();
  }
  let base;
  try {
    base = (await datos.consultar('SELECT DATABASE() AS d'))[0].d;
    ok(`conecta con \`${base}\``);
  } catch (e) {
    mal(`no conecta: ${e.message}`);
    return terminar();
  }

  /* ── 2 · El juego de caracteres ───────────────────────────────────────
   * utf8mb3 no da ningún error: guarda las tildes mal y se descubre semanas
   * después, cuando alguien busca «Bogotá». */
  const [cs] = await datos.consultar(
    `SELECT DEFAULT_CHARACTER_SET_NAME c, DEFAULT_COLLATION_NAME col
       FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`);
  if (cs.c === 'utf8mb4') ok(`juego de caracteres ${cs.c} (${cs.col})`);
  else mal(`la base está en ${cs.c}, no en utf8mb4 — las tildes se guardan mal`);

  /* ── 3 · El esquema ───────────────────────────────────────────────────*/
  const [{ n: tablas }] = await datos.consultar(
    `SELECT COUNT(*) n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'archivos'`);
  tablas === ESPERADO.tablas
    ? ok(`${tablas} tablas del volcado`)
    : mal(`hay ${tablas} tablas y se esperan ${ESPERADO.tablas}`);

  const [{ n: columnas }] = await datos.consultar(
    `SELECT COUNT(*) n FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
            AND t.TABLE_TYPE = 'BASE TABLE'
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME <> 'archivos'`);
  columnas === ESPERADO.columnas
    ? ok(`${columnas} columnas`)
    : mal(`hay ${columnas} columnas y se esperan ${ESPERADO.columnas} — ` +
          'una tabla puede existir a medias y nada lo dice hasta que un INSERT la nombra');

  const [{ n: claves }] = await datos.consultar(
    `SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'`);
  claves === ESPERADO.claves
    ? ok(`${claves} claves ajenas`)
    : mal(`hay ${claves} claves ajenas y se esperan ${ESPERADO.claves}`);

  /* ── 4 · Los que impiden duplicados ───────────────────────────────────*/
  const hay = new Set((await datos.consultar(
    `SELECT DISTINCT INDEX_NAME i FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()`)).map(f => f.i));
  const faltan = UNICOS.filter(u => !hay.has(u));
  faltan.length
    ? mal(`faltan ${faltan.length} índices que impiden duplicados: ${faltan.join(', ')}`)
    : ok(`los ${UNICOS.length} índices que impiden duplicados`);

  /* ── 5 · Que haya datos ───────────────────────────────────────────────*/
  const vacias = [];
  for (const t of NO_PUEDEN_ESTAR_VACIAS) {
    try {
      const [{ n }] = await datos.consultar(`SELECT COUNT(*) n FROM \`${t}\``);
      if (!Number(n)) vacias.push(t);
    } catch { vacias.push(`${t} (no existe)`); }
  }
  vacias.length
    ? mal(`sin datos: ${vacias.join(', ')} — el cargue no se hizo o quedó a medias`)
    : ok('las tablas principales tienen datos');

  /* ── 6 · La hora ──────────────────────────────────────────────────────
   * Las fechas se guardaron en UTC. Si la conexión de la aplicación lee en
   * otra zona, todo sale corrido y ninguna consulta se queja. */
  const [{ z }] = await datos.consultar('SELECT @@session.time_zone z');
  const [{ d }] = await datos.consultar(
    "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) d");
  Number(d) === 0
    ? ok(`la conexión lee en UTC (time_zone = ${z})`)
    : mal(`la conexión va ${Number(d) / 3600} h fuera de UTC (time_zone = ${z}) — ` +
          'las fechas se guardaron en UTC y saldrían corridas');

  /* ── 7 · Que el adaptador cargue ──────────────────────────────────────*/
  try {
    const pg = require('../core/db/postgrest.js');
    const { sql } = pg.from('eventos').select('id').limit(1)._compilar();
    ok(`el adaptador compila (${sql})`);
  } catch (e) {
    mal(`el adaptador no carga: ${e.message}`);
  }

  /* ── 8 · Cómo está la bandera ahora ───────────────────────────────────*/
  console.log('');
  config.DATOS_PROPIOS
    ? console.log('  DATOS_PROPIOS ya está ENCENDIDA en este proceso.')
    : console.log('  DATOS_PROPIOS está apagada: las consultas van a Supabase.');

  /* Supabase todavía hace falta mientras AUTH_PROPIA esté apagada:
     `middleware/auth.js` le pregunta por cada token. */
  if (!config.AUTH_PROPIA && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)) {
    aviso('AUTH_PROPIA está apagada y faltan las variables de Supabase: ' +
          'el middleware no podrá verificar ningún token');
  }

  terminar();
}

function terminar() {
  console.log('');
  if (malas.length) {
    console.log(`🛑 ${malas.length} cosa(s) por resolver. NO encienda DATOS_PROPIOS todavía.\n`);
    process.exitCode = 1;
  } else if (avisos.length) {
    console.log(`⚠ Listo, con ${avisos.length} aviso(s). Léalos antes de encender.\n`);
  } else {
    console.log('✅ Todo en orden. Se puede encender DATOS_PROPIOS.\n');
    console.log('   Recuerde: con la bandera encendida, lo que se escriba va SÓLO a');
    console.log('   MySQL. Apagarla después no devuelve esos datos a Supabase.\n');
  }
  return mysql.cerrar();
}

main().catch(async (e) => {
  console.error(`\n🛑 ${e.message}\n`);
  await mysql.cerrar().catch(() => {});
  process.exit(1);
});
