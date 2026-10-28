#!/usr/bin/env node
'use strict';

/* scripts/volcar-datos.js — los datos de Supabase, en archivos `.sql`.
 *
 *   node scripts/volcar-datos.js --salida volcado/
 *   node scripts/volcar-datos.js --salida volcado/ --solo eventos,tickets
 *   node scripts/volcar-datos.js --salida volcado/ --trozo 2
 *
 * ── Si se corre detrás de un proxy ───────────────────────────────────────
 *
 * El `fetch` de Node NO lee `HTTPS_PROXY`, a diferencia de `curl`. Detrás de
 * un proxy hay que decírselo:
 *
 *   NODE_USE_ENV_PROXY=1 node scripts/volcar-datos.js --salida volcado/
 *
 * Sin eso sale un `HTTP 401 No API key found in request` que parece un
 * problema de credenciales y no lo es: la petición ni siquiera pasó por donde
 * se le añaden.
 *
 * ── Por qué existe, teniendo `migrar-datos.js` ───────────────────────────
 *
 * `migrar-datos.js` escribe directo en MySQL, y es lo que se quiere cuando se
 * puede llegar a la base. **Desde fuera del servidor no se puede:** el MySQL
 * del cPanel escucha en el 3306 y ese puerto no sale a internet. Medido el 27
 * de octubre de 2026 contra `162.214.73.93`: el 443 contesta, el 3306 no.
 *
 * La vía que sí existe es phpMyAdmin, que es HTTPS y acepta archivos. Así que
 * las mismas filas, en vez de ir por el cable, se escriben como `INSERT` y
 * alguien los sube.
 *
 * No es un apaño: es el mismo camino por el que ya pasaron el esquema y las
 * tres migraciones. Lo que cambia es el tamaño.
 *
 * ── De dónde salen las columnas ──────────────────────────────────────────
 *
 * De un MySQL **local** cuyo esquema sea igual al del destino. No es una
 * suposición: se comprobó tabla por tabla, columna por columna e índice por
 * índice que `gestek_datos` quedó idéntica a un cargue desde cero (84 tablas
 * más `archivos`, 182 claves ajenas, cero diferencias).
 *
 * Hace falta porque hay que saber DOS cosas que Supabase no dice:
 *
 *   · Qué columnas existen en MySQL. Una que esté en Supabase y no en MySQL
 *     no se puede insertar — y es pérdida de datos, así que se avisa.
 *   · Cuáles son GENERADAS. Escribir en una da `ER_NON_INSERTABLE_TABLE`, y
 *     son justo las que esta migración añadió (`espacio_activo`,
 *     `slug_global`, `titular_id`…).
 *
 * ── Las claves ajenas quedan ENCENDIDAS ──────────────────────────────────
 *
 * Apagarlas haría el cargue más rápido y dejaría entrar las filas huérfanas
 * sin decir nada. Una boleta sin evento no se nota hasta el día del evento,
 * en la puerta. Si algo sale con `ERROR 1452`, eso es el trabajo haciéndose.
 *
 * Por eso también el orden importa, y por eso las tres tablas que se apuntan a
 * sí mismas salen con los padres primero (ver `scripts/lib/volcado.js`).
 *
 * ── Lo que NO hace ───────────────────────────────────────────────────────
 *
 * · **No toca Supabase.** Sólo lee.
 * · **No toca MySQL.** Sólo le pregunta qué columnas tiene. Nada de escribir.
 * · **No migra las cuentas.** Los hashes viven en `auth.users`, que la API no
 *   expone; de eso se encarga `scripts/migrar-usuarios-a-mysql.js`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ORDEN = require('../db/orden-de-carga.json');
const { sentenciaInsert, ordenarPorPadre, Troceador } = require('./lib/volcado.js');
const { bd, cerrar } = require('../core/db/mysql.js');

/* Igual que en `migrar-datos.js`: respaldos de rollbacks viejos que existen en
   Supabase y no son del esquema. Lista explícita, no patrón: se revisa. */
const NO_SON_DEL_ESQUEMA = ['zz_rollback_0126b_entregar'];

