'use strict';

/* El cableado de `DATOS_PROPIOS`: qué contesta a las 1.152 llamadas.
 *
 * Una línea en `lib/supabase.js` decide si `supabase.from(...)` habla con
 * PostgREST o con MySQL. Lo que se prueba aquí es esa línea y las tres cosas
 * que, si se hacen mal, no dan error el día que se enciende la bandera:
 *
 *   1. Que con la bandera APAGADA siga siendo Supabase. Es el estado de hoy y
 *      el sitio al que se vuelve si algo sale mal.
 *   2. Que `middleware/auth.js` NO pase por la costura. Llama a
 *      `supabase.auth.getUser()` mientras `AUTH_PROPIA` esté apagada, y el
 *      adaptador lanza ahí a propósito: si pasara por la costura, encender
 *      `DATOS_PROPIOS` dejaría sin login TODAS las peticiones.
 *   3. Que los comparadores tampoco. Si cogieran la costura con la bandera
 *      encendida, compararían el adaptador CONTRA SÍ MISMO y dirían que todo
 *      cuadra — el informe más peligroso de los tres.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const raiz = (...p) => path.join(__dirname, '..', ...p);
const fuente = (f) => fs.readFileSync(raiz(f), 'utf8');

/* Cargar `lib/supabase.js` con la bandera en una posición u otra. `core/config`
   lee el entorno al cargarse, así que hay que olvidar los dos del caché. */
function conBandera(encendida, fn) {
  const antes = process.env.DATOS_PROPIOS;
  const olvidar = ['../core/config', '../core/config/index.js', '../lib/supabase.js',
                   '../core/db/postgrest.js', '../lib/supabaseCliente.js'];
  const limpiar = () => { for (const m of olvidar) { try { delete require.cache[require.resolve(m)]; } catch { /* no estaba */ } } };

  if (encendida) process.env.DATOS_PROPIOS = 'true'; else delete process.env.DATOS_PROPIOS;
  limpiar();
  try { return fn(require('../lib/supabase.js')); }
  finally {
    if (antes === undefined) delete process.env.DATOS_PROPIOS; else process.env.DATOS_PROPIOS = antes;
    limpiar();
  }
}

/* ── La costura ────────────────────────────────────────────────────────── */

test('con la bandera APAGADA, las consultas siguen yendo a Supabase', () => {
  /* El estado de hoy, y el sitio al que se vuelve si algo sale mal. */
  conBandera(false, (s) => {
    assert.equal(typeof s.from, 'function');
    assert.equal(s._compilarConteo, undefined, 'devolvió el adaptador con la bandera apagada');
    assert.equal(typeof s.auth, 'object', 'el cliente de verdad tiene `.auth`');
  });
});

test('con la bandera ENCENDIDA, las consultas van a MySQL', () => {
  conBandera(true, (s) => {
    assert.equal(typeof s.from, 'function');
    assert.equal(typeof s._compilarConteo, 'function', 'no devolvió el adaptador');
  });
});

test('el adaptador LANZA si alguien le pide .auth o .storage', () => {
  /* Son otras dos banderas. Que lance es lo que hace que un cableado mal hecho
     salte en vez de devolver algo a medias. */
  conBandera(true, (s) => {
    assert.throws(() => s.auth,    (e) => e.code === 'PGRST_NO_SOPORTADO' && /AUTH_PROPIA/.test(e.message));
    assert.throws(() => s.storage, (e) => e.code === 'PGRST_NO_SOPORTADO' && /ARCHIVOS_PROPIOS/.test(e.message));
  });
});

/* ── Quién NO puede pasar por la costura ───────────────────────────────── */

