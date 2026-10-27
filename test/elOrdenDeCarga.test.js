'use strict';

/* El orden de carga tiene que respetar las 174 claves ajenas.
 *
 * `scripts/migrar-datos.js` carga las 84 tablas EN ORDEN y con las claves
 * ajenas ENCENDIDAS. Si una tabla se carga antes que su padre, MySQL rechaza
 * cada fila con `ER_NO_REFERENCED_ROW` y la carga se cae a la mitad — ruidoso,
 * pero a mitad de un corte, con el evento encima.
 *
 * ── Por qué el orden está en un archivo y no se calcula al vuelo ─────────
 *
 * Porque calcularlo necesita leer y parsear el esquema entero, y eso es
 * trabajo que no se puede hacer a medias un domingo a las once de la noche.
 * El archivo se mira, se revisa en un PR, y esta prueba comprueba que sigue
 * valiendo.
 *
 * ── Lo que pasa si alguien añade una clave ajena ─────────────────────────
 *
 * Que esta prueba se pone roja y dice qué tabla quedó antes que su padre. Sin
 * ella, el archivo se queda viejo en silencio y el fallo aparece el día de la
 * carga.
 *
 * Correr: npm test */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = (...p) => path.join(__dirname, '..', ...p);
const leer = (f) => fs.readFileSync(raiz(f), 'utf8');

const ORDEN = require('../db/orden-de-carga.json');

/* Las claves ajenas viven en DOS sitios: el volcado del esquema y las
   migraciones posteriores, que las declaran con el procedimiento
   `gestek_add_fk`. Mirar sólo el primero dejaría fuera las de `derechos` y
   `puerta_rechazos` — y ésas salieron «sin padres» la primera vez que se
   calculó el orden, justamente por eso. */
function clavesAjenas() {
  const fuentes = [
    'db/esquema/05_claves_foraneas.sql',
    'db/migraciones/005_al_dia.sql',
    'db/migraciones/006_torneo_calificacion_jurado.sql',
    'db/migraciones/007_derechos_y_credenciales.sql',
    'db/migraciones/008_la_puerta_y_la_tarjeta.sql',
  ];
  const pares = new Set();
  for (const f of fuentes) {
    const txt = leer(f);
    for (const m of txt.matchAll(/ALTER TABLE\s+`([a-z_]+)`[\s\S]*?FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+`([a-z_]+)`/gi)) {
      pares.add(`${m[1]}|${m[2]}`);
    }
    for (const m of txt.matchAll(/gestek_add_fk\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*'[^']*?REFERENCES\s+`?([a-z_]+)`?/gi)) {
      pares.add(`${m[1]}|${m[2]}`);
    }
  }
  return [...pares].map(p => p.split('|'));
}

function tablasDelEsquema() {
  const t = new Set([...leer('db/esquema/01_tablas.sql').matchAll(/^CREATE TABLE `([a-z_]+)`/gim)].map(m => m[1]));
  for (const f of ['006_torneo_calificacion_jurado', '007_derechos_y_credenciales', '008_la_puerta_y_la_tarjeta']) {
    for (const m of leer(`db/migraciones/${f}.sql`).matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`([a-z_]+)`/gi)) t.add(m[1]);
  }
  return t;
}

/* ── El orden ──────────────────────────────────────────────────────────── */

test('cada tabla va DESPUÉS de todas sus padres', () => {
  /* La prueba entera. Si una queda antes, MySQL rechaza sus filas con
     ER_NO_REFERENCED_ROW y la carga se cae a mitad del corte. */
  const posicion = new Map(ORDEN.map((t, i) => [t, i]));
  const malas = [];

  for (const [hijo, padre] of clavesAjenas()) {
    if (hijo === padre) continue;                       // autorreferencia: se resuelve sola
    if (!posicion.has(hijo) || !posicion.has(padre)) continue;
    if (posicion.get(hijo) < posicion.get(padre)) {
      malas.push(`${hijo} (puesto ${posicion.get(hijo)}) va ANTES que ${padre} (puesto ${posicion.get(padre)})`);
    }
  }

  assert.deepEqual(malas, [],
    'El orden de carga ya no respeta las claves ajenas. Regenérelo antes de cargar nada:\n' +
    malas.map(m => `  · ${m}`).join('\n'));
});

