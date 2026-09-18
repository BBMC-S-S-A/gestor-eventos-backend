/* GESTEK — control de acceso a un evento por permisos de rol.

   assertPermiso(eventoId, userId, perms[], fields?)
     - Owner del evento: pasa siempre.
     - Miembro activo cuyo rol (event_roles.permissions) o custom_permissions
       incluye AL MENOS UNO de `perms`: pasa.
     - Miembro con `*` (co-dueño): pasa siempre — la misma regla que
       core/permisos/puede(). Borrar y transferir el evento NO pasan por aqui.
     - Si no: lanza Error('No autorizado.').
     - Evento inexistente: lanza Error('Evento no encontrado.').

   Devuelve el row del evento (con `fields`) — compatible con los
   assertOwner que cada ruta usaba (mismas strings de error). */

const supabase = require('./supabase.js');

/* ── Memoria de 30 s ────────────────────────────────────────────────────
 *
 * Cada petición del panel pasa por aquí: 2 lecturas (eventos + event_members)
 * antes de hacer nada. El 17-sep eso fueron ~61k lecturas de eventos y ~33k de
 * event_members, casi siempre las mismas dos filas preguntadas por la misma
 * estación cada pocos segundos.
 *
 * Se recuerda 30 s lo que casi nunca cambia: el dueño del evento (sólo cuando
 * se pide la forma corta `id, owner_id`, que es la de casi todas las rutas) y
 * los permisos de un miembro ACTIVO. Lo que se pierde: quitarle un permiso a
 * alguien tarda hasta 30 s en notarse. Un «no eres miembro» no se recuerda,
 * así que a quien se acaba de añadir al equipo le funciona en el acto. */
const MEMORIA_MS = 30 * 1000;
const MAX = 5000;
const memoria = new Map(); // clave → { valor, hasta }

function leer(clave) {
  const r = memoria.get(clave);
  if (!r) return undefined;
  if (r.hasta <= Date.now()) { memoria.delete(clave); return undefined; }
  return r.valor;
}
function guardar(clave, valor) {
  if (memoria.size >= MAX) memoria.delete(memoria.keys().next().value);
  memoria.set(clave, { valor, hasta: Date.now() + MEMORIA_MS });
}

async function eventoCorto(eventoId, sel) {
  const corto = sel === 'owner_id, id' || sel === 'id, owner_id';
  const clave = `ev|${eventoId}`;
  if (corto) {
    const ya = leer(clave);
    if (ya) return { ...ya };
  }
  const { data: ev, error } = await supabase
    .from('eventos').select(sel).eq('id', eventoId).maybeSingle();
  if (error) throw new Error(error.message);
  if (ev && corto) guardar(clave, { id: ev.id, owner_id: ev.owner_id });
  return ev;
}

async function permisosDeMiembro(eventoId, userId) {
  const clave = `m|${eventoId}|${userId}`;
  const ya = leer(clave);
  if (ya) return ya;
  const { data: m } = await supabase
    .from('event_members')
    .select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
    .eq('evento_id', eventoId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (!m) return null;
  const lista = [...(m.rol_detail?.permissions || []), ...(m.custom_permissions || [])];
  guardar(clave, lista);
  return lista;
}

async function assertPermiso(eventoId, userId, perms = [], fields = 'id, owner_id') {
  const sel = fields.includes('owner_id') ? fields : `owner_id, ${fields}`;
  const ev = await eventoCorto(eventoId, sel);
  if (!ev) throw new Error('Evento no encontrado.');
  if (String(ev.owner_id) === String(userId)) return ev;

  const permisos = await permisosDeMiembro(eventoId, userId);
  if (!permisos) throw new Error('No autorizado.');

  const tiene = new Set(permisos);

  /* `*` — el co-dueño.
   *
   * ── Dos guardias que no se ponian de acuerdo ────────────────────────────
   *
   * `core/permisos/puede()` trata `*` como «puede todo» y lo dice en su
   * comentario. Esta funcion —que es la que usan las 58 rutas de verdad— no lo
   * conocia: un miembro con `*` pasaba un guardia y lo paraba el otro, segun
   * cual corriera. Dos reglas distintas sobre la misma cadena.
   *
   * ── Por que hace falta ─────────────────────────────────────────────────
   *
   * En FESTECH el evento lo llevan varias organizaciones y todas mandan igual.
   * El rol mas alto, «Administrador», enumera 22 permisos y aun asi no llega a
   * cinco pantallas, porque el panel las reserva a quien figura como dueño. La
   * salida hasta hoy era compartir la cuenta del dueño.
   *
   * ── Lo que `*` NO da ───────────────────────────────────────────────────
   *
   * Borrar el evento y transferirlo comparan `owner_id` a mano, con su propio
   * comentario diciendo por que («un miembro del equipo, por mucho permiso que
   * tenga, no lo hace»). Eso sigue igual: esto no pasa por aqui. */
  const ok = tiene.has('*') || (perms || []).some(p => tiene.has(p));
  if (!ok) throw new Error('No autorizado.');
  return ev;
}

module.exports = { assertPermiso, _memoria: memoria };
