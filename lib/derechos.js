'use strict';

/* Lo que incluye una credencial, y quién se lo entregó.
 *
 * ── Qué resuelve ─────────────────────────────────────────────────────────
 *
 * «Una credencial da derecho a N usos de algo, dentro de una ventana de
 * tiempo, y cada uso queda registrado con quién lo entregó.»
 *
 * El almuerzo de los expositores es una configuración de esa frase. También la
 * camiseta, el parqueadero, el guardarropa, la bebida incluida en la VIP y el
 * vale de un patrocinador. Migración 0126; diseño completo en `docs/DERECHOS.md`.
 *
 * ── Lo que este archivo NO hace ──────────────────────────────────────────
 *
 * No toca la base, igual que `puestos.js`. Todo aquí recibe datos y devuelve
 * datos, para que las reglas —a quién le toca, en qué ventana, si ya lo
 * recibió— se puedan probar sin credenciales. Lo que escribe vive en
 * `routes/derechos.js`.
 *
 * Y no decide la unicidad. El «uno por persona y por ventana» lo impone un
 * índice único de la base (ver la 0126): aquí sólo se traduce el choque a algo
 * que el operador pueda leer.
 */

const TITULARES = ['persona', 'grupo'];
const CADENCIAS = ['ventana', 'total'];
const ORIGENES = ['qr', 'manual', 'cola'];

/* ── El catálogo ────────────────────────────────────────────────────────── */

const COLUMNAS_DERECHO = [
  'nombre', 'descripcion', 'titular', 'cadencia', 'usos',
  'aplica_tipos', 'activo', 'orden',
];

const COLUMNAS_VENTANA = ['nombre', 'inicio', 'fin', 'cupo', 'orden'];

/* Deja un derecho listo para escribir, o explica por qué no lo está.
 *
 * `usos` se acota por arriba a propósito. No hay ningún derecho legítimo de
 * mil usos, y sí hay dedos que escriben 100 donde iba 1: sin tope, ese error se
 * descubre cuando alguien se ha llevado cien almuerzos. */
function validarDerecho(body = {}, { parcial = false } = {}) {
  const out = {};
  for (const k of COLUMNAS_DERECHO) if (k in body) out[k] = body[k];

  if (!parcial && !String(out.nombre || '').trim()) {
    throw new Error('El derecho necesita un nombre.');
  }
  if ('nombre' in out) out.nombre = String(out.nombre).trim();

  if ('titular' in out && !TITULARES.includes(out.titular)) {
    throw new Error('El titular de un derecho es una persona o un grupo.');
  }
  if ('cadencia' in out && !CADENCIAS.includes(out.cadencia)) {
    throw new Error('La cadencia de un derecho es por ventana o total.');
  }
  if ('usos' in out) {
    const n = Number(out.usos);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new Error('Los usos van de 1 a 100.');
    }
    out.usos = n;
  }
  if ('aplica_tipos' in out) {
    if (!Array.isArray(out.aplica_tipos)) throw new Error('`aplica_tipos` es una lista de tipos de boleta.');
    out.aplica_tipos = out.aplica_tipos.map(String);
  }
  if ('activo' in out) out.activo = Boolean(out.activo);
  if ('orden' in out) out.orden = Number(out.orden) || 0;

  return out;
}

function validarVentana(body = {}, { parcial = false } = {}) {
  const out = {};
  for (const k of COLUMNAS_VENTANA) if (k in body) out[k] = body[k];

  if (!parcial && !String(out.nombre || '').trim()) {
    throw new Error('La ventana necesita un nombre.');
  }
  if ('nombre' in out) out.nombre = String(out.nombre).trim();

  for (const k of ['inicio', 'fin']) {
    if (k in out && out[k]) {
      const t = new Date(out[k]).getTime();
      if (!Number.isFinite(t)) throw new Error(`La fecha de ${k} no se entiende.`);
      out[k] = new Date(t).toISOString();
    } else if (k in out) out[k] = null;
  }
  /* Una ventana que termina antes de empezar no entrega nada y no da ningún
     error: se queda cerrada todo el evento y nadie sabe por qué. */
  if (out.inicio && out.fin && new Date(out.fin) <= new Date(out.inicio)) {
    throw new Error('La ventana termina antes de empezar.');
  }
  if ('cupo' in out) {
    if (out.cupo === null || out.cupo === '') out.cupo = null;
    else {
      const n = Number(out.cupo);
      if (!Number.isInteger(n) || n < 0) throw new Error('El cupo es un número de raciones.');
      out.cupo = n;
    }
  }
  if ('orden' in out) out.orden = Number(out.orden) || 0;

  return out;
}

