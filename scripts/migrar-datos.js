#!/usr/bin/env node
'use strict';

/* scripts/migrar-datos.js — pasa los datos de Supabase a MySQL.
 *
 *   node scripts/migrar-datos.js --comprobar      # sólo mira, no escribe
 *   node scripts/migrar-datos.js --vaciar         # carga de verdad
 *   node scripts/migrar-datos.js --solo eventos,tickets
 *
 * ── Por qué este script existe y `generar-datos.mjs` no basta ────────────
 *
 * `db/migraciones/CARGA-DE-DATOS.md` dice que los datos se sacan con
 * `generar-datos.mjs`, que pide `PG_URL` — la contraseña de la base de
 * Supabase. Esa contraseña no la tiene nadie en el equipo, y cambiarla sería
 * tocar producción para una tarea de lectura.
 *
 * Pero no hace falta: `SUPABASE_SERVICE_KEY` **ya está configurada en el
 * cPanel** (el backend la usa en cada petición), y con ella se lee todo por la
 * API. Así que esto corre EN EL SERVIDOR, donde las dos credenciales ya viven,
 * y los datos no pasan por el portátil de nadie.
 *
 * ── Lo que se protege, y es lo mismo de siempre ──────────────────────────
 *
 * **Los UUID se conservan exactamente.** Están referenciados por 174 claves
 * ajenas. Un UUID nuevo no es «la misma fila con otro identificador»: es una
 * boleta que perdió su evento.
 *
 * Por eso se carga **en orden de dependencias** (`db/orden-de-carga.json`) y
 * con las claves ajenas ENCENDIDAS. Apagarlas haría la carga más rápida y
 * dejaría pasar las filas huérfanas sin decir nada — y una boleta huérfana no
 * se nota hasta el día del evento, en la puerta.
 *
 * ── Lo que NO hace ───────────────────────────────────────────────────────
 *
 * · **No toca Supabase.** Sólo lee.
 * · **No migra las cuentas.** Los hashes viven en `auth.users`, que la API no
 *   expone; de eso se encarga `scripts/migrar-usuarios-a-mysql.js`.
 * · **No carga sobre una base con datos.** Sin `--vaciar` se niega: cargar
 *   encima de una carga de prueba deja las filas viejas mezcladas con las
 *   nuevas y nadie sabe cuáles son cuáles.
 */

const ORDEN = require('../db/orden-de-carga.json');

/* Tablas que existen en Supabase y NO son del esquema: respaldos de rollbacks
   viejos y cosas de trabajo. Migrarlas sería llevarse basura a la base nueva.
   Se nombran una a una, no por patrón: una lista explícita se revisa. */
const NO_SON_DEL_ESQUEMA = ['zz_rollback_0126b_entregar'];

/* Cuántas filas se piden por viaje. PostgREST devuelve 1.000 como mucho. */
const PAGINA = 1000;
/* Cuántas filas por INSERT. Ni una a una (lento) ni todas (paquete enorme). */
const LOTE = 200;

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valor = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const SOLO_MIRAR = tiene('--comprobar');
const VACIAR     = tiene('--vaciar');
const SOLO       = (valor('--solo') || '').split(',').map(s => s.trim()).filter(Boolean);

function salir(mensaje, codigo = 2) { console.error(`\n${mensaje}\n`); process.exit(codigo); }

/* El cliente DE VERDAD, no la costura: si `DATOS_PROPIOS` estuviera encendida,
   `lib/supabase.js` devolvería el adaptador de MySQL y este script copiaría
   MySQL sobre MySQL. */
const supabase = require('../lib/supabaseCliente.js');
const { bd, cerrar } = require('../core/db/mysql.js');
const base = bd('datos');

/* ── Los valores ─────────────────────────────────────────────────────────
 *
 * Los arrays y los objetos van a columnas JSON y se pasan como texto. Lo
 * demás viaja tal cual: mysql2 sabe escribir fechas, números y booleanos.
 * Un `null` se queda `null` — la diferencia entre «no contestó» y «contestó
 * vacío» es justo lo que no se puede perder. */
function valorParaMysql(v) {
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return JSON.stringify(v);
  }
  return v;
}

/* ── Las columnas de MySQL ───────────────────────────────────────────────
 *
 * Se insertan SÓLO las columnas que existen en MySQL. Pero una columna que
 * Supabase tiene y MySQL no es PÉRDIDA DE DATOS, así que no se calla: se
 * cuenta y se avisa al final, con nombre. */
async function columnasDe(tabla) {
  const filas = await base.consultar(
    `SELECT COLUMN_NAME AS c, EXTRA AS extra FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [tabla]);
  /* Las columnas generadas (VIRTUAL/STORED) no se pueden escribir: MySQL da
     ER_NON_INSERTABLE_TABLE si se intenta. Las calcula él. */
  return new Set(filas.filter(f => !/GENERATED/i.test(f.extra || '')).map(f => f.c));
}

/* ── Leer una tabla de Supabase, por páginas ─────────────────────────────*/
async function* leerDeSupabase(tabla) {
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase.from(tabla).select('*').range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`leyendo ${tabla}: ${error.message}`);
    if (!data?.length) return;
    yield data;
    if (data.length < PAGINA) return;
  }
}

/* ── Escribir un lote ────────────────────────────────────────────────────*/
async function escribirLote(tabla, columnas, filas) {
  const lista = columnas.map(c => `\`${c}\``).join(', ');
  const tupla = `(${columnas.map(() => '?').join(', ')})`;
  const params = [];
  for (const fila of filas) for (const c of columnas) params.push(valorParaMysql(fila[c] ?? null));
  await base.consultar(
    `INSERT INTO \`${tabla}\` (${lista}) VALUES ${filas.map(() => tupla).join(', ')}`, params);
}