test('middleware/auth.js pide el cliente DE VERDAD, no la costura', () => {
  /* Si pidiera `lib/supabase.js`, encender `DATOS_PROPIOS` dejaría sin
     `.auth` a todas las peticiones mientras `AUTH_PROPIA` siga apagada — o
     sea, nadie podría entrar. Se comprueba sobre el texto porque lo que se
     vigila es de dónde lo pide, no qué hace con ello. */
  const src = fuente('middleware/auth.js');
  assert.match(src, /require\('\.\.\/lib\/supabaseCliente\.js'\)/,
    'middleware/auth.js ya no pide el cliente de verdad');
  assert.doesNotMatch(src, /require\('\.\.\/lib\/supabase\.js'\)/,
    'middleware/auth.js volvió a pasar por la costura de datos');
});

test('los dos comparadores piden el cliente DE VERDAD', () => {
  /* Con la bandera encendida, la costura devuelve el adaptador: un comparador
     que la usara compararía MySQL contra MySQL y diría que todo cuadra. */
  for (const f of ['scripts/comparar-consultas.js', 'scripts/comparar-bases.js']) {
    const src = fuente(f);
    assert.match(src, /require\('\.\.\/lib\/supabaseCliente\.js'\)/, `${f} no pide el cliente de verdad`);
    assert.doesNotMatch(src, /require\('\.\.\/lib\/supabase\.js'\)/, `${f} pasa por la costura: compararía contra sí mismo`);
  }
});

test('nadie más pide supabaseCliente a sus espaldas', () => {
  /* El cliente de verdad es para el login y los comparadores. Si una ruta lo
     pidiera, se saltaría la costura y seguiría hablando con Supabase el día
     del corte — sin error, y sin que nadie lo note hasta que los datos de esa
     ruta estén viejos. */
  function archivos(dir) {
    const out = [];
    for (const e of fs.readdirSync(raiz(dir), { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...archivos(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
    return out;
  }
  const PERMITIDOS = ['middleware/auth.js', 'lib/supabase.js'];
  const culpables = ['lib', 'routes', 'modules', 'core', 'middleware']
    .flatMap(archivos)
    .filter(f => /require\([^)]*supabaseCliente/.test(fuente(f)))
    .filter(f => !PERMITIDOS.includes(f.replace(/\\/g, '/')));

  assert.deepEqual(culpables, [],
    'Estos piden el cliente de Supabase saltándose la costura. El día del corte\n' +
    'seguirían leyendo de Supabase mientras el resto lee de MySQL, sin un solo error.\n' +
    culpables.map(c => `  · ${c}`).join('\n'));
});

/* ── El cliente de verdad se crea tarde ────────────────────────────────── */

test('requerir el cliente NO lo crea ni exige las variables', () => {
  /* Antes esto hacía `process.exit(1)` al importar si faltaban. Cuando las
     tres banderas estén encendidas, Supabase ya no hará falta y un `exit` al
     arrancar dejaría la aplicación sin levantar por una variable que ya nadie
     usa. */
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete require.cache[require.resolve('../lib/supabaseCliente.js')];
  try {
    const c = require('../lib/supabaseCliente.js');
    assert.ok(c, 'requerirlo sin variables tiene que poder hacerse');
    /* Y al usarlo de verdad, lanza con un mensaje que dice qué falta. */
    assert.throws(() => c.from, /SUPABASE_URL o SUPABASE_SERVICE_KEY/);
  } finally {
    process.env.SUPABASE_URL = url;
    process.env.SUPABASE_SERVICE_KEY = key;
    delete require.cache[require.resolve('../lib/supabaseCliente.js')];
  }
});

test('el cliente de verdad conserva `.auth` y ata sus funciones', () => {
  /* El Proxy existe para no crear el cliente al importar. Si no atara las
     funciones, un `const { from } = require(...)` perdería el `this` y
     supabase-js fallaría por dentro con un error que no diría nada. */
  delete require.cache[require.resolve('../lib/supabaseCliente.js')];
  const c = require('../lib/supabaseCliente.js');
  assert.equal(typeof c.from, 'function');
  assert.equal(typeof c.auth.getUser, 'function');
  const { from } = c;
  assert.doesNotThrow(() => from('eventos'), 'la función perdió su `this`');
});