/* ── A quién le toca ────────────────────────────────────────────────────── */

/* ¿Este derecho aplica a esta boleta?
 *
 * Lista vacía es «a todas», que es lo que se quiere cuando el almuerzo va
 * incluido para todo el mundo. Es cómodo y es una trampa —un derecho mal
 * configurado reparte almuerzo a los 2.000 asistentes en vez de a los 40
 * expositores—, y por eso la pantalla tiene que decir a cuántas boletas va a
 * aplicar ANTES de guardar. Aquí sólo se responde la pregunta. */
function aplicaATipo(derecho, ticketTypeId) {
  const lista = Array.isArray(derecho?.aplica_tipos) ? derecho.aplica_tipos : [];
  if (!lista.length) return true;
  return lista.map(String).includes(String(ticketTypeId));
}

/* Quién es el titular de este consumo: la persona o la boleta entera.
 *
 * Es la diferencia entre que las dos personas del stand tengan un almuerzo cada
 * una, o que sean dos almuerzos del stand que se puede comer quien esté en la
 * caseta. Las dos son peticiones reales y ninguna sirve de valor único. */
function titularDe(derecho, { ticketId, puestoId }) {
  if (!ticketId) throw new Error('Un consumo necesita una boleta.');
  if (derecho?.titular === 'grupo') return { ticket_id: ticketId, puesto_id: null };
  return { ticket_id: ticketId, puesto_id: puestoId || null };
}

/* ── La ventana ─────────────────────────────────────────────────────────── */

/* Qué ventana se está entregando ahora mismo.
 *
 * Una sin horas es una ventana siempre abierta —«el kit, cuando lleguen»— y
 * cuenta como vigente. Si hay varias abiertas a la vez, gana la que empezó más
 * tarde: en un evento con el refrigerio solapando el almuerzo, lo que se está
 * sirviendo es lo último que abrió. */
function ventanaVigente(ventanas = [], ahora = Date.now()) {
  const t = typeof ahora === 'number' ? ahora : new Date(ahora).getTime();
  const abiertas = ventanas.filter(v => {
    const i = v.inicio ? new Date(v.inicio).getTime() : -Infinity;
    const f = v.fin ? new Date(v.fin).getTime() : Infinity;
    return t >= i && t <= f;
  });
  if (!abiertas.length) return null;
  return abiertas.sort((a, b) => {
    const ia = a.inicio ? new Date(a.inicio).getTime() : -Infinity;
    const ib = b.inicio ? new Date(b.inicio).getTime() : -Infinity;
    return ib - ia;
  })[0];
}

/* La ventana con la que se va a escribir el consumo, y el aviso si la elegida
 * no está abierta.
 *
 * Fuera de ventana se entrega igual. Es deliberado: quedarse con la comida en
 * la mano y una persona delante sin poder entregarla es peor que servir a
 * destiempo. El sistema deja constancia y la decisión es del staff. */
function resolverVentana({ derecho, ventanas = [], ventanaId = null, at }) {
  if (derecho?.cadencia === 'total') return { ventana: null, aviso: null };

  const t = at ? new Date(at).getTime() : Date.now();

  if (ventanaId) {
    const elegida = ventanas.find(v => String(v.id) === String(ventanaId));
    if (!elegida) throw new Error('Esa franja no es de este derecho.');
    const vigente = ventanaVigente([elegida], t);
    return {
      ventana: elegida,
      aviso: vigente ? null : `${elegida.nombre} no está abierta ahora.`,
    };
  }

  const vigente = ventanaVigente(ventanas, t);
  if (vigente) return { ventana: vigente, aviso: null };

  /* Sin ninguna abierta y sin elegir, no hay dónde anotarlo. Escribirlo en la
     primera que aparezca sería inventarse el dato. */
  throw new Error('No hay ninguna franja abierta ahora. Elige una.');
}

