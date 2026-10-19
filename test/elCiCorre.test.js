/* Que el CI exista, y que corra lo que dice que corre.
 *
 * ── Por qué una prueba sobre el CI ───────────────────────────────────────
 *
 * Porque el fallo nunca fue que las pruebas fallaran: fue que **no se
 * corrían**. El flujo tenía un paso «Revisar codigo (Lint)» que invocaba
 * `npm run lint --if-present` cuando el script `lint` no existía, así que
 * llevaba desde el primer día pasando en verde sin mirar una sola línea.
 * `elLintExiste.test.js` cuenta qué se coló por ahí: un `ReferenceError` en
 * la rama de las boletas gratuitas que mataba el registro con un 500 después
 * de insertar la boleta.
 *
 * Arreglar el flujo no basta: hay que impedir que vuelva a aflojarse. Un
 * `--if-present` que alguien reponga «por si acaso», un `npm install` que
 * parece equivalente, un paso que se comenta para desatascar algo y se queda
 * comentado. Nada de eso avisa — el CI sigue saliendo verde.
 *
 * El repositorio del frontend tiene esta misma prueba
 * (`tests/elCiCorre.test.mjs`) por el mismo motivo y después de la misma
 * clase de susto. Ésta es su equivalente aquí.
 *
 * Correr: npm test */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r/g, '');

const FLUJO = leer('.github/workflows/ci-cd.yml');
const PKG = JSON.parse(leer('package.json'));

/* Sin los comentarios antes de medir.
 *
 * Este archivo explica el fallo CITANDO lo que estaba mal —`--if-present`,
 * `npm install`—, así que buscarlo en el texto entero lo encuentra siempre:
 * en su propia explicación. Es la misma trampa que `elLintExiste.test.js`
 * documenta, y que ya hizo fallar pruebas al escribirlas. */
const pasos = FLUJO.replace(/^\s*#.*$/gm, '');

test('`npm test` corre las pruebas de verdad', () => {
  /* Sin esto, el paso «Pruebas» del CI no ejecuta nada. */
  assert.ok(PKG.scripts?.test, 'no hay script `test` en package.json');
  assert.match(PKG.scripts.test, /node --test/);
  assert.match(PKG.scripts.test, /test\//);
});

test('el CI instala, revisa y prueba', () => {
  /* Los tres. Cada uno caza algo que el otro no: el lint caza la variable que
     no existe, y las pruebas cazan lo que sí compila y está mal —entre ellas
     la que pasa lista a las rutas sin permiso declarado. */
  for (const paso of ['npm ci', 'npm run lint', 'npm test']) {
    assert.ok(pasos.includes(paso), `el CI no corre «${paso}»`);
  }
});

test('y corre en los PR, no sólo al empujar a main', () => {
  /* Enterarse después de fusionar es enterarse tarde. */
  assert.match(pasos, /pull_request:/);
  assert.match(pasos, /push:/);
});

test('instala lo del lock, no lo que le parezca', () => {
  /* `npm install` puede resolver otras versiones y hacer que el CI pruebe algo
     distinto de lo que `.cpanel.yml` instala en el servidor. */
  assert.ok(pasos.includes('npm ci'));
  assert.ok(!/run:\s*npm install/.test(pasos), 'usa npm install en vez de npm ci');
});

test('ningún paso se salta cuando falta el script', () => {
  /* `--if-present` convierte un borrado accidental del script en un CI que
     pasa en verde sin comprobar nada. Los dos scripts existen —lo comprueban
     las pruebas de arriba—, así que no hace falta y no debe estar. */
  assert.ok(!pasos.includes('--if-present'), 'un script borrado pasaría en verde');
});

test('no hay un paso de despliegue que no despliegue', () => {
  /* El flujo tenía un trabajo «deploy» cuyo único paso era
     `echo "Aquí iría la conexión al servidor final"`. En la lista de checks de
     GitHub eso se ve igual que un despliegue de verdad.

     El backend se publica a mano desde cPanel con `.cpanel.yml`. Mientras eso
     siga siendo así, aquí no puede haber nada que aparente lo contrario. */
  assert.ok(!/echo .*(desplieg|servidor final)/i.test(pasos),
    'hay un paso que simula desplegar: o despliega de verdad, o no está');
});
