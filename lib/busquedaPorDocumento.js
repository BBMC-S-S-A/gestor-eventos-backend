'use strict';

/* Buscar a alguien por su cédula.
 *
 * ── De dónde sale esto ───────────────────────────────────────────────────
 *
 * En el mostrador la persona llega y dice su número de documento. Hasta ahora
 * la lista de clientes sólo buscaba por `guest_nombre`, `guest_email` y
 * `codigo`, así que había que encontrarla por el nombre — con los homónimos,
 * las tildes y los «Pérez, Juan» que eso arrastra. En FESTECH IBAGUÉ se
 * reportó como «el filtro no encuentra».
 *
 * Y el dato estaba: el formulario pedía «Documento de Identidad» y lo
 * respondieron 4.481 de 4.485 boletas — el 99,9%. Vivía en `tickets.respuestas`,
 * indexado por el UUID del campo, que es justo por lo que no entraba en una
 * búsqueda de texto sobre columnas.
 *
 * ── Por qué por TIPO de campo y no por su etiqueta ───────────────────────
 *
 * El campo se reconoce por `tipo = 'documento'`, no porque se llame «Cédula».
 * Cada organizador lo titula a su manera —«Documento de Identidad», «Cédula»,
 * «CC / TI»— y adivinar por el texto es acertar en el evento que se miró y
 * fallar en el siguiente. El tipo lo pone el editor del formulario y es el
 * mismo en todos.
 *
 * ── Por qué exacto y no parcial ──────────────────────────────────────────
 *
 * Dos razones, y las dos pesan.
 *
 * Buscar «123» y que salgan cuarenta personas no ayuda a quien tiene la fila
 * delante: le da más trabajo, no menos.
 *
 * Y un documento es un dato personal. Una búsqueda por subcadena convierte la
 * caja del mostrador en una forma de pasear por los documentos de los demás
 * tecleando dígitos sueltos. Exacto significa que hay que saber el número
 * ANTES de preguntarlo, que es como debe ser.
 *
 * ── Lo que no cubre ──────────────────────────────────────────────────────
 *
 * Quien escribió su documento con puntos («1.234.567») sólo aparece si se
 * teclea igual. Se busca el número tal cual se escribió y también sólo con
 * sus dígitos, que cubre el caso de ida —escribir con puntos y encontrar lo
 * guardado sin ellos— pero no el de vuelta, porque eso exigiría normalizar lo
 * guardado y eso se hace en la base, con un índice, no aquí. En FESTECH eran
 * 9 boletas de 4.481: el 0,2%.
 */

/* Cinco dígitos. Por debajo de eso no es un documento: es alguien buscando
   «123» a ver qué sale, y lo que sale es la lista entera de quien tenga esos
   dígitos. Las cédulas colombianas van de seis a diez. */
const MINIMO_DIGITOS = 5;

/* Tope por consulta. Un documento identifica a una persona, así que lo normal
   es una fila o unas pocas si se registró varias veces —que pasa, y verlas es
   justo lo que se quiere en el mostrador—. Si algún día sale mucho más, es que
   ese campo no era un documento. */
const TOPE = 50;

/* Qué valores hay que buscar para el texto que se escribió.
 *
 * Devuelve lista vacía cuando el texto no parece un documento, que es la forma
 * de decir «esto era una búsqueda por nombre, no te molestes». Es la única
 * parte con decisiones, así que va suelta y se prueba sola. */
function valoresDeDocumento(q) {
  const crudo = String(q == null ? '' : q).trim();
  if (!crudo) return [];
  const digitos = crudo.replace(/\D/g, '');
  if (digitos.length < MINIMO_DIGITOS) return [];
  /* Sin espacios. Es lo que separa un documento de un nombre con un número
     dentro: «Juan Perez 12345» tiene cinco dígitos y no es una cédula.
     Y NO se exige que sean sólo dígitos, aunque fuera más limpio: un pasaporte
     lleva letras, y este campo es «documento», no «cédula». Un código de
     boleta también pasa el filtro y se busca de más — una consulta que no
     devuelve nada— pero ese es el lado barato de equivocarse: la alternativa
     es que quien llega con pasaporte no aparezca. */
  if (/\s/.test(crudo)) return [];
  /* El texto tal cual y su versión sólo dígitos. Si son iguales —el caso
     normal— va uno solo. */
  return crudo === digitos ? [digitos] : [crudo, digitos];
}

/* Los campos de tipo documento del formulario del evento. Suele ser uno. */
async function camposDeDocumento(eventoId) {
  const supabase = require('./supabase.js');
  const { data, error } = await supabase
    .from('event_form_fields')
    .select('id')
    .eq('evento_id', eventoId)
    .eq('tipo', 'documento')
    .is('session_id', null);
  if (error) {
    /* Se anota y se sigue sin buscar por documento: quien escribió un número
       se queda sin ese resultado, pero la lista contesta. Romper la pantalla
       de clientes por esto sería peor que no encontrar una cédula. */
    console.error(`[documento] campos de ${eventoId}: ${error.message}`);
    return [];
  }
  return (data || []).map(f => f.id).filter(Boolean);
}

/* Las boletas del evento cuyo documento coincide exactamente.
 *
 * Devuelve ids, no boletas, porque quien llama ya tiene armada su consulta con
 * sus filtros y su paginación: lo que necesita es una condición más, no otra
 * lista que cuadrar con la suya.
 *
 * Va en consultas sueltas y no dentro de un `or(...)` con la ruta jsonb: son
 * `eq` sobre un campo, que es lo que PostgREST hace sin sorpresas, y en el caso
 * normal —un campo, un valor— es UNA consulta más y sólo cuando lo que se
 * escribió parecía un documento. */
async function boletasPorDocumento(eventoId, q) {
  const valores = valoresDeDocumento(q);
  if (!eventoId || !valores.length) return [];

  const campos = await camposDeDocumento(eventoId);
  if (!campos.length) return [];

  const supabase = require('./supabase.js');
  const ids = new Set();
  for (const campo of campos) {
    for (const valor of valores) {
      const { data, error } = await supabase
        .from('tickets')
        .select('id')
        .eq('evento_id', eventoId)
        .eq(`respuestas->>${campo}`, valor)
        .limit(TOPE);
      if (error) {
        console.error(`[documento] ${eventoId} campo ${campo}: ${error.message}`);
        continue;
      }
      for (const t of data || []) if (t?.id) ids.add(t.id);
    }
  }
  return [...ids];
}

module.exports = {
  valoresDeDocumento, camposDeDocumento, boletasPorDocumento,
  MINIMO_DIGITOS, TOPE,
};
