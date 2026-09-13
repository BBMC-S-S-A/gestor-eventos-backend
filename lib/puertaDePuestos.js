'use strict';

/* La puerta, cuando la boleta tiene varios puestos.
 *
 * ── Lo que estaba roto ───────────────────────────────────────────────────
 *
 * La 0118 emitía los puestos y les firmaba un QR con `pid` dentro. Lo que
 * nunca llegó a existir es el otro lado: NADIE leía ese `pid`. Ni
 * `resolverTicket`, ni `/checkin`, ni el reingreso. El escáner sacaba del
 * token el `tid` —que el QR de puesto también lleva, para que lo viejo
 * siguiera funcionando— y marcaba la BOLETA entera como usada.
 *
 * O sea que en una mesa de cuatro, la primera persona que llegaba quemaba la
 * mesa y las otras tres se quedaban en la calle con un QR válido en la mano.
 * Justo lo que los puestos venían a arreglar (`lib/puestos.js`), y el motivo
 * por el que `estadoEnLaPuerta` estaba escrita y probada desde entonces sin
 * que la llamara nadie.
 *
 * Y lo segundo: el token del puesto ROTA al transferirlo, pero verificar la
 * firma no puede notar una rotación —un token viejo lleva una firma nuestra
 * igual de buena—. Había que comparar contra la base, y no se hacía. Quien
 * vendía su puesto se quedaba con un QR que abría la puerta igual que el del
 * comprador.
 *
 * ── Lo que hace este archivo ─────────────────────────────────────────────
 *
 * Consume UN puesto por escaneo. Las reglas de quién puede pasar son puras y
 * viven en `lib/puestos.js`; aquí está lo que toca la base: leer los puestos,
 * marcar uno, y cerrar la boleta cuando ya no queda ninguno libre.
 */

const supabase = require('./supabase.js');
const { veredictoDePuesto, estadoEnLaPuerta } = require('./puestos.js');

const COLUMNAS = 'id, ticket_id, evento_id, orden, nombre, email, estado, qr_token, usado_at';

/* Los puestos de una boleta, en orden.
 *
 * Devuelve `[]` tanto si la boleta no tiene puestos —lo normal: una entrada de
 * una persona no crea ninguno— como si la tabla todavía no existe. Lo segundo
 * importa: en un despliegue sin la 0118 aplicada, esto NO puede tumbar el
 * check-in. Sin puestos se entra como se entraba antes, que es exactamente lo
 * que hace la plataforma para el 99 % de las boletas. */
async function puestosDe(ticketId) {
  if (!ticketId) return [];
  try {
    const { data, error } = await supabase
      .from('ticket_puestos').select(COLUMNAS)
      .eq('ticket_id', ticketId).order('orden', { ascending: true });
    if (error) return [];
    return data || [];
  } catch { return []; }
}

/* Marcar un puesto como entrado, con la comparación y la cerradura dentro.
 *
 * `.neq('estado', 'usado')` dentro del propio update es la cerradura, por lo
 * mismo que en la boleta (`routes/clientes.js`): en un evento hay varias
 * puertas escaneando a la vez y la cola sin conexión se vacía sola cuando
 * vuelve la red. Comparar y escribir tienen que ser una sola operación, o dos
 * escaneos del mismo puesto leen los dos «libre» y entran los dos.
 *
 * Ojo a lo que se comprueba en el `update` y no antes: además del estado, que
 * el `qr_token` siga siendo el que trae el QR. Si entre la lectura y la
 * escritura alguien transfirió el puesto, el token cambió y esta escritura ya
 * no encuentra fila — que es lo correcto: la credencial que se está
 * presentando acaba de dejar de valer. */
async function marcarPuestoUsado({ puesto, token, at }) {
  const { data, error } = await supabase
    .from('ticket_puestos')
    .update({ estado: 'usado', usado_at: at })
    .eq('id', puesto.id)
    .eq('qr_token', token)
    .neq('estado', 'usado')
    .select(COLUMNAS);

  if (error) return { ok: false, motivo: 'error', mensaje: error.message };
  if (!data || data.length === 0) {
    /* Otro escáner llegó primero, por milisegundos, o el puesto se transfirió
       en ese hueco. Se relee para decir cuál de las dos cosas fue. */
    const { data: ahora } = await supabase
      .from('ticket_puestos').select(COLUMNAS).eq('id', puesto.id).maybeSingle();
    return { ok: false, ...veredictoDePuesto({ puesto: ahora, token }), puesto: ahora };
  }
  return { ok: true, puesto: data[0] };
}

