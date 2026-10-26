/* Que el lado MySQL no se quede atrás del lado Postgres sin que nadie se entere.
 *
 * ── De dónde sale ────────────────────────────────────────────────────────
 *
 * De que ya pasó tres veces, y las tres se descubrieron a mano.
 *
 * `db/esquema/` es un VOLCADO: se genera leyendo Postgres y hay que
 * regenerarlo después de cada migración. Entre una regeneración y la
 * siguiente, cada migración nueva es una diferencia que la base MySQL no
 * tiene. Mientras eso no se note, no pasa nada; el día que alguien cargue el
 * volcado y arranque contra él, pasa todo junto.
 *
 * Y el modo de fallo de este proyecto no es un error: es el silencio.
 * `db/CAMINO-A.md` lo cuenta con la tabla `zonas`, que faltaba entera —
 * «cuatro pantallas en blanco, sin un solo error». `db/migraciones/007` lo
 * cuenta otra vez con los derechos: «el almuerzo no se puede entregar, la
 * acreditación del montaje no existe, y las pantallas salen vacías como si
 * nadie hubiera configurado nada».
 *
 * Contra eso no sirve acordarse. Sirve que el suite se ponga rojo el mismo
 * día que se abre el hueco, que es cuando cerrarlo cuesta diez minutos.
 *
 * ── Cómo se declara la cobertura ─────────────────────────────────────────
 *
 * Dos sitios, y los dos existían antes de esta prueba:
 *
 *   · `db/esquema/README.md` dice hasta qué migración se regeneró el volcado
 *     («hasta la migración `0128`»).
 *   · Cada archivo de `db/migraciones/` dice en su CABECERA qué migraciones
 *     de Postgres refleja. La 005 lo dice como rango («0092–0101») y la 007 y
 *     la 008 como lista («--   0129  el NIT de…»). Se entienden las dos.
 *
 * Sólo se mira la cabecera —el bloque de comentarios antes de la primera
 * sentencia— y no el archivo entero. Si se mirara entero, una migración
 * MENCIONADA de pasada en una nota contaría como cubierta, y esta prueba
 * pasaría en verde justo cuando más falta hace que no lo haga.
 *
 * Correr: npm test */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = (...p) => path.join(__dirname, '..', ...p);

/* Las migraciones de Postgres que existen, por su número. */
function migracionesPostgres() {
  return fs.readdirSync(raiz('db', 'migrations'))
    .map(f => /^(\d{4})_.*\.sql$/.exec(f))
    .filter(Boolean)
    .map(m => Number(m[1]))
    .sort((a, b) => a - b);
}

/* La cabecera: todo lo que va antes de la primera sentencia SQL. Vale para
   los dos estilos de comentario que hay en la carpeta (`--` y `/* *​/`). */
function cabecera(texto) {
  const lineas = texto.split('\n');
  const fin = lineas.findIndex(l => {
    const t = l.trim();
    return t !== '' && !t.startsWith('--') && !t.startsWith('*') && !t.startsWith('/*');
  });
  return (fin === -1 ? lineas : lineas.slice(0, fin)).join('\n');
}

/* Los números que una cabecera declara cubrir. Un rango `0092–0101` cuenta
   como los diez; una lista, como lo que diga. El guion puede ser el normal o
   el largo, que es el que usa la 005. */
function declaradas(texto) {
  const cab = cabecera(texto);
  const nums = new Set();

  for (const m of cab.matchAll(/\b(\d{4})\s*[–—-]\s*(\d{4})\b/g)) {
    for (let n = Number(m[1]); n <= Number(m[2]); n++) nums.add(n);
  }
  for (const m of cab.matchAll(/^--\s+(\d{4})\b/gm)) nums.add(Number(m[1]));

  return nums;
}

/* Hasta dónde llega el volcado, según su propio README. */
function volcadoCubreHasta() {
  const readme = fs.readFileSync(raiz('db', 'esquema', 'README.md'), 'utf8');
  const m = /hasta la migración `(\d{4})`/.exec(readme);
  return m ? Number(m[1]) : null;
}

test('el README del volcado dice hasta qué migración se regeneró', () => {
  /* Va aparte y primero: si esta línea se reformula, la prueba de abajo se
     quedaría sin su punto de partida y pasaría a comparar contra nada. Mejor
     que falle aquí, diciendo exactamente qué frase hay que mantener, que
     ponerse verde por no tener con qué comparar. */
  assert.ok(
    volcadoCubreHasta(),
    'db/esquema/README.md tiene que decir «hasta la migración `NNNN`»: es de donde sale ' +
    'hasta dónde llega el volcado. Si se regeneró, actualizá ese número.'
  );
});

test('ninguna migración de Postgres se queda sin su lado MySQL', () => {
  const hasta = volcadoCubreHasta();

  const cubiertas = new Set();
  for (const f of fs.readdirSync(raiz('db', 'migraciones')).filter(f => f.endsWith('.sql'))) {
    for (const n of declaradas(fs.readFileSync(raiz('db', 'migraciones', f), 'utf8'))) {
      cubiertas.add(n);
    }
  }

  const huerfanas = migracionesPostgres()
    .filter(n => n > hasta && !cubiertas.has(n));

  assert.deepEqual(
    huerfanas, [],
    `Hay migraciones de Postgres posteriores al volcado (${String(hasta).padStart(4, '0')}) que ningún ` +
    `archivo de db/migraciones/ dice reflejar: ${huerfanas.map(n => String(n).padStart(4, '0')).join(', ')}.\n` +
    'Cargar MySQL así deja una base a la que le faltan esas columnas o tablas, y no avisa: ' +
    'las pantallas salen vacías como si nadie hubiera configurado nada.\n' +
    'Se cierra de una de dos formas: regenerando el volcado (db/esquema/generar-esquema.mjs, ' +
    'y actualizando su README) o escribiendo el archivo que falta en db/migraciones/, ' +
    'con las migraciones listadas en su cabecera como hacen la 007 y la 008.'
  );
});

test('la cabecera es lo único que cuenta como declaración', () => {
  /* El corazón de la prueba de arriba, comprobado aparte porque si esto se
     rompiera, aquélla seguiría en verde sin mirar nada.

     Una migración nombrada en el CUERPO —una nota explicando por qué algo no
     se traduce, por ejemplo— no está cubierta por el hecho de nombrarse. */
  const conCuerpo = [
    '-- 009 · Prueba',
    '--',
    '--   0140  algo que sí refleja',
    '',
    'CALL gestek_add_col(\'t\', \'c\', "INT NULL");',
    '-- 0141 se menciona aquí abajo pero NO se refleja.',
  ].join('\n');

  const nums = declaradas(conCuerpo);
  assert.ok(nums.has(140), 'lo listado en la cabecera tiene que contar');
  assert.ok(!nums.has(141), 'lo nombrado en el cuerpo NO puede contar como cubierto');
});

test('un rango de la cabecera cuenta como todas las que abarca', () => {
  /* Es como lo declara la 005 («0092–0101»), con guion largo. */
  const nums = declaradas(' * aplicaron diez migraciones en Supabase (0092–0101) y el volcado\n * se quedó atrás.\n');
  assert.equal(nums.size, 10);
  assert.ok(nums.has(92) && nums.has(101) && nums.has(97));
});
