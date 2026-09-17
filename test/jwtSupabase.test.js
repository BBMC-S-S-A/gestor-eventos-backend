'use strict';

/* El token de Supabase se verifica en local, y eso se PRUEBA CONTANDO.
 *
 * ── Qué se estaba pagando ────────────────────────────────────────────────
 *
 * `middleware/auth.js` validaba cada petición con `supabase.auth.getUser()`:
 * un viaje de red al servidor de auth por cada petición de la aplicación.
 * Medido en los registros del proyecto, en 24 horas:
 *
 *     GET /user   105.655
 *     POST /token     157
 *
 * Unos 3,2 millones de llamadas al mes para comprobar algo que el propio token
 * ya trae firmado.
 *
 * ── Por qué se cuentan las llamadas y no se comprueba que «funciona» ─────
 *
 * Porque si el orden estuviera al revés —red primero, local después— TODO
 * seguiría entrando igual, ninguna prueba fallaría, y se seguiría pagando el
 * viaje en cada petición. El ahorro es invisible desde fuera: lo único que lo
 * demuestra es que la llamada no ocurrió.
 *
 * Es el mismo razonamiento que ya está escrito en `auth.middleware.test.js`
 * para la identidad propia.
 */

process.env.SUPABASE_URL = 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'falsa';
process.env.AUTH_PROPIA = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/* Un par de claves ES256 de verdad: es la firma que usa este proyecto
   (comprobado en su JWKS el 17-sep), y con una falsa no se probaría nada. */
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'clave-de-prueba';
const jwkPublica = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };

/* El JWKS se sirve desde aquí, sin red, contando cuántas veces se pide: la
   caché es media razón de ser de esto. */
let descargasDelJwks = 0;
const fetchReal = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes('jwks.json')) {
    descargasDelJwks += 1;
    return { ok: true, json: async () => ({ keys: [jwkPublica] }) };
  }
  return fetchReal(url);
};

/* Y `lib/supabase.js` sustituido ANTES de cargar el middleware, para contar
   los viajes de red que se supone que ya no ocurren. */
const rutaSupabase = require.resolve('../lib/supabase.js');
let llamadasDeRed = 0;
require.cache[rutaSupabase] = {
  id: rutaSupabase, filename: rutaSupabase, loaded: true, exports: {
    auth: {
      async getUser() {
        llamadasDeRed += 1;
        return { data: { user: { id: 'vino-por-la-red' } }, error: null };
      },
    },
  },
};

const jwtSupabase = require('../lib/jwtSupabase.js');
const { verifySupabaseJWT } = require('../middleware/auth.js');

const USUARIO = '11111111-2222-3333-4444-555555555555';

const firmar = (extra = {}, opciones = {}) => jwt.sign(
  {
    sub: USUARIO, email: 'ana@ejemplo.com', role: 'authenticated',
    user_metadata: { nombre: 'Ana' }, ...extra,
  },
  privateKey,
  {
    algorithm: 'ES256', keyid: KID, expiresIn: '1h',
    issuer: 'https://ficticio.supabase.co/auth/v1', audience: 'authenticated',
    ...opciones,
  },
);

const peticion = (token) => ({ headers: { authorization: `Bearer ${token}` } });
function respuesta() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('un token bueno entra SIN llamar a Supabase', async () => {
  jwtSupabase._reiniciar();
  llamadasDeRed = 0;
  const req = peticion(firmar());
  let siguio = false;
  await verifySupabaseJWT(req, respuesta(), () => { siguio = true; });

  assert.ok(siguio, 'no dejó pasar un token válido');
  assert.equal(req.user.id, USUARIO);
  assert.equal(llamadasDeRed, 0,
    'sigue preguntándole a Supabase por cada petición: el ahorro no existe');
});

test('devuelve el mismo objeto que usaba el código', () => {
  /* De `req.user` el código sólo lee `id`, `email` y `user_metadata` — 395, 12
     y 1 referencias. Si alguno cambia de nombre, rompe en sitios lejanos. */
  jwtSupabase._reiniciar();
  return jwtSupabase.usuarioDelToken(firmar()).then((u) => {
    assert.equal(u.id, USUARIO);
    assert.equal(u.email, 'ana@ejemplo.com');
    assert.deepEqual(u.user_metadata, { nombre: 'Ana' });
  });
});

test('el JWKS se descarga una vez, no en cada petición', async () => {
  /* Si no, se cambia una llamada de red por otra y no se ha ganado nada. */
  jwtSupabase._reiniciar();
  descargasDelJwks = 0;
  for (let i = 0; i < 5; i++) await jwtSupabase.usuarioDelToken(firmar());
  assert.equal(descargasDelJwks, 1,
    `el JWKS se pidió ${descargasDelJwks} veces: la caché no está funcionando`);
});

test('un token firmado con otra clave NO entra en local', async () => {
  const otra = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const malo = jwt.sign({ sub: 'intruso' }, otra, {
    algorithm: 'ES256', keyid: KID, expiresIn: '1h',
    issuer: 'https://ficticio.supabase.co/auth/v1', audience: 'authenticated',
  });
  jwtSupabase._reiniciar();
  assert.equal(await jwtSupabase.usuarioDelToken(malo), null,
    'una firma que no es la nuestra está pasando por buena');
});

test('un token caducado no entra', async () => {
  jwtSupabase._reiniciar();
  const viejo = firmar({}, { expiresIn: '-1h' });
  assert.equal(await jwtSupabase.usuarioDelToken(viejo), null);
});

test('un token de otro emisor no entra', async () => {
  /* El mismo proyecto puede tener tokens de otro sitio dando vueltas; el
     emisor es lo que los separa. */
  jwtSupabase._reiniciar();
  const ajeno = firmar({}, { issuer: 'https://otro-proyecto.supabase.co/auth/v1' });
  assert.equal(await jwtSupabase.usuarioDelToken(ajeno), null);
});

test('si el local no puede, se cae a la red y nadie se queda fuera', async () => {
  /* La red de seguridad. Un token que no valida en local —otra firma, un JWKS
     que no se pudo traer— tiene que seguir preguntándose como siempre: dejar a
     alguien fuera cuesta más que una llamada. */
  jwtSupabase._reiniciar();
  llamadasDeRed = 0;
  const req = peticion('esto-no-es-un-jwt');
  let siguio = false;
  await verifySupabaseJWT(req, respuesta(), () => { siguio = true; });

  assert.equal(llamadasDeRed, 1, 'ya no hay respaldo: un token raro se rechaza sin preguntar');
  assert.ok(siguio && req.user.id === 'vino-por-la-red');
});
