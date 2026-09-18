'use strict';

/* La tarjeta de contacto que se ve al escanear una escarapela (0133).
 *
 * ── Qué es y qué no ──────────────────────────────────────────────────────
 *
 * Es lo que la persona escribe PARA ESTO: su empresa, su cargo, cómo quiere
 * que la contacten. No son las respuestas del formulario de registro, y no se
 * copian de ahí: ese formulario pide documento, fecha de nacimiento, identidad
 * de género o discapacidad según el evento, y nada de eso puede acabar a la
 * vista de quien pase el móvil por una escarapela colgada del cuello.
 *
 * ── La lista es cerrada a propósito ─────────────────────────────────────
 *
 * Aceptar el objeto que llegue convertiría esto en un cajón donde cualquier
 * pantalla —o cualquiera con el código de una boleta— podría guardar lo que
 * quisiera, y lo guardado se publica. Ocho claves, con tope de largo, y lo
 * demás se descarta en silencio.
 */

const CAMPOS = {
  empresa : 80,
  cargo   : 80,
  email   : 120,
  telefono: 40,
  whatsapp: 40,
  web     : 200,
  linkedin: 200,
  nota    : 280,
};

/* Un texto de una línea: sin saltos y sin espacios de sobra. `nota` es lo
   único que puede tener más de una línea, y se recorta igual. */
function limpiar(valor, tope, multilinea = false) {
  let t = String(valor ?? '');
  t = multilinea ? t.replace(/\r/g, '') : t.replace(/\s+/g, ' ');
  return t.trim().slice(0, tope);
}

/* Lo que se va a guardar, a partir de lo que llegó.
 *
 * Devuelve sólo las claves con algo dentro: una tarjeta con ocho cadenas
 * vacías se vería igual que una vacía, pero ocuparía sitio y haría creer que
 * la persona escribió algo. */
function normalizarContacto(entrante) {
  const dentro = entrante && typeof entrante === 'object' ? entrante : {};
  const salida = {};
  for (const [campo, tope] of Object.entries(CAMPOS)) {
    const v = limpiar(dentro[campo], tope, campo === 'nota');
    if (v) salida[campo] = v;
  }
  /* Un correo que no lo es no se guarda: la tarjeta lo pinta como un enlace
     `mailto:`, y un enlace que no abre nada es peor que no ofrecerlo. */
  if (salida.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(salida.email)) delete salida.email;
  /* Y una web sin esquema se guarda con `https://`, que es lo que la gente
     escribe («miempresa.com») y lo que hace falta para poder enlazarla. */
  for (const campo of ['web', 'linkedin']) {
    if (salida[campo] && !/^https?:\/\//i.test(salida[campo])) salida[campo] = `https://${salida[campo]}`;
  }
  return salida;
}

/* Lo que se publica de una boleta. Sin autorización, nada: ni el nombre.
 *
 * Que sea `{ compartido: false }` y no un 404 es a propósito: quien acaba de
 * escanear una escarapela de verdad tiene que poder distinguir «esta persona
 * no comparte sus datos» de «este código no existe», que es lo que le diría si
 * hubiera escaneado mal. */
function tarjetaPublica(ticket) {
  if (!ticket) return null;
  if (!ticket.contacto_publico) return { compartido: false };
  const contacto = normalizarContacto(ticket.contacto);
  return {
    compartido: true,
    nombre: (ticket.guest_nombre || '').trim() || 'Asistente',
    contacto,
  };
}

module.exports = { CAMPOS, normalizarContacto, tarjetaPublica };
