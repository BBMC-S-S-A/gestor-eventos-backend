'use strict';

/* La tarjeta de contacto que se ve al escanear una escarapela.
 *
 * ── El modelo, decidido con quien organiza (17-sep) ─────────────────────
 *
 * · Encendida para todos desde el registro: la autorización va en los
 *   términos y condiciones que la persona acepta al inscribirse. El objetivo
 *   es el networking del evento, no hacer nada más con esos datos.
 * · Quien no quiera, lo marca en su boleta (`tickets.contacto_oculto`) y su QR
 *   sólo sirve para entrar.
 * · Lo que se comparte lo elige el ORGANIZADOR, en
 *   `page_json.tarjeta_contacto.campos`. Mientras esa lista esté vacía no se
 *   comparte nada de nadie: es lo que permite desplegarlo y encenderlo cuando
 *   los términos del evento lo digan.
 *
 * ── Sólo datos para contactar a alguien ─────────────────────────────────
 *
 * Nombre, teléfono, correo, cargo, empresa. El formulario de un evento puede
 * preguntar documento de identidad, fecha de nacimiento, identidad de género,
 * etnia o discapacidad, y nada de eso sirve para conocer a nadie — pero sí
 * quedaría a la vista de cualquiera que le haga una foto a una escarapela.
 *
 * Por eso la regla no depende de que el organizador acierte: aunque la lista
 * guardada traiga el id de una de esas preguntas —marcada por error, o escrita
 * a mano en `page_json`—, aquí se descarta. El panel desactiva esas casillas,
 * pero quien decide es esta función.
 */

/* Los tipos de pregunta que pueden contener un dato de contacto. Una selección,
   una fecha o un documento no lo son nunca. */
const TIPOS_DE_CONTACTO = new Set(['texto', 'email', 'telefono']);

/* Aunque sea de texto libre, una pregunta que habla de esto no se comparte.
   Va por la etiqueta porque es lo único que dice de qué trata una pregunta
   de texto: «Número de documento» es un `texto` como cualquier otro. */
const NO_ES_DE_CONTACTO = /documento|c[eé]dula|identificaci[oó]n|\bnit\b|nacimiento|\bedad\b|g[eé]nero|sexo|[eé]tni|raza|discapacidad|salud|enfermedad|barrio|vereda|direcci[oó]n|comuna|corregimiento|religi|pol[ií]tic|orientaci[oó]n|pasaporte/i;

/* Los dos datos que la boleta tiene fuera del formulario. */
const FIJOS = [
  { id: 'nombre', etiqueta: 'Nombre', tipo: 'texto' },
  { id: 'email',  etiqueta: 'Correo', tipo: 'email' },
];

/* ¿Se puede ofrecer esta pregunta como dato de contacto? */
function esDeContacto(campo) {
  if (!campo || campo.sensible) return false;
  if (!TIPOS_DE_CONTACTO.has(campo.tipo)) return false;
  return !NO_ES_DE_CONTACTO.test(String(campo.etiqueta || ''));
}

/* Qué se le ofrece al organizador para elegir: los dos fijos y las preguntas
   de su formulario que sí son de contacto. Las demás viajan aparte, con el
   motivo, para que el panel pueda enseñarlas desactivadas y decir por qué. */
function opcionesParaElegir(camposForm = []) {
  const permitidas = [...FIJOS];
  const bloqueadas = [];
  for (const c of camposForm) {
    if (esDeContacto(c)) permitidas.push({ id: c.id, etiqueta: c.etiqueta, tipo: c.tipo });
    else bloqueadas.push({ id: c.id, etiqueta: c.etiqueta, tipo: c.tipo });
  }
  return { permitidas, bloqueadas };
}

/* Lo que el organizador eligió, ya filtrado: sólo ids que existen y que son
   de contacto. Lo guardado no se toca; se ignora lo que no vale. */
function camposElegidos(config, camposForm = []) {
  const pedidos = Array.isArray(config?.campos) ? config.campos.map(String) : [];
  const { permitidas } = opcionesParaElegir(camposForm);
  const porId = new Map(permitidas.map(p => [String(p.id), p]));
  return pedidos.map(id => porId.get(id)).filter(Boolean);
}

function valorDe(campo, ticket) {
  if (campo.id === 'nombre') return ticket.guest_nombre || ticket.usuario?.nombre || '';
  if (campo.id === 'email') return ticket.guest_email || ticket.usuario?.email || '';
  const r = ticket.respuestas && typeof ticket.respuestas === 'object' ? ticket.respuestas[campo.id] : null;
  if (r == null) return '';
  return Array.isArray(r) ? r.join(', ') : String(r);
}

/* Lo que se publica al escanear.
 *
 * `motivo` distingue los dos «no» porque quien escanea necesita saber cuál es:
 * no es lo mismo «este evento no comparte contactos» que «esta persona pidió
 * que no aparecieran sus datos». Ninguno de los dos lleva el nombre. */
function tarjetaPublica({ ticket, config, camposForm = [] }) {
  if (!ticket) return null;
  const elegidos = camposElegidos(config, camposForm);
  if (!elegidos.length) return { compartido: false, motivo: 'evento' };
  if (ticket.contacto_oculto) return { compartido: false, motivo: 'persona' };

  const datos = elegidos
    .map(c => ({ id: c.id, etiqueta: c.etiqueta, tipo: c.tipo, valor: valorDe(c, ticket).trim().slice(0, 200) }))
    .filter(d => d.valor);
  if (!datos.length) return { compartido: false, motivo: 'sin_datos' };

  return {
    compartido: true,
    nombre: (ticket.guest_nombre || ticket.usuario?.nombre || '').trim() || 'Asistente',
    datos,
  };
}

module.exports = {
  TIPOS_DE_CONTACTO, NO_ES_DE_CONTACTO, FIJOS,
  esDeContacto, opcionesParaElegir, camposElegidos, tarjetaPublica,
};
