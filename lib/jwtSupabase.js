/* Verificar el token de Supabase SIN preguntarle a Supabase.
 *
 * ── El gasto que esto quita ──────────────────────────────────────────────
 *
 * `middleware/auth.js` validaba cada petición con `supabase.auth.getUser()`,
 * que es un viaje de red al servidor de auth. Una llamada HTTP por cada
 * petición que hace la aplicación.
 *
 * Medido en los registros del proyecto, en 24 horas:
 *
 *     GET /user   105.655        ← esto
 *     POST /token     157        ← los refrescos de sesión de verdad
 *
 * O sea unos 3,2 millones de peticiones al mes que no hacen falta para nada:
 * un JWT lleva su propia firma, y comprobarla son microsegundos de CPU.
 *
 * ── Por qué con JWKS y no con un secreto ────────────────────────────────
 *
 * Lo habitual era `SUPABASE_JWT_SECRET` y HS256. Este proyecto NO firma así:
 * su JWKS publica una clave **ES256** (curva elíptica), que es asimétrica.
 * Comprobado el 17-sep en `/auth/v1/.well-known/jwks.json`. Con clave pública
 * no hace falta ningún secreto en el servidor: sólo la clave, que es pública
 * por definición.
 *
 * Se acepta también RS256 porque Supabase ofrece las dos y un proyecto puede
 * rotar de una a otra sin avisar.
 *
 * ── El precio, dicho ────────────────────────────────────────────────────
 *
 * Un token revocado ANTES de caducar —alguien cierra sesión, se banea una
 * cuenta— sigue valiendo aquí, porque ya nadie pregunta. La ventana es lo que
 * dure el access token (una hora por defecto en Supabase). Es el mismo
 * compromiso que ya aceptó `modules/auth` para nuestra identidad propia, y
 * está escrito allí con las mismas palabras.
 *
 * Si algo falla —no hay red para traer el JWKS, la clave no está, el token
 * viene firmado de otra forma— esto devuelve `null` y el middleware cae al
 * camino de siempre. Nunca lanza: una caída aquí no puede dejar a nadie fuera
 * de la aplicación.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const URL_BASE = () => String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');

/* Las claves, cacheadas por `kid`.
 *
 * No caducan solas: una clave pública no cambia. Lo que sí pasa es que el
 * proyecto rote y aparezca un `kid` nuevo, y para eso está el refresco de
 * abajo — que se pide UNA vez y con suelo de tiempo, para que un token
 * inventado con un `kid` que no existe no convierta esto en un ariete contra
 * el servidor de auth. */
let claves = new Map();
let traidoEn = 0;
let enVuelo = null;
const SUELO_MS = 60_000;

async function traerJwks() {
  const base = URL_BASE();
  if (!base) return;
  /* Si ya hay una petición en el aire, se espera a ésa: con veinte peticiones
     entrando a la vez tras un reinicio, si no, serían veinte descargas del
     mismo archivo. */
  if (enVuelo) return enVuelo;
  if (Date.now() - traidoEn < SUELO_MS) return;

  enVuelo = (async () => {
    try {
      const r = await fetch(`${base}/auth/v1/.well-known/jwks.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`JWKS ${r.status}`);
      const { keys = [] } = await r.json();
      const nuevas = new Map();
      for (const jwk of keys) {
        if (!jwk?.kid) continue;
        try {
          nuevas.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch { /* una clave ilegible no invalida las demás */ }
      }
      /* Sólo se pisa la caché si vino algo: un JWKS vacío por un fallo del otro
         lado dejaría sin claves a un proceso que estaba funcionando. */
      if (nuevas.size) claves = nuevas;
      traidoEn = Date.now();
    } catch (e) {
      console.warn('[jwt-supabase] no se pudo traer el JWKS:', e.message);
    } finally {
      enVuelo = null;
    }
  })();
  return enVuelo;
}

/* El `kid` del token, sin verificar nada todavía. Sólo para saber qué clave
   pedir; la firma se comprueba después, que es lo que manda. */
function kidDe(token) {
  try {
    return jwt.decode(token, { complete: true })?.header?.kid || null;
  } catch { return null; }
}

/* Devuelve el usuario con la MISMA forma que `supabase.auth.getUser()`, o
   `null`. De ese objeto el código sólo usa `id`, `email` y `user_metadata`
   (395, 12 y 1 referencias), y los tres vienen dentro del propio token. */
async function usuarioDelToken(token) {
  if (!token || !URL_BASE()) return null;

  const kid = kidDe(token);
  if (!kid) return null;                       // sin kid no es un token de éstos

  if (!claves.has(kid)) await traerJwks();
  const clave = claves.get(kid);
  if (!clave) return null;

  try {
    const c = jwt.verify(token, clave, {
      algorithms: ['ES256', 'RS256'],
      issuer: `${URL_BASE()}/auth/v1`,
      audience: 'authenticated',
    });
    if (!c?.sub) return null;
    return {
      id: c.sub,
      email: c.email || null,
      user_metadata: c.user_metadata || {},
      app_metadata: c.app_metadata || {},
      role: c.role || 'authenticated',
    };
  } catch {
    /* Firma mala, caducado, otro emisor. No se distingue el motivo a
       propósito: quien llama sólo necesita saber que por aquí no entra, y el
       camino de red de al lado dará el mensaje bueno si hace falta. */
    return null;
  }
}

/* Para las pruebas: dejar la caché como recién arrancado. */
function _reiniciar() { claves = new Map(); traidoEn = 0; enVuelo = null; }

module.exports = { usuarioDelToken, _reiniciar };
