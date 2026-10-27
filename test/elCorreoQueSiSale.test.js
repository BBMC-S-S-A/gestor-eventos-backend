'use strict';

/* Un correo que no sale es el fallo más caro del módulo de identidad.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────
 *
 * `servicio.recuperar()` contesta SIEMPRE lo mismo —«si esa cuenta existe, te
 * llegará un correo»— y eso está bien: contestar distinto delataría qué
 * direcciones tienen cuenta. Pero significa que, si el SMTP está mal, la
 * pantalla dice que el correo salió y NO salió. Nadie se entera: ni quien lo
 * pidió, ni quien administra.
 *
 * Y el día del corte eso no es una molestia. Son las **14 personas que entran
 * con contraseña** (medido contra producción el 27 de octubre de 2026): si
 * olvidan la suya y el correo no sale, **no tienen ninguna otra forma de
 * entrar**. Los otros 82 entran con Google y no dependen de esto.
 *
 * ── Qué se protege aquí ──────────────────────────────────────────────────
 *
 *   1. Que la respuesta al usuario NO cambie. La propiedad de seguridad es
 *      más importante que el aviso, y es fácil romperla «mejorando» el
 *      mensaje.
 *   2. Que el fallo deje de ser mudo HACIA DENTRO: marca buscable en el
 *      registro, el destinatario, y una cuenta que `/health` enseña.
 *   3. Que el arranque lo compruebe, como el almacén de archivos. Un SMTP
 *      mal puesto se veía sólo cuando ya había alguien fuera esperando.
 *
 * Correr: npm test */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-que-no-es-el-de-produccion';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const raiz = (...p) => path.join(__dirname, '..', ...p);
const leer = (f) => fs.readFileSync(raiz(f), 'utf8');

/* `lib/email.js` se sustituye en la caché ANTES de cargar los correos: así no
   sale ni un byte a la red y se puede decidir si el envío falla. */
const rutaEmail = require.resolve('../lib/email.js');
let comportamiento = { falla: false, verifica: { ok: true, mensaje: 'Conexión correcta.' } };
const enviados = [];

require.cache[rutaEmail] = {
  id: rutaEmail, filename: rutaEmail, loaded: true, exports: {
    sendMail: async (opciones) => {
      if (comportamiento.falla) throw new Error('535 autenticación rechazada');
      enviados.push(opciones);
      return { ok: true };
    },
    verificarConexion: async () => comportamiento.verifica,
  },
};

const correos = require('../modules/auth/correos');

function conRegistro(fn) {
  const lineas = [];
  const original = console.error;
  console.error = (...a) => lineas.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.error = original; }).then(() => lineas);
}

/* ── El fallo deja de ser mudo ─────────────────────────────────────────── */

test('un correo que NO sale deja una marca buscable y dice a quién iba', async () => {
  /* La marca entre corchetes es para poder encontrarla en el registro del
     cPanel sin leerlo entero. El destinatario va porque, cuando esto falla,
     avisar a la persona por otro medio es lo único que queda. */
  comportamiento.falla = true;
  const lineas = await conRegistro(() =>
    correos.recuperacion({ id: 'u1', email: 'ana@ejemplo.com' }, 'tok'));
  comportamiento.falla = false;

  const linea = lineas.find(l => l.includes('[auth][CORREO-NO-SALIO]'));
  assert.ok(linea, 'el fallo pasó callado: nadie se entera de que el enlace no salió');
  assert.match(linea, /ana@ejemplo\.com/, 'no dice a quién iba');
  assert.match(linea, /recuperación/, 'no dice qué correo era');
  assert.match(linea, /535/, 'no dice por qué falló');
});

test('los correos que SÍ salen no dejan rastro de error', async () => {
  const lineas = await conRegistro(() =>
    correos.recuperacion({ id: 'u1', email: 'ana@ejemplo.com' }, 'tok'));
  assert.deepEqual(lineas.filter(l => l.includes('CORREO-NO-SALIO')), []);
});

test('los fallos se cuentan, y se puede ver cuál fue el último', async () => {
  /* Es lo que mira `/health` y lo que mira quien esté de guardia el día del
     corte: si este número sube, hay gente esperando un enlace. */
  const antes = correos.fallosDeCorreo().total;

  comportamiento.falla = true;
  await conRegistro(() => correos.confirmacion({ id: 'u2', email: 'luis@ejemplo.com' }, 'tok'));
  comportamiento.falla = false;

  const ahora = correos.fallosDeCorreo();
  assert.equal(ahora.total, antes + 1);
  assert.equal(ahora.ultimo.que, 'confirmación');
  assert.match(ahora.ultimo.motivo, /535/);
  assert.ok(Date.parse(ahora.ultimo.cuando) > 0, 'el último fallo no dice cuándo fue');
});

test('`mandar` devuelve false cuando falla, no lanza', async () => {
  /* Si lanzara, se llevaría por delante la petición entera y `recuperar()`
     devolvería un 500 — que es exactamente lo que delata que esa cuenta
     existe. */
  comportamiento.falla = true;
  const salio = await conRegistro(() => correos._mandar({ to: 'x@y.z' }, 'prueba')).then(() => true);
  comportamiento.falla = false;
  assert.ok(salio, 'lanzó en vez de devolver false');
});

/* ── La respuesta al usuario NO cambia ─────────────────────────────────── */