/* ── El uso ─────────────────────────────────────────────────────────────── */

/* Qué número de uso es éste, o `null` si ya no le quedan.
 *
 * Se calcula desde los que ya tiene y NO es la última palabra: entre calcularlo
 * y escribirlo cabe otra tableta calculando lo mismo. La última palabra es el
 * índice único de la 0126; esto sólo evita el viaje a la base en el caso
 * normal y decide el número que se intenta. */
function siguienteUso(derecho, consumosPrevios = []) {
  const tope = Number(derecho?.usos) > 0 ? Number(derecho.usos) : 1;
  const usados = new Set(consumosPrevios.map(c => Number(c.uso_num) || 1));
  for (let n = 1; n <= tope; n++) if (!usados.has(n)) return n;
  return null;
}

/* ¿Este error de la base es el índice único diciendo «ya lo recibió»?
 *
 * 23505 es `unique_violation` en Postgres. Se mira el código y no el texto
 * porque el texto cambia con el idioma del servidor, y una comparación de
 * cadenas que falla aquí convierte un duplicado legítimo en un error 500. */
function esDuplicado(error) {
  if (!error) return false;
  return String(error.code) === '23505'
      || /duplicate key|unique constraint/i.test(String(error.message || ''));
}

/* ── Lo que ve quien entrega ────────────────────────────────────────────── */

/* Con cien personas en la fila, la pantalla es un sí o un no. El detalle va
 * debajo, no en lugar del veredicto. */
function veredicto({ derecho, ventana, persona, uso, avisos = [] }) {
  const que = derecho?.nombre || 'Entregado';
  const quien = persona?.nombre || persona?.email || 'Sin nombre';
  const cuantos = Number(derecho?.usos) > 1 && uso ? ` (${uso} de ${derecho.usos})` : '';
  return {
    ok: true,
    sound: 'ok',
    titulo: `${que}${cuantos}`,
    persona: quien,
    ventana: ventana?.nombre || null,
    avisos: avisos.filter(Boolean),
  };
}

/* Y cuando ya lo recibió: la hora y de manos de quién.
 *
 * Ese dato es la mitad del mensaje. «Ya lo recibió» a secas deja al operador
 * discutiendo con la persona; «a las 12:14, se lo entregó María» lo resuelve. */
function yaLoRecibio({ derecho, consumo, operador }) {
  const hora = consumo?.entregado_at
    ? new Date(consumo.entregado_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    : null;
  const quien = operador?.nombre || operador?.email || null;
  return {
    error: `Ya recibió ${derecho?.nombre || 'esto'}${hora ? ` a las ${hora}` : ''}.`,
    entregado_por: quien,
    entregado_at: consumo?.entregado_at || null,
    ya_entregado: true,
    sound: 'error',
  };
}

/* ── El recuento ────────────────────────────────────────────────────────── */

/* Lo que la cocina pregunta cada media hora: cuántos van y cuántos faltan.
 *
 * `faltan` sale de los que tienen derecho, no del cupo: el cupo es cuánta
 * comida se compró, y las dos cifras juntas son las que dicen si va a alcanzar. */
function recuento({ entregados = 0, conDerecho = 0, cupo = null }) {
  const faltan = Math.max(0, conDerecho - entregados);
  return {
    entregados,
    con_derecho: conDerecho,
    faltan,
    cupo,
    /* Advertir, no bloquear: ver `resolverVentana`. */
    sobre_cupo: cupo != null && entregados >= cupo,
  };
}

module.exports = {
  TITULARES, CADENCIAS, ORIGENES,
  COLUMNAS_DERECHO, COLUMNAS_VENTANA,
  validarDerecho, validarVentana,
  aplicaATipo, titularDe,
  ventanaVigente, resolverVentana,
  siguienteUso, esDuplicado,
  veredicto, yaLoRecibio, recuento,
};