/* ¿Entró ya todo el mundo?
 *
 * Sólo MIRA; no marca la boleta. Esa escritura se queda donde estaba desde
 * siempre —el `update` con `.neq('estado','usado')` de la ruta—, y esto es a
 * propósito: es la que dispara los puntos, el aviso y las automatizaciones, y
 * duplicarla aquí haría que la ruta se encontrara la boleta ya marcada y
 * contestara «esta boleta ya fue usada» a la última persona de la mesa, que
 * acababa de entrar perfectamente.
 *
 * Así una mesa cuenta UNA asistencia y no cuatro, que es como se contaba antes
 * de los puestos y lo que la gamificación espera. */
async function seAgotoLaBoleta(ticketId) {
  const estado = estadoEnLaPuerta(await puestosDe(ticketId));
  return { agotado: estado.quedan === 0, estado };
}

/* ── Lo que usa la ruta ──────────────────────────────────────────────────
 *
 * Devuelve `{ aplica: false }` cuando esta boleta no va por puestos, y
 * entonces la ruta sigue como siempre. Cuando sí:
 *
 *   { aplica: true, ok: false, ... }   no entra, con el motivo
 *   { aplica: true, ok: true, agotado: false }   entró y queda sitio
 *   { aplica: true, ok: true, agotado: true }    entró el último
 *
 * `agotado: true` es la señal de que la ruta debe seguir con el camino normal
 * —marcar la boleta, puntos, automatizaciones—, en vez de responder aquí.
 */
async function consumirPuesto({ ticket, puestoIdDelQr, token, at, puestos: yaLeidos = null }) {
  /* La ruta ya los leyó para saber si esta boleta va por puestos, así que se
     aceptan de vuelta en vez de pedirlos otra vez: es una consulta por escaneo,
     y en una puerta eso se nota. Releerlos no daría más garantías —la cerradura
     que decide vive en el `update`, no en esta lista—. */
  const lista = yaLeidos || await puestosDe(ticket.id);
  /* Una boleta sin puestos, o con uno solo, es una entrada de una persona: el
     camino de toda la vida, intacto. */
  if (lista.length <= 1) return { aplica: false };

  let elegido;
  if (puestoIdDelQr) {
    /* QR de un puesto concreto: el de «puesto 2 de 4». */
    const puesto = lista.find(p => p.id === puestoIdDelQr);
    const v = veredictoDePuesto({ puesto, token, ticketId: ticket.id });
    if (!v.ok) return { aplica: true, ok: false, ...v, estado: estadoEnLaPuerta(lista) };
    elegido = puesto;
  } else {
    /* QR de la BOLETA en una mesa: una sola credencial para varias personas
       —el modo `contador` de la 0118, y también quien enseña el QR de la
       boleta teniendo puestos—. Aquí la puerta cuenta: cada escaneo consume el
       primer puesto libre, y se deja de abrir cuando se acaban.
       Antes, el primer escaneo marcaba la boleta y cerraba la mesa entera. */
    elegido = lista.find(p => p.estado !== 'usado');
    if (!elegido) {
      return {
        aplica: true, ok: false, motivo: 'completa',
        mensaje: 'Ya entraron todas las personas de esta boleta.',
        estado: estadoEnLaPuerta(lista),
      };
    }
    /* El puesto se marca por su id y su propio token —que puede ser null en
       `contador`, donde no se firma ninguno—, así que la cerradura de abajo se
       apoya en el estado. */
  }

  const marcado = elegido.qr_token
    ? await marcarPuestoUsado({ puesto: elegido, token: elegido.qr_token, at })
    : await marcarPuestoLibre({ puesto: elegido, at });

  if (!marcado.ok) return { aplica: true, ok: false, ...marcado, estado: estadoEnLaPuerta(lista) };

  const cierre = await seAgotoLaBoleta(ticket.id);
  return {
    aplica: true, ok: true,
    puesto: marcado.puesto,
    agotado: cierre.agotado,
    estado: cierre.estado,
  };
}

/* Un puesto sin credencial propia (modo `contador`): la cerradura es sólo el
   estado, porque no hay token que comparar. Va aparte y no como un `if` dentro
   de la otra para que no se pueda llamar por descuido sobre un puesto que SÍ
   tiene token — ahí saltarse la comparación sería saltarse la rotación. */
async function marcarPuestoLibre({ puesto, at }) {
  const { data, error } = await supabase
    .from('ticket_puestos')
    .update({ estado: 'usado', usado_at: at })
    .eq('id', puesto.id)
    .is('qr_token', null)
    .neq('estado', 'usado')
    .select(COLUMNAS);

  if (error) return { ok: false, motivo: 'error', mensaje: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false, motivo: 'usado',
      mensaje: 'Este puesto ya entró al evento.',
    };
  }
  return { ok: true, puesto: data[0] };
}

module.exports = {
  puestosDe, consumirPuesto, marcarPuestoUsado, marcarPuestoLibre,
  seAgotoLaBoleta,
};