test('están TODAS las tablas del esquema, y ninguna de más', () => {
  /* Una tabla que falte en el orden no se carga: queda vacía y la base parece
     cargada. Una que sobre revienta la carga con «tabla desconocida». */
  const esperadas = tablasDelEsquema();
  const faltan = [...esperadas].filter(t => !ORDEN.includes(t)).sort();
  const sobran = ORDEN.filter(t => !esperadas.has(t)).sort();

  assert.deepEqual(faltan, [], `estas tablas no se cargarían: ${faltan.join(', ')}`);
  assert.deepEqual(sobran, [], `estas no existen en el esquema: ${sobran.join(', ')}`);
});

test('no hay tablas repetidas', () => {
  /* Una repetida se cargaría dos veces: la segunda vez la tabla ya no está
     vacía y el script se niega, o duplica. */
  const vistas = new Set();
  const repes = ORDEN.filter(t => vistas.size === vistas.add(t).size);
  assert.deepEqual(repes, [], `repetidas: ${repes.join(', ')}`);
});

test('las que no tienen padres van al principio', () => {
  /* Comprobación floja pero barata: `profiles` y `eventos` son de las que
     todo lo demás referencia. Si se fueran al final, algo se descuadró. */
  const posicion = new Map(ORDEN.map((t, i) => [t, i]));
  assert.ok(posicion.get('profiles') < posicion.get('eventos'),
    'los eventos referencian a los perfiles: profiles va antes');
  assert.ok(posicion.get('eventos') < posicion.get('tickets'),
    'las boletas referencian a los eventos');
  assert.ok(posicion.get('tickets') < posicion.get('ticket_interacciones'),
    'las interacciones referencian a las boletas');
});

/* ── El script ─────────────────────────────────────────────────────────── */

test('el script usa el cliente DE VERDAD, no la costura', () => {
  /* Con `DATOS_PROPIOS` encendida, `lib/supabase.js` devuelve el adaptador de
     MySQL: el script copiaría MySQL sobre MySQL y diría que todo cuadra. */
  const src = leer('scripts/migrar-datos.js');
  assert.match(src, /require\('\.\.\/lib\/supabaseCliente\.js'\)/);
  assert.doesNotMatch(src, /require\('\.\.\/lib\/supabase\.js'\)/);
});

test('el script NO apaga las claves ajenas', () => {
  /* Apagarlas haría la carga más rápida y dejaría pasar las filas huérfanas
     sin decir nada. Una boleta sin evento no se nota hasta la puerta. */
  const src = leer('scripts/migrar-datos.js');
  assert.doesNotMatch(src, /FOREIGN_KEY_CHECKS\s*=\s*0/i,
    'se apagaron las claves ajenas: las filas huérfanas pasarían calladas');
});

test('sin bandera, el script no escribe', () => {
  /* Ejecutarlo por error no puede cargar nada. */
  const src = leer('scripts/migrar-datos.js');
  assert.match(src, /if \(!SOLO_MIRAR && !VACIAR\)/,
    'el script dejó de exigir una bandera para escribir');
});

test('no se migra lo que no es del esquema', () => {
  /* `zz_rollback_0126b_entregar` es el respaldo de un rollback viejo: 114
     filas de basura que no deben llegar a la base nueva. */
  const src = leer('scripts/migrar-datos.js');
  assert.match(src, /zz_rollback_0126b_entregar/);
  assert.ok(!ORDEN.includes('zz_rollback_0126b_entregar'));
});
