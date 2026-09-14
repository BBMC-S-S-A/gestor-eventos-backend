'use strict';

/* Avisar de que hay gente esperando permiso para entrar.
 *
 * ── El hueco que tapa ────────────────────────────────────────────────────
 *
 * La 0127 y la 0128 dejaron la acreditación del montaje en pie: la cuadrilla se
 * inscribe desde el enlace del stand y alguien del evento responde por ella.
 * Todo funciona menos una cosa, que es la que decide si sirve: **nada avisa**.
 *
 * Quien organiza tendría que acordarse de entrar a mirar «Quién entra». No lo
 * va a hacer, y no por descuido: la semana antes de un evento hay cuarenta
 * cosas encima. Lo que pasa entonces es que la cuadrilla llega a las seis de la
 * mañana con todo registrado y sin autorizar, y el control acaba resolviéndose
 * a gritos por teléfono o dejando pasar de palabra — que es justo lo que se
 * construyó para que no pasara.
 *
 * ── Por qué NO es un aviso por persona ───────────────────────────────────
 *
 * Un stand con seis montajistas son seis avisos, y cuarenta stands son
 * doscientos cuarenta. Eso no es avisar: es enseñar a la gente a silenciar la
 * campana, y a partir de ahí no llega nada. `aQuienLeImporta` ya lo dice en su
 * propio comentario y es la misma trampa.
 *
 * La regla es **un aviso vivo a la vez**: mientras el anterior siga sin leer, no
 * se manda otro. Cuando alguien lo lee —y entra a mirar, que es lo que se
 * quería— el siguiente registro vuelve a avisar. El número del cuerpo puede
 * quedarse corto entre medias, y por eso se dice «al menos»: la cifra exacta
 * está en la pantalla a la que lleva el aviso.
 *
 * Nada de aquí lanza. Un aviso que no se puede mandar no puede tumbar la
 * inscripción de un montajista.
 */

const TIPO = 'acreditacion';

/* Los mismos permisos que abren «Quién entra», para que un aviso nunca lleve a
   una puerta cerrada. */
const AVISADOS = ['gestionar_acreditacion', 'checkin', 'editar_evento'];

/* ── Las dos decisiones, sin base de datos ──────────────────────────────── */

/* ¿Hay ya un aviso vivo para esta persona?
 *
 * Vivo es «sin leer». No se mira la hora: un aviso de hace tres días que nadie
 * ha abierto sigue siendo el aviso que esa persona no ha visto, y mandarle otro
 * encima no lo hace más visible — sólo lo hace más fácil de ignorar. */
function hayAvisoVivo(notificaciones = []) {
  return (notificaciones || []).some(n => n.tipo === TIPO && !n.leida);
}

/* Qué dice el aviso.
 *
 * El nombre de quien acaba de inscribirse va dentro porque es lo que lo hace
 * concreto —«Ana Pérez, del stand 14» se entiende sin abrir nada—, y el número
 * va con «al menos» porque mientras el aviso siga sin leer no se manda otro y
 * la cifra envejece. */
function cuerpoDelAviso({ pendientes = 1, nombre = null, codigo = null } = {}) {
  const quien = nombre ? `${nombre}${codigo ? ` · ${codigo}` : ''}` : null;

  if (pendientes > 1) {
    const cuantos = `Al menos ${pendientes} personas esperan autorización para entrar.`;
    return quien ? `${quien}, entre otras. ${cuantos}` : cuantos;
  }
  return quien
    ? `${quien} espera autorización para entrar.`
    : 'Hay una persona esperando autorización para entrar.';
}

/* ── Lo que toca la base ────────────────────────────────────────────────── */

/* A quién avisar, y si ya tiene un aviso sin leer.
 *
 * Se consulta por evento y no por persona: son dos consultas en total en vez de
 * una por cada miembro del equipo, y en un evento con doce personas con permiso
 * eso es la diferencia entre un aviso y trece viajes a la base. */
async function avisarAcreditacionPendiente({ eventoId, ownerId = null, nombre = null, codigo = null }) {
  if (!eventoId) return { avisados: 0, motivo: 'sin_evento' };

  try {
    const supabase = require('./supabase.js');
    const { aQuienLeImporta } = require('./aQuienLeImporta.js');
    const { notificarVarios } = require('./notificar.js');

    const gente = await aQuienLeImporta(eventoId, AVISADOS, { ownerId })
      .catch(() => (ownerId ? [ownerId] : []));
    if (!gente.length) return { avisados: 0, motivo: 'nadie_a_quien_avisar' };

    /* Los avisos vivos de este evento, de una sola consulta. Si alguno de los
       destinatarios ya tiene uno sin leer, no se manda nada a nadie: el aviso
       es del evento, no de cada persona, y mandarlo «sólo a los que no lo
       tienen» acabaría en que el equipo ve números distintos. */
    const { data: vivos, error } = await supabase
      .from('notificaciones')
      .select('user_id, tipo, leida')
      .eq('evento_id', eventoId).eq('tipo', TIPO).eq('leida', false)
      .limit(50);
    /* Si la consulta falla se avisa igual. Un aviso de más es ruido; uno de
       menos es la cuadrilla en la puerta sin credencial. */
    if (!error && hayAvisoVivo(vivos)) return { avisados: 0, motivo: 'ya_avisado' };

    const pendientes = await cuantosEsperan(eventoId);
    /* Cero pendientes con alguien acabando de inscribirse significa que el tipo
       de boleta no exige autorización: no hay nada que aprobar y no se avisa. */
    if (!pendientes) return { avisados: 0, motivo: 'nada_pendiente' };

    await notificarVarios(gente, {
      tipo: 'alerta',
      titulo: 'Hay gente esperando que la autorices',
      cuerpo: cuerpoDelAviso({ pendientes, nombre, codigo }),
      link: `/eventos/${eventoId}?s=asistentes&t=acreditados`,
      eventoId,
    });
    return { avisados: gente.length, pendientes };
  } catch (e) {
    console.warn('[avisoDeAcreditacion] no se pudo avisar:', e.message);
    return { avisados: 0, motivo: 'error' };
  }
}

/* Cuántas personas están inscritas y sin autorizar en boletas que lo exigen.
 *
 * Dos consultas y no un join a propósito: `ticket_puestos` no tiene el tipo de
 * boleta, y pedirlo anidado obliga a que el select entero funcione — en un
 * servidor sin la 0127 aplicada eso devolvería error y el aviso se perdería
 * entero en vez de quedarse corto. */
async function cuantosEsperan(eventoId) {
  const supabase = require('./supabase.js');

  const { data: tipos } = await supabase
    .from('ticket_types').select('id')
    .eq('evento_id', eventoId).eq('requiere_autorizacion', true);
  const ids = (tipos || []).map(t => t.id);
  if (!ids.length) return 0;

  const { data: boletas } = await supabase
    .from('tickets').select('id').eq('evento_id', eventoId).in('ticket_type_id', ids);
  const boletaIds = (boletas || []).map(b => b.id);
  if (!boletaIds.length) return 0;

  const { count } = await supabase
    .from('ticket_puestos').select('id', { count: 'exact', head: true })
    .in('ticket_id', boletaIds)
    .is('autorizado_at', null)
    /* Un puesto vacío no espera nada: todavía no hay a quién autorizar. */
    .not('nombre', 'is', null);

  return count || 0;
}

module.exports = { avisarAcreditacionPendiente, hayAvisoVivo, cuerpoDelAviso, TIPO, AVISADOS };
