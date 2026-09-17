'use strict';

/* Lo que mandó el escáner, puesto en su sitio.
 *
 * Un token firmado siempre lleva puntos (cabecera.cuerpo.firma) y cientos de
 * caracteres. Si llega como `qr_token` algo corto, de letras y números y sin
 * puntos, es un código de boleta —el QR «simplificado» de una etiqueta— y se
 * busca como tal. El panel ya lo manda como `codigo`, pero un móvil de la
 * puerta con la versión vieja guardada en caché lo sigue mandando como token,
 * y la respuesta era «QR inválido» con la persona delante. */
function leerEscaneo({ qr_token, codigo } = {}) {
  const t = typeof qr_token === 'string' ? qr_token.trim() : qr_token;
  if (t && typeof t === 'string' && !t.includes('.') && /^[A-Za-z0-9]{4,16}$/.test(t)) {
    return { qr_token: null, codigo: t.toUpperCase() };
  }
  return { qr_token: t || null, codigo };
}

module.exports = { leerEscaneo };
