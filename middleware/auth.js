/* Middleware: valida el access_token que manda el front en
   `Authorization: Bearer <token>`. Si es válido, deja `req.user = { id, email, ... }`.

   ── Por qué hay dos verificaciones y en este orden ────────────────────────

   Durante la migración conviven dos clases de token: los que emite nuestra
   identidad propia (`modules/auth`) y los que quedan vivos de Supabase. Este
   archivo prueba primero el nuestro y sólo cae al de Supabase si no valida.

   Eso hace tres cosas a la vez, y por eso se hace así y no cambiando los 38
   archivos de rutas:

   1. **Las 21 sesiones vivas no se cortan.** Quien tenía la aplicación abierta
      cuando se encendió el interruptor sigue dentro; su token de Supabase
      valida por el camino de siempre hasta que caduque.
   2. **Ninguna de las 312 referencias a `req.user` se toca.** La forma del
      objeto es la misma.
   3. **Cada petición con token nuestro se ahorra un viaje de red.** Verificar
      la firma es local; `supabase.auth.getUser()` es una llamada HTTP a
      Supabase por cada petición que hace la aplicación. Con las pantallas
      sondeando, ahí estaba una parte del gasto que no se veía.

   El orden importa: primero el local, porque es el que no cuesta nada. Al
   revés, todo seguiría pagando el viaje.

   ── Cuándo se puede borrar la mitad de este archivo ───────────────────────

   Cuando no queden tokens de Supabase vivos, o sea 30 días después de apagar
   su emisión. Entonces se borra `porSupabase` y esto son diez líneas. */

const supabase = require('../lib/supabase.js');
const config = require('../core/config');

/* Se importa perezosamente para no arrastrar el módulo entero (y su Router de
   Express) cuando la identidad propia está apagada, que es como arranca hoy. */
let _propia = null;
function propia() {
  if (!_propia) _propia = require('../modules/auth');
  return _propia;
}

function tokenDe(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/* Nuestro token. Devuelve el usuario o null, sin red y sin lanzar. */
function porNosotros(req) {
  if (!config.AUTH_PROPIA) return null;
  return propia().verificar(req);
}

/* ── Lo que costaba el camino viejo, medido ─────────────────────────────
 *
 * Con la identidad propia apagada, CADA petición a la API hacía una llamada
 * a `auth/v1/user` de Supabase para saber quién era. Medido el día 1 de
 * FESTECH (17-sep, 20 horas de registros de Supabase): 333.059 llamadas a
 * `auth/v1/user`, más de la mitad de TODAS las peticiones del proyecto. Las
 * pantallas que se refrescan solas —el mostrador, el aforo, el escáner—
 * pedían lo mismo decenas de veces por minuto con el mismo token.
 *
 * Se recuerda la respuesta un minuto por token. Lo que se pierde es poco y
 * está acotado: una sesión cerrada en Supabase sigue valiendo hasta un minuto
 * más aquí. Nunca más allá de la caducidad que lleva el propio token, y sólo
 * se recuerdan los aciertos: un token rechazado se vuelve a preguntar.
 *
 * La clave es el hash del token y no el token: esto vive en memoria del
 * proceso y no hace falta guardar credenciales enteras para reconocerlas. */
const crypto = require('crypto');
const RECUERDO_MS = 60 * 1000;
const MAX_RECORDADOS = 5000;
const recordados = new Map(); // hash → { user, hasta }

function hashDe(token) {
  return crypto.createHash('sha256').update(token).digest('base64');
}

/* La caducidad que dice el propio token (`exp`, en segundos). Se lee sin
   verificar la firma: sólo sirve para no recordar un token más allá de su
   vida, y Supabase ya lo validó entero la primera vez. */
function caducidadDe(token) {
  try {
    const cuerpo = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number(cuerpo.exp) ? Number(cuerpo.exp) * 1000 : null;
  } catch { return null; }
}

function recordar(token, user) {
  const exp = caducidadDe(token);
  const hasta = Math.min(Date.now() + RECUERDO_MS, exp || Infinity);
  if (hasta <= Date.now()) return;
  /* Tope de memoria: si se llena, fuera los más viejos. Un Map conserva el
     orden de inserción, así que los primeros son los más antiguos. */
  if (recordados.size >= MAX_RECORDADOS) {
    const sobran = recordados.size - MAX_RECORDADOS + 1;
    let i = 0;
    for (const k of recordados.keys()) { if (i++ >= sobran) break; recordados.delete(k); }
  }
  recordados.set(hashDe(token), { user, hasta });
}

function recordado(token) {
  const k = hashDe(token);
  const r = recordados.get(k);
  if (!r) return null;
  if (r.hasta <= Date.now()) { recordados.delete(k); return null; }
  return r.user;
}

/* El camino viejo, ahora con memoria de un minuto. */
async function porSupabase(token) {
  const ya = recordado(token);
  if (ya) return ya;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  recordar(token, data.user);
  return data.user;
}

async function verifySupabaseJWT(req, res, next) {
  const token = tokenDe(req);
  if (!token) return res.status(401).json({ error: 'Token requerido.' });

  const nuestro = porNosotros(req);
  if (nuestro) { req.user = nuestro; return next(); }

  const suyo = await porSupabase(token);
  if (!suyo) return res.status(401).json({ error: 'Token inválido o expirado.' });

  req.user = suyo;
  next();
}

/* Igual al anterior pero no bloquea si no hay token (rutas mixtas). */
async function verifySupabaseJWTOptional(req, _res, next) {
  const token = tokenDe(req);
  if (!token) { req.user = null; return next(); }

  const nuestro = porNosotros(req);
  if (nuestro) { req.user = nuestro; return next(); }

  req.user = await porSupabase(token);
  next();
}

module.exports = { verifySupabaseJWT, verifySupabaseJWTOptional, _paraPruebas: { recordados, porSupabase } };