/* ── Una tabla ───────────────────────────────────────────────────────────*/
async function migrarTabla(tabla, aviso) {
  const enMysql = await columnasDe(tabla);
  if (!enMysql.size) return { tabla, estado: 'sin tabla en MySQL', leidas: 0, escritas: 0 };

  const yaHay = Number((await base.consultar(`SELECT COUNT(*) n FROM \`${tabla}\``))[0].n);
  if (yaHay && !VACIAR && !SOLO_MIRAR) {
    throw new Error(`\`${tabla}\` ya tiene ${yaHay} filas. Use --vaciar si quiere reemplazarlas.`);
  }
  if (yaHay && VACIAR && !SOLO_MIRAR) await base.consultar(`DELETE FROM \`${tabla}\``);

  let leidas = 0, escritas = 0, columnas = null;
  for await (const pagina of leerDeSupabase(tabla)) {
    leidas += pagina.length;

    if (!columnas) {
      const deSupabase = Object.keys(pagina[0]);
      columnas = deSupabase.filter(c => enMysql.has(c));
      const huerfanas = deSupabase.filter(c => !enMysql.has(c));
      if (huerfanas.length) aviso.push(`${tabla}: Supabase tiene ${huerfanas.join(', ')} y MySQL no — ESOS DATOS NO SE COPIAN`);
      if (!columnas.length) throw new Error(`\`${tabla}\`: ninguna columna coincide entre los dos lados`);
    }

    if (SOLO_MIRAR) continue;
    for (let i = 0; i < pagina.length; i += LOTE) {
      await escribirLote(tabla, columnas, pagina.slice(i, i + LOTE));
      escritas += Math.min(LOTE, pagina.length - i);
    }
  }
  return { tabla, estado: 'ok', leidas, escritas };
}

/* ── main ────────────────────────────────────────────────────────────────*/
async function main() {
  if (!SOLO_MIRAR && !VACIAR) {
    salir('Esto ESCRIBE en MySQL. Use --comprobar para sólo mirar, o --vaciar para cargar de verdad.');
  }

  const tablas = (SOLO.length ? SOLO : ORDEN).filter(t => !NO_SON_DEL_ESQUEMA.includes(t));

  /* La puerta: todas las tablas del esquema tienen que existir ANTES de
     empezar. Cargar a medias deja la base con unas tablas llenas y otras
     vacías, y eso parece una carga buena. */
  const existen = new Set((await base.consultar(
    `SELECT TABLE_NAME c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`)).map(f => f.c));
  const faltan = tablas.filter(t => !existen.has(t));
  if (faltan.length) {
    salir(`Faltan ${faltan.length} tablas en MySQL. Corra el esquema y las migraciones primero:\n` +
          faltan.map(t => `  · ${t}`).join('\n'));
  }

  console.log(`${SOLO_MIRAR ? 'COMPROBANDO' : 'CARGANDO'} ${tablas.length} tablas…\n`);

  const aviso = [], resumen = [];
  for (const t of tablas) {
    const r = await migrarTabla(t, aviso);
    resumen.push(r);
    if (r.leidas) {
      console.log(`  ${SOLO_MIRAR ? '·' : '✓'} ${t.padEnd(28)} ${String(r.leidas).padStart(6)} filas`);
    }
  }

  /* ── La comprobación ───────────────────────────────────────────────────
   * Contar al final y comparar con lo leído. Si no cuadra, algo se quedó por
   * el camino: y una tabla con 4.900 de 4.977 boletas no se nota mirando. */
  if (!SOLO_MIRAR) {
    console.log('\nComprobando…');
    const malas = [];
    for (const r of resumen) {
      if (r.estado !== 'ok') continue;
      const n = Number((await base.consultar(`SELECT COUNT(*) n FROM \`${r.tabla}\``))[0].n);
      if (n !== r.leidas) malas.push(`${r.tabla}: leídas ${r.leidas}, quedaron ${n}`);
    }
    if (malas.length) {
      console.error('\n🛑 NO cuadra:\n' + malas.map(m => `  · ${m}`).join('\n'));
      await cerrar();
      process.exit(1);
    }
    console.log('  todas las tablas cuadran.');
  }

  if (aviso.length) {
    console.warn('\n⚠ Avisos:\n' + aviso.map(a => `  · ${a}`).join('\n'));
  }

  const total = resumen.reduce((s, r) => s + r.leidas, 0);
  console.log(`\n${total} filas en ${resumen.filter(r => r.leidas).length} tablas.`);
  if (SOLO_MIRAR) console.log('No se escribió nada. Para cargar de verdad: --vaciar');
  await cerrar();
}

main().catch(async (e) => {
  console.error(`\n🛑 ${e.message}\n`);
  await cerrar().catch(() => {});
  process.exit(1);
});