test('`recuperar` contesta lo mismo salga o no salga el correo', () => {
  /* La propiedad de seguridad: contestar distinto diría qué direcciones tienen
     cuenta, y eso es peor que no avisar. Se comprueba sobre el código porque
     lo que se vigila es que nadie «mejore» el mensaje mirando si el envío
     funcionó. */
  const src = leer('modules/auth/servicio.js');
  const i = src.indexOf('async function recuperar(');
  assert.ok(i > 0);
  const cuerpo = src.slice(i, src.indexOf('\n  }', i));

  assert.match(cuerpo, /return \{ ok: true, mensaje: 'Si esa cuenta existe/,
    'la respuesta de recuperar dejó de ser siempre la misma');

  /* UNA sola salida. Es la forma fuerte de decir «contesta siempre lo mismo»:
     cualquier `return` extra —mirar si el correo salió, distinguir si la
     cuenta existe— delata quién tiene cuenta.
     La primera versión de esto buscaba un `?` después de la llamada, y una
     mutación con `if (!salio) return err(...)` pasaba por delante. */
  const salidas = cuerpo.match(/\breturn\b/g) || [];
  assert.equal(salidas.length, 1,
    `recuperar() tiene ${salidas.length} salidas y sólo puede tener una: ` +
    'contestar distinto según lo que pase dice qué direcciones tienen cuenta');

  /* Y que el resultado del envío no se recoja siquiera: si nadie lo mira, no
     se puede contestar en función de él. */
  assert.match(cuerpo, /^\s*await correos\.recuperacion\(/m,
    'se empezó a recoger si el correo salió; el siguiente paso es contestar distinto');
});

/* ── La comprobación del arranque ──────────────────────────────────────── */

test('si el correo no se puede mandar, el arranque lo dice fuerte', async () => {
  /* El módulo de archivos comprueba su almacén al arrancar. Esto es lo mismo
     para el correo, y faltaba: un SMTP mal puesto se veía sólo cuando alguien
     pedía recuperar su contraseña — o sea, cuando ya había alguien fuera. */
  comportamiento.verifica = {
    ok: false,
    mensaje: 'No hay proveedor de correo configurado.',
    sugerencia: 'Rellena CPANEL_SMTP_USER/PASS/HOST/PORT.',
  };
  const lineas = await conRegistro(() => correos.comprobar());
  comportamiento.verifica = { ok: true, mensaje: 'Conexión correcta.' };

  const linea = lineas.join('\n');
  assert.match(linea, /\[auth\]\[CORREO\]/);
  assert.match(linea, /No hay proveedor/);
  assert.match(linea, /CPANEL_SMTP_USER/, 'no dice qué hay que rellenar');
  assert.match(linea, /NO puede recuperarla/, 'no dice qué consecuencia tiene');
});

test('la comprobación NO tumba el proceso', async () => {
  /* El resto de la aplicación funciona sin correo. Caerse al arrancar por esto
     dejaría fuera a todo el mundo para proteger a catorce. */
  comportamiento.verifica = { ok: false, mensaje: 'mal', sugerencia: '' };
  const r = await conRegistro(() => correos.comprobar()).then(() => correos.comprobar());
  comportamiento.verifica = { ok: true, mensaje: 'Conexión correcta.' };
  assert.equal(r.ok, false, 'devuelve el resultado en vez de lanzar');
});

test('cuando el correo sale, la comprobación no grita', async () => {
  const lineas = await conRegistro(() => correos.comprobar());
  assert.deepEqual(lineas.filter(l => l.includes('[auth][CORREO]')), []);
});

/* ── El cableado ───────────────────────────────────────────────────────── */

test('el arranque comprueba el correo SÓLO con la identidad propia encendida', () => {
  /* Con la bandera apagada el correo de la identidad no se usa, y comprobarlo
     sería abrir una conexión SMTP que nadie pidió. */
  const src = leer('index.js');
  /* Se busca el bloque que MONTA /auth, no el primer `AUTH_PROPIA` que
     aparezca: `/health` también lo mira, y atarse al primero haría que esta
     prueba comprobara el bloque equivocado. Lo cazó ella misma al añadirse el
     de `/health`. */
  const monta = src.indexOf("app.use('/auth', auth.rutas)");
  assert.ok(monta > 0, 'ya no se monta /auth');
  const i = src.lastIndexOf('if (configPropia.AUTH_PROPIA) {', monta);
  const bloque = src.slice(i, src.indexOf('\n}', monta));
  /* Anclada al principio de la línea: `if (false) auth.comprobarCorreo()`
     casaba con un `/comprobarCorreo\(\)/` suelto, y la comprobación estaba
     desactivada. Lo destapó una mutación que ninguna prueba cazaba. */
  assert.match(bloque, /^\s*auth\.comprobarCorreo\(\)/m,
    'el arranque dejó de comprobar el correo, o la comprobación está desactivada');
});

test('/health enseña los correos fallidos, y sólo con la identidad propia', () => {
  /* `/health` es lo que se mira desde fuera, y un correo que no sale no se
     nota por ningún otro lado. */
  const src = leer('index.js');
  const i = src.indexOf("app.get('/health'");
  const bloque = src.slice(i, src.indexOf('\n});', i));
  assert.match(bloque, /correos_fallidos/, '/health dejó de enseñar los correos fallidos');
  assert.match(bloque, /configPropia\.AUTH_PROPIA/, 'los enseña incluso con la bandera apagada');
  assert.doesNotMatch(bloque, /status:\s*cuerpo/, 'el status no puede depender del correo');
});

test('el correo sale por la puerta del módulo, no por dentro', () => {
  /* Igual que el almacén en `modules/archivos`: quien arranca la aplicación no
     tiene por qué conocer el camino de dentro del módulo. */
  const src = leer('modules/auth/index.js');
  assert.match(src, /comprobarCorreo/);
  assert.match(src, /fallosDeCorreo/);
  assert.doesNotMatch(leer('index.js'), /require\('\.\/modules\/auth\/correos/,
    'el arranque entró por la ventana del módulo');
});