const PAGINA = 1000;     // lo máximo que devuelve PostgREST de un viaje
const LOTE   = 200;      // filas por INSERT

/* ── La línea que no puede faltar en ningún archivo ──────────────────────
 *
 * PostgREST devuelve las fechas con su desfase: `2026-09-17T14:00:00+00:00`.
 * MySQL 8 entiende ese desfase y lo convierte **a la zona de la sesión**. Si
 * el servidor no está en UTC, cada fecha entra corrida.
 *
 * Medido: con `time_zone = '-05:00'` —la hora de Bogotá, que es lo normal en
 * un hosting colombiano— `14:00:00+00:00` se guarda como `09:00:00`. Cinco
 * horas de menos en la hora de inicio de cada evento, en cada compra y en cada
 * ingreso por la puerta. Sin aviso, sin error, y sin forma de notarlo mirando
 * una fila suelta: todas están igual de mal.
 *
 * `SET time_zone = '+00:00'` lo fija, vale sólo para esa sesión y no toca la
 * configuración del servidor.
 *
 * ── Y `SET NAMES utf8mb4`, por lo mismo ─────────────────────────────────
 *
 * Los archivos se escriben en UTF-8. Si el cliente que los carga declara otra
 * codificación, MySQL guarda los bytes reinterpretados: «Tecnología» entra
 * como «TecnologÃ­a». Medido cargando el volcado con el cliente por defecto:
 * 68 celdas de 4.887 salieron así — todas las que llevan tilde o eñe.
 *
 * No es «se ve raro en phpMyAdmin»: son los bytes que quedan guardados, y
 * salen igual de mal por la API, en los correos y en los PDF de las boletas.
 *
 * phpMyAdmin tiene un desplegable de codificación que suele venir en utf-8,
 * así que puede que no haga falta. Depender de que alguien no lo toque es
 * justo lo que no se quiere: la línea cuesta nada y cierra el caso.
 *
 * Las dos van en TODOS los trozos: cada archivo se sube por separado y
 * phpMyAdmin no garantiza que compartan sesión. */
const CABECERA_SESION = `\nSET NAMES utf8mb4;\nSET time_zone = '+00:00';\n\n`;

const args  = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valor = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const SALIDA = valor('--salida');
const SOLO   = (valor('--solo') || '').split(',').map(s => s.trim()).filter(Boolean);
/* En megas. phpMyAdmin suele aceptar bastante más, pero un archivo que no
   entra obliga a repetir todo el paso; uno de más sólo cuesta un clic. */
const TROZO  = Number(valor('--trozo') || 2) * 1024 * 1024;

function salir(m, c = 2) { console.error(`\n${m}\n`); process.exit(c); }

/* ── Leer de Supabase, por HTTP pelado ───────────────────────────────────
 *
 * No se usa `supabase-js` aquí, y es a propósito. Este script corre desde
 * fuera del servidor, donde la clave no está en una variable sino en un
 * secreto del entorno que un proxy inyecta como cabecera. `supabase-js` exige
 * una clave para construirse y manda la suya, que pisaría a la inyectada.
 *
 * Con `fetch` pelado: si `SUPABASE_SERVICE_KEY` está, se manda; si no está,
 * no se manda nada y el proxy pone lo suyo. Los dos sitios funcionan sin que
 * el script tenga que saber en cuál está. */
function cabeceras() {
  const k = process.env.SUPABASE_SERVICE_KEY;
  return k ? { apikey: k, Authorization: `Bearer ${k}` } : {};
}

