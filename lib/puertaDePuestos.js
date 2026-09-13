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
const {
  veredictoDePuesto, estadoEnLaPuerta, vaivenDeLaMesa, PUERTA_CERRADA,
} = require('./puestos.js');

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

/* ── El ir y venir de cada persona de la mesa ───────────────────────────── */

/* Quién de la mesa está dentro AHORA, según el último movimiento de cada uno.
 *
 * Acotado a la zona cuando se pide, por lo mismo que el vaivén de una boleta
 * normal: se puede estar dentro del recinto y fuera de una zona concreta.
 *
 * El punto de partida, para quien no tenga ningún movimiento todavía, es su
 * propio estado: un puesto `usado` entró por el check-in y está dentro. Sin
 * eso, la primera salida de la noche se registraría como una entrada.
 */
async function quienEstaDentro({ puestos, zona = null }) {
  const ids = puestos.map(p => p.id);
  if (!ids.length) return [];

  let ultimos = new Map();
  try {
    let q = supabase
      .from('ticket_movimientos')
      .select('puesto_id, tipo, created_at, zona, zona_id')
      .in('puesto_id', ids)
      .order('created_at', { ascending: true });
    const { data, error } = await q;
    if (error) throw error;

    for (const m of data || []) {
      /* El histórico anterior a la 0079 sólo guardó el nombre de la zona, así
         que vale cualquiera de las dos formas — igual que hace el vaivén de la
         boleta. Sin zona pedida, sólo cuentan los movimientos sin zona: son el
         ir y venir del recinto, no el de una sala. */
      const deEstaZona = zona
        ? (m.zona_id === zona.id || (zona.nombre && m.zona === zona.nombre))
        : (!m.zona_id && !m.zona);
      if (!deEstaZona) continue;
      /* Van en orden ascendente, así que el último que se escribe gana. */
      ultimos.set(m.puesto_id, m.tipo);
    }
  } catch {
    /* Sin la 0125 aplicada no existe `puesto_id`: se cae al estado del puesto,
       que es lo que había antes de que el vaivén supiera de personas. */
    ultimos = new Map();
  }

  return puestos
    .filter((p) => {
      const ult = ultimos.get(p.id);
      if (ult) return ult === 'entrada';
      /* Sin movimientos propios: dentro si entró por la puerta. En una zona no
         se asume nada — entrar al recinto no es entrar a la sala. */
      return zona ? false : p.estado === 'usado';
    })
    .map(p => p.id);
}

/* El movimiento que toca escribir: de quién y en qué sentido.
 *
 * Devuelve `{ aplica: false }` cuando la boleta no va por puestos, y entonces
 * la ruta lleva el vaivén de la boleta como siempre.
 */
async function vaivenDePuesto({ ticket, puestoIdDelQr, tipoPedido, zona = null, puestos: yaLeidos = null }) {
  const lista = yaLeidos || await puestosDe(ticket.id);
  if (lista.length <= 1) return { aplica: false };

  const dentro = await quienEstaDentro({ puestos: lista, zona });

  /* El QR dice de quién es: se alterna el de esa persona y no se elige nada. */
  if (puestoIdDelQr) {
    const puesto = lista.find(p => p.id === puestoIdDelQr);
    if (!puesto) {
      return { aplica: true, ok: false, motivo: 'no_existe', mensaje: PUERTA_CERRADA.no_existe };
    }
    const estaDentro = dentro.includes(puesto.id);
    const tipo = (tipoPedido === 'entrada' || tipoPedido === 'salida')
      ? tipoPedido
      : (estaDentro ? 'salida' : 'entrada');
    return { aplica: true, ok: true, tipo, puesto, dentro: dentro.length };
  }

  /* El QR de la boleta: una sola credencial para toda la mesa. Se elige por el
     sentido — al entrar alguien que esté fuera, al salir alguien que esté
     dentro—. No dice QUIÉN, pero la cuenta queda bien, que es lo que el aforo
     necesita. */
  const v = vaivenDeLaMesa({ puestos: lista, dentro, tipoPedido });
  if (!v.ok) return { aplica: true, ok: false, motivo: v.motivo, mensaje: v.mensaje };
  return { aplica: true, ok: true, tipo: v.tipo, puesto: v.puesto, dentro: dentro.length };
}

module.exports = {
  puestosDe, consumirPuesto, marcarPuestoUsado, marcarPuestoLibre,
  seAgotoLaBoleta, quienEstaDentro, vaivenDePuesto,
};
