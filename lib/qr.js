/* Helpers para QR de boletas: firmar y verificar JWTs.
   El payload incluye ticket_id, evento_id y código corto.
   Firmamos con QR_JWT_SECRET (env). El JWT se imprime como QR. */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/* ── El secreto ───────────────────────────────────────────────────────────
 *
 * Esto firma lo que ABRE LA PUERTA de un evento. Quien tenga el secreto puede
 * fabricar boletas válidas para cualquier evento de la plataforma, y nadie en
 * la puerta puede notarlo: el escáner sólo comprueba la firma.
 *
 * Aquí había un valor por defecto —`gestek_qr_change_me_in_production`—
 * escrito en el código. Con la variable sin poner, el backend arrancaba tan
 * contento firmando boletas con una cadena que está en el repositorio. Y
 * `config/env.js` ya paraba el arranque cuando falta... pero sólo si
 * `NODE_ENV === 'production'`, que es justo lo que se olvida de poner en un
 * cPanel con Passenger. El servidor arrancaba, todo «funcionaba», y las
 * entradas eran falsificables por cualquiera que supiera leer este archivo.
 *
 * Ahora: en producción no se firma sin secreto de verdad —se lanza, y el
 * fallo se ve—; fuera de producción se usa uno ALEATORIO de este proceso.
 * Aleatorio y no fijo a propósito: un valor fijo en el repositorio vuelve a
 * ser un secreto público en cuanto alguien despliega sin la variable. El
 * precio es que los QR firmados en desarrollo dejan de valer al reiniciar el
 * servidor, y para eso está `QR_JWT_SECRET` en el `.env` (ver `.env.example`).
 */

/* El literal que se usaba antes, y los de los ejemplos. Si alguno llega como
   secreto de verdad no es un secreto: es el marcador de posición que alguien
   copió del `.env.example` sin cambiarlo. */
const NO_SON_SECRETOS = new Set([
  'gestek_qr_change_me_in_production',
  'DEV_ONLY_QR_SECRET_NOT_FOR_PRODUCTION',
  'cambia_esto_por_un_secreto_seguro_minimo_32_chars',
  'cambia-esto-por-un-secreto-largo',
]);

const MINIMO = 32;
const IS_PROD = process.env.NODE_ENV === 'production';

/* Por qué es una función y no una constante: las pruebas y el script de
   rotación cambian la variable sobre la marcha, y una constante leída al
   cargar el módulo se quedaría con el valor de antes. */
let _secretoDeDev = null;

function secreto() {
  const puesto = process.env.QR_JWT_SECRET;

  if (puesto && puesto.length >= MINIMO && !NO_SON_SECRETOS.has(puesto)) return puesto;

  if (IS_PROD) {
    /* Se dice QUÉ pasa con el que hay puesto, porque «falta» y «es el de
       ejemplo» se arreglan distinto y el segundo es el que se pasa por alto. */
    const motivo = !puesto ? 'no está configurada'
      : NO_SON_SECRETOS.has(puesto) ? 'sigue teniendo el valor de ejemplo'
      : `tiene ${puesto.length} caracteres y hacen falta ${MINIMO}`;
    throw new Error(
      `QR_JWT_SECRET ${motivo}. Es lo que firma los QR de las boletas: sin un `
      + `secreto propio, cualquiera puede fabricar entradas válidas. `
      + `Ponla en el entorno con al menos ${MINIMO} caracteres aleatorios.`,
    );
  }

  if (!_secretoDeDev) {
    _secretoDeDev = crypto.randomBytes(48).toString('base64url');
    console.warn(
      '[qr] QR_JWT_SECRET no está puesta: se firma con un secreto aleatorio de este proceso.\n'
      + '     Los QR emitidos ahora dejarán de valer cuando reinicies. Pon QR_JWT_SECRET '
      + 'en el .env si necesitas que sigan sirviendo.',
    );
  }
  return _secretoDeDev;
}

/* ¿Se puede firmar con lo que hay puesto? Devuelve `{ ok, motivo }` en vez de
 * lanzar: lo usa `config/env.js` al arrancar para parar el despliegue ahí
 * mismo. Sin esto el fallo aparecería en la primera venta del primer evento
 * —con gente comprando—, que es el peor momento para enterarse. */
function revisarSecreto() {
  try {
    secreto();
    return { ok: true, motivo: null };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

function signTicketQR({ ticket_id, evento_id, codigo }) {
  return jwt.sign(
    { tid: ticket_id, eid: evento_id, c: codigo, v: 1 },
    secreto(),
    { algorithm: 'HS256' }
    /* No expira — la boleta vale mientras el evento esté activo */
  );
}

/* El QR de UN puesto dentro de una boleta de varias personas (0118).
 *
 * Lleva `tid` y `eid` como el de la boleta, así que todo lo que ya lee QRs lo
 * sigue entendiendo: quien no sepa de puestos ve la boleta correcta y funciona
 * como antes. Lo que añade es `pid`, y con eso la puerta puede marcar entrado a
 * uno de los cuatro de la mesa en vez de a la mesa entera.
 *
 * Y es lo que hace posible la reventa: al transferir se firma de nuevo con la
 * generación siguiente, y eso —no el hecho de que el token cambie— es lo que
 * mata al anterior. La diferencia importa: un token distinto lo produce también
 * un reenvío del correo, y ése no invalida nada. */
function signPuestoQR({ ticket_id, evento_id, codigo, puesto_id, orden, gen = 0 }) {
  return jwt.sign(
    { tid: ticket_id, eid: evento_id, c: codigo, pid: puesto_id, o: orden, v: 1,
      /* La generación de la credencial (0127). Sube SÓLO al transferir, y es
         lo que separa reemitir de invalidar: reenviar el correo firma otro
         token de la misma generación —y el anterior sigue abriendo, que es lo
         que se espera de un reenvío—, mientras que transferir sube el número y
         mata todo lo anterior de golpe.
         Antes esa distinción no existía: se comparaba el token presentado con
         el guardado, y eso mata igual al QR de un reenvío legítimo. */
      g: gen || 0,
      /* Dos firmas del mismo puesto en el mismo segundo serían el mismo token,
         y entonces rotar no invalidaría nada. `jti` garantiza que cambia. */
      jti: `${puesto_id}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}` },
    secreto(),
    { algorithm: 'HS256' }
  );
}

function verifyTicketQR(token) {
  try {
    const payload = jwt.verify(token, secreto(), { algorithms: ['HS256'] });
    return { ok: true, ticket_id: payload.tid, evento_id: payload.eid, codigo: payload.c,
             /* `null` en una boleta normal: sólo los QR de puesto lo traen. */
             puesto_id: payload.pid || null, orden: payload.o || null,
             /* Los QR firmados antes de la 0127 no llevan `g`, y eso no es un
                dato que falte: son la generación 0, que es la que tienen todos
                los puestos existentes. Por eso siguen abriendo sin reemitir
                nada. */
             gen: Number(payload.g) || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { signTicketQR, signPuestoQR, verifyTicketQR, revisarSecreto };