async function* leerDeSupabase(url, tabla) {
  for (let desde = 0; ; desde += PAGINA) {
    const r = await fetch(`${url}/rest/v1/${tabla}?select=*`, {
      headers: { ...cabeceras(), Range: `${desde}-${desde + PAGINA - 1}`, Prefer: 'count=none' },
    });
    if (!r.ok) throw new Error(`leyendo ${tabla}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    if (!data.length) return;
    yield data;
    if (data.length < PAGINA) return;
  }
}

/* ── Qué columnas tiene MySQL, y cuáles no se pueden escribir ────────────
 *
 * Se pregunta por `GENERATION_EXPRESSION`, no por `EXTRA`. Mirar `EXTRA`
 * buscando «GENERATED» parece lo obvio y se lleva por delante las 204
 * columnas del esquema que tienen un `DEFAULT` con expresión, porque MySQL 8
 * las marca `DEFAULT_GENERATED`. El detalle está contado entero en
 * `scripts/migrar-datos.js`, que tenía el mismo fallo. */
async function columnasDe(base, tabla) {
  const filas = await base.consultar(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND (GENERATION_EXPRESSION IS NULL OR GENERATION_EXPRESSION = '')`, [tabla]);
  return new Set(filas.map(f => f.c));
}

/* ── Las tablas que se apuntan a sí mismas ───────────────────────────────
 *
 * Se preguntan, no se escriben a mano: una lista en el código se queda atrás
 * la primera vez que alguien añada un `parent_id` nuevo, y el fallo sería un
 * `ERROR 1452` a mitad de cargue meses después. */
async function seApuntanASiMismas(base) {
  const filas = await base.consultar(
    `SELECT k.TABLE_NAME t, k.COLUMN_NAME col, k.REFERENCED_COLUMN_NAME pk
       FROM information_schema.KEY_COLUMN_USAGE k
      WHERE k.TABLE_SCHEMA = DATABASE()
        AND k.REFERENCED_TABLE_NAME = k.TABLE_NAME`);
  return new Map(filas.map(f => [f.t, { padre: f.col, pk: f.pk }]));
}

/* ── main ────────────────────────────────────────────────────────────────*/
async function main() {
  if (!SALIDA) salir('Falta --salida <carpeta>. Ejemplo:\n  node scripts/volcar-datos.js --salida volcado/');

  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!url) salir('Falta SUPABASE_URL.');

  fs.mkdirSync(SALIDA, { recursive: true });
  const base = bd('datos');

  const tablas = (SOLO.length ? SOLO : ORDEN).filter(t => !NO_SON_DEL_ESQUEMA.includes(t));
  const auto = await seApuntanASiMismas(base);

  console.log(`Volcando ${tablas.length} tablas a ${SALIDA}/ …\n`);

  const avisos = [], resumen = [], archivos = [];
  let orden = 0;

  for (const tabla of tablas) {
    const enMysql = await columnasDe(base, tabla);
    if (!enMysql.size) { avisos.push(`${tabla}: no existe en MySQL — NO se vuelca`); continue; }

    orden += 1;
    const prefijo = String(orden).padStart(2, '0');
    let columnas = null, leidas = 0, acumulado = [];

    for await (const pagina of leerDeSupabase(url, tabla)) {
      leidas += pagina.length;
      if (!columnas) {
        const deSupabase = Object.keys(pagina[0]);
        columnas = deSupabase.filter(c => enMysql.has(c));
        const fuera = deSupabase.filter(c => !enMysql.has(c));
        if (fuera.length) avisos.push(`${tabla}: Supabase tiene ${fuera.join(', ')} y MySQL no — ESOS DATOS NO SE COPIAN`);
        if (!columnas.length) throw new Error(`\`${tabla}\`: ninguna columna coincide entre los dos lados`);
      }
      acumulado.push(...pagina);
    }

    if (!leidas) { resumen.push({ tabla, filas: 0 }); continue; }

    /* El orden dentro de la tabla, si se apunta a sí misma. */
    const a = auto.get(tabla);
    if (a) acumulado = ordenarPorPadre(acumulado, a.pk, a.padre);

    const t = new Troceador({
      limite: TROZO,
      cabecera: (n) => `-- ${tabla} · parte ${n} · ${leidas} filas en total\n`
                     + `-- Orden de carga: ${prefijo}. NO lo suba antes que los anteriores:\n`
                     + `-- las claves ajenas están encendidas y se lo dirán con ERROR 1452.\n`
                     + CABECERA_SESION,
      escribir: (n, txt) => {
        const nombre = `${prefijo}_${tabla}${n > 1 ? `_parte${n}` : ''}.sql`;
        fs.writeFileSync(path.join(SALIDA, nombre), txt);
        archivos.push(nombre);
      },
    });

    for (let i = 0; i < acumulado.length; i += LOTE) {
      t.añadir(sentenciaInsert(tabla, columnas, acumulado.slice(i, i + LOTE)));
    }
    t.cerrar();

    resumen.push({ tabla, filas: leidas });
    console.log(`  ✓ ${tabla.padEnd(28)} ${String(leidas).padStart(6)} filas`);
  }

  /* ── El archivo que comprueba ──────────────────────────────────────────
   * Sin esto, «parece que cargó» es todo lo que se sabe. Una tabla con 4.900
   * de 4.977 boletas no se nota mirando. */
  const conDatos = resumen.filter(r => r.filas > 0);
  const comprobar =
    `-- Se corre DESPUÉS de subir todos los demás.\n` +
    CABECERA_SESION.trimStart() +
    `-- La columna \`diferencia\` tiene que ser 0 en TODAS las filas.\n` +
    `-- Si alguna no lo es, esa tabla se quedó a medias: vuelva a subir sus\n` +
    `-- archivos tras vaciarla con DELETE FROM.\n\n` +
    conDatos.map(r =>
      `SELECT '${r.tabla}' AS tabla, ${r.filas} AS en_supabase,` +
      ` COUNT(*) AS en_mysql, COUNT(*) - ${r.filas} AS diferencia` +
      ` FROM \`${r.tabla}\``).join('\nUNION ALL\n') + ';\n';
  fs.writeFileSync(path.join(SALIDA, '99_comprobar.sql'), comprobar);
  archivos.push('99_comprobar.sql');

  /* ── El archivo que vacía ──────────────────────────────────────────────
   * En orden INVERSO: una tabla no se puede vaciar mientras otra la apunte. */
  const vaciar =
    `-- SÓLO si hay que repetir el cargue desde cero.\n` +
    `-- Va en orden inverso al de carga: una tabla no se puede vaciar\n` +
    `-- mientras otra todavía la apunte.\n\n` +
    [...conDatos].reverse().map(r => `DELETE FROM \`${r.tabla}\`;`).join('\n') + '\n';
  fs.writeFileSync(path.join(SALIDA, '00_vaciar.sql'), vaciar);

  /* ── El orden, por escrito ─────────────────────────────────────────────*/
  fs.writeFileSync(path.join(SALIDA, 'LEEME.txt'),
    `Suba los archivos POR NOMBRE, de menor a mayor. El número de delante es\n` +
    `el orden; sin él, las claves ajenas rechazan las filas con ERROR 1452.\n\n` +
    `  00_vaciar.sql    SÓLO si hay que repetir desde cero\n` +
    `  01_… a ${String(orden).padStart(2, '0')}_…     los datos, en orden de dependencias\n` +
    `  99_comprobar.sql al final: la columna diferencia debe dar 0 en todas\n\n` +
    `En phpMyAdmin: clic en gestek_datos -> pestaña Importar -> elegir archivo.\n` +
    `Uno por uno y en orden. No use la pestaña SQL para los grandes.\n\n` +
    archivos.join('\n') + '\n');

  const total = resumen.reduce((s, r) => s + r.filas, 0);
  console.log(`\n${total} filas en ${conDatos.length} tablas → ${archivos.length} archivos.`);
  if (avisos.length) console.warn('\n⚠ Avisos:\n' + avisos.map(a => `  · ${a}`).join('\n'));
  await cerrar();
}

/* Sólo corre si lo invocan directamente. Así `columnasDe` se puede probar
   contra un MySQL de verdad sin que requerir el archivo lance un volcado — y
   la prueba ejerce LA función, no una copia de su consulta pegada en el test,
   que es lo que dejaría volver el fallo de `DEFAULT_GENERATED` sin que nadie
   se entere. */
if (require.main === module) {
  main().catch(async (e) => {
    console.error(`\n🛑 ${e.message}\n`);
    await cerrar().catch(() => {});
    process.exit(1);
  });
}

module.exports = { columnasDe, seApuntanASiMismas };
