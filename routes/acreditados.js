'use strict';

/* Quién entra con esta boleta, y quién responde por él.
 *
 * ── De dónde sale ────────────────────────────────────────────────────────
 *
 * Antes del evento hay dos días de montaje: llegan cuadrillas a armar los
 * stands y el recinto se llena de herramienta suelta. Hay que distinguir a
 * quien viene a trabajar de quien pasaba por ahí.
 *
 * La tentación es meterlos en el equipo del evento. `event_members` es gente
 * con CUENTA y permisos del panel —está para operar GESTEK, no para entrar al
 * recinto—, así que obligaría a pedirle correo y contraseña a sesenta
 * montajistas que no van a abrir el panel jamás. Un montajista no es staff: es
 * una persona acreditada con una credencial de alcance limitado, y esa forma
 * ya existe desde la 0118 (`ticket_puestos`).
 *
 * ── Las dos caras de este archivo ────────────────────────────────────────
 *
 *   pública   quien tiene el código de la boleta llena sus puestos. Es el
 *             «enlace del anfitrión» que la 0118 dejó anunciado y nunca se
 *             construyó: el mismo que usa el expositor para inscribir a su
 *             cuadrilla y quien compró una mesa de cuatro para poner los
 *             nombres. No se inventa uno por caso.
 *
 *   panel     quien organiza mira quién está sin autorizar y responde por él.
 *             Es el eslabón que convierte «se registró» en «puede entrar»: si
 *             registrarse bastara, quien quiere colarse se registra y ya está.
 *
 * Migración 0127. Las reglas de la puerta viven en `lib/credenciales.js`.
 */

const express = require('express');
const supabase = require('../lib/supabase.js');
const { exige, publica } = require('../core/permisos');
const { verifySupabaseJWT } = require('../middleware/auth.js');
const { assertPermiso } = require('../lib/acceso.js');
const { auditar } = require('../lib/auditar.js');
const { signPuestoQR } = require('../lib/qr.js');

const COLS = `id, ticket_id, evento_id, orden, nombre, email, documento, telefono, foto_url,
              estado, autorizado_at, autorizado_por, credencial_gen, usado_at`;

/* Configurar la acreditación es decidir quién entra: el mismo permiso que ya
   existe para las escarapelas y el padrón, más `editar_evento` como red —la
   misma escalera que usó la 0124 para que nada se rompa antes de repartir el
   permiso fino. */
const PERMS = ['gestionar_acreditacion', 'checkin', 'editar_evento'];

/* Sólo lo que la persona acreditada puede decir de sí misma. Ni el estado, ni
   la autorización, ni el token: quien llena el formulario no se autoriza. */
const CAMPOS_DE_LA_PERSONA = ['nombre', 'email', 'documento', 'telefono', 'foto_url'];

function datosDeLaPersona(body = {}) {
  const out = {};
  for (const k of CAMPOS_DE_LA_PERSONA) {
    if (!(k in body)) continue;
    const v = body[k] === null ? null : String(body[k]).trim();
    out[k] = v || null;
  }
  if ('email' in out && out.email) out.email = out.email.toLowerCase();
  if (!out.nombre && 'nombre' in out) throw new Error('La persona necesita un nombre.');
  return out;
}

/* ══════════════ 1 · La cara pública: llenar mis puestos ══════════════
 *
 * Se entra con el CÓDIGO de la boleta, igual que el panel del expositor y que
 * «mi boleta». No es una puerta abierta: el código es la credencial, y todo va
 * forzado a los puestos de ESA boleta — cualquier id que venga del cliente se
 * ignora.
 */

const publico = express.Router();
publico.use(publica('Quien acredita a su gente se identifica con el código de su boleta, no con una cuenta: la cuadrilla de un stand no tiene usuario en la plataforma.'));

async function cargarBoleta(req, res, next) {
  const cod = String(req.params.codigo || '').toUpperCase().trim();
  if (cod.length < 4) return res.status(400).json({ error: 'Código inválido.' });

  const { data: ticket, error } = await supabase
    .from('tickets')
    .select(`id, evento_id, estado, codigo, guest_nombre,
             tipo:ticket_types!ticket_type_id(nombre, requiere_autorizacion, vigencia_desde, vigencia_hasta)`)
    .eq('codigo', cod).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ticket) return res.status(404).json({ error: 'Boleta no encontrada.' });
  if (ticket.estado === 'invalido' || ticket.estado === 'reembolsado') {
    return res.status(403).json({ error: `Esta boleta está ${ticket.estado}.` });
  }
  req.boleta = ticket;
  next();
}

/* GET /acreditar/:codigo — a quién tengo que poner, y cómo va cada uno. */
publico.get('/:codigo', cargarBoleta, async (req, res) => {
  const { data: puestos, error } = await supabase
    .from('ticket_puestos').select(COLS)
    .eq('ticket_id', req.boleta.id).order('orden');
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    boleta: { codigo: req.boleta.codigo, tipo: req.boleta.tipo?.nombre || null },
    /* Que la pantalla pueda avisar de las dos cosas ANTES de que la persona
       llene el formulario: que su credencial tiene fechas, y que no va a
       servir hasta que alguien la apruebe. Enterarse de eso en la puerta es
       llegar a las seis de la mañana para que te digan que no. */
    requiere_autorizacion: Boolean(req.boleta.tipo?.requiere_autorizacion),
    vigencia: {
      desde: req.boleta.tipo?.vigencia_desde || null,
      hasta: req.boleta.tipo?.vigencia_hasta || null,
    },
    puestos: (puestos || []).map(verPuesto),
  });
});

/* PATCH /acreditar/:codigo/puestos/:puestoId — poner (o corregir) a la persona.
 *
 * El puesto se busca por su id Y por el ticket del código: sin la segunda
 * condición, quien tenga un código cualquiera podría escribir en el puesto de
 * otra boleta pasando su id. */
publico.patch('/:codigo/puestos/:puestoId', cargarBoleta, async (req, res) => {
  const { puestoId } = req.params;
  try {
    const datos = datosDeLaPersona(req.body || {});
    if (!Object.keys(datos).length) return res.status(400).json({ error: 'Nada que cambiar.' });

    const { data: previo } = await supabase
      .from('ticket_puestos').select(COLS)
      .eq('id', puestoId).eq('ticket_id', req.boleta.id).maybeSingle();
    if (!previo) return res.status(404).json({ error: 'Ese puesto no es de esta boleta.' });
    if (previo.estado === 'usado') {
      return res.status(409).json({ error: 'Esa persona ya entró: no se le puede cambiar el nombre.' });
    }

    const cambios = { ...datos, estado: datos.nombre || previo.nombre ? 'asignado' : 'libre' };
    if (!previo.asignado_at && cambios.estado === 'asignado') cambios.asignado_at = new Date().toISOString();

    /* Cambiar de persona borra la autorización que tuviera.
     *
     * Es el hueco por donde se cuela quien quiere: se inscribe a alguien
     * presentable, se espera la aprobación y después se le cambia el nombre.
     * Con el tipo que exige autorización, cualquier cambio de nombre o de
     * documento vuelve a dejar el puesto pendiente. */
    const cambioDePersona = (datos.nombre && datos.nombre !== previo.nombre)
                         || (datos.documento && datos.documento !== previo.documento);
    if (cambioDePersona && previo.autorizado_at) {
      cambios.autorizado_at = null;
      cambios.autorizado_por = null;
      cambios.qr_token = null;
    }

    /* La credencial se firma aquí sólo si el tipo NO exige autorización — una
       mesa de cuatro, un palco. Cuando la exige, no hay QR hasta que alguien
       responda por la persona: es lo único que hace que la aprobación
       signifique algo. */
    let conCredencial = null;
    if (!req.boleta.tipo?.requiere_autorizacion && !previo.qr_token && cambios.estado === 'asignado') {
      conCredencial = signPuestoQR({
        ticket_id: req.boleta.id, evento_id: req.boleta.evento_id, codigo: req.boleta.codigo,
        puesto_id: previo.id, orden: previo.orden, gen: previo.credencial_gen || 0,
      });
      cambios.qr_token = conCredencial;
    }

    const { data, error } = await supabase
      .from('ticket_puestos').update(cambios)
      .eq('id', puestoId).eq('ticket_id', req.boleta.id)
      .select(COLS).single();
    if (error) return res.status(500).json({ error: error.message });

    await auditar({ user: null }, req.boleta.evento_id, 'puesto_acreditado', {
      entidad: 'puesto', entidadId: puestoId,
      detalle: { boleta: req.boleta.codigo, nombre: data.nombre, documento: Boolean(data.documento) },
    });

    res.json({ puesto: verPuesto(data) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ══════════════ 2 · El panel: responder por esta gente ══════════════ */

const panel = express.Router();
panel.use(verifySupabaseJWT);

/* GET /eventos/:eventoId/acreditados?pendientes=1&tipo=<ticket_type_id>
 *
 * La lista que se mira el día antes del montaje. Por defecto salen todos; con
 * `pendientes`, sólo a quien falta autorizar, que es la pregunta real. */
panel.get('/:eventoId/acreditados', exige(PERMS), async (req, res) => {
  const { eventoId } = req.params;
  const { pendientes, tipo } = req.query;
  try {
    await assertPermiso(eventoId, req.user.id, PERMS, 'id, owner_id');

    let q = supabase
      .from('ticket_puestos')
      .select(`${COLS}, boleta:tickets!ticket_id(codigo, ticket_type_id, tipo:ticket_types!ticket_type_id(nombre, requiere_autorizacion))`)
      .eq('evento_id', eventoId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (pendientes) q = q.is('autorizado_at', null);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    /* El filtro por tipo se hace aquí y no en la consulta porque cuelga de la
       boleta y no del puesto; con el tope de 500 filas es una vuelta sobre una
       lista corta, no un recorrido de la tabla. */
    const filas = (data || []).filter(p => !tipo || p.boleta?.ticket_type_id === tipo);

    res.json({
      acreditados: filas.map(p => ({
        ...verPuesto(p),
        boleta: p.boleta?.codigo || null,
        tipo: p.boleta?.tipo?.nombre || null,
        /* Para que la pantalla sepa cuáles ESTÁN esperando aprobación y cuáles
           simplemente no la necesitan. Sin esto, una mesa de cuatro aparecería
           en la lista de pendientes del montaje. */
        necesita_autorizacion: Boolean(p.boleta?.tipo?.requiere_autorizacion),
      })),
    });
  } catch (e) {
    res.status(e.message === 'No autorizado.' ? 403 : 400).json({ error: e.message });
  }
});

/* POST /eventos/:eventoId/acreditados/:puestoId/autorizar
 *
 * Aquí es donde alguien RESPONDE por esta persona, y por eso es el sitio donde
 * se firma su credencial: antes de esto no hay QR que enseñar. */
panel.post('/:eventoId/acreditados/:puestoId/autorizar', exige(PERMS), async (req, res) => {
  const { eventoId, puestoId } = req.params;
  try {
    await assertPermiso(eventoId, req.user.id, PERMS, 'id, owner_id');

    const { data: puesto } = await supabase
      .from('ticket_puestos')
      .select(`${COLS}, boleta:tickets!ticket_id(codigo, evento_id)`)
      .eq('id', puestoId).eq('evento_id', eventoId).maybeSingle();
    if (!puesto) return res.status(404).json({ error: 'Esa persona no está en este evento.' });

    /* Autorizar a nadie no es autorizar. Un puesto vacío con credencial es una
       entrada al portador, que es justo lo que este control existe para que no
       haya. */
    if (!puesto.nombre) return res.status(400).json({ error: 'Este puesto todavía no tiene a nadie.' });

    /* Y sin documento no hay nada que comparar en la puerta. Se exige aquí —al
       autorizar— y no al inscribir: quien llena el formulario a veces no lo
       tiene a mano, y bloquear ahí hace que no se inscriba nadie. */
    if (!puesto.documento) {
      return res.status(400).json({ error: 'Falta el documento: sin él la puerta no puede comprobar que es quien dice ser.' });
    }

    const qr_token = puesto.qr_token || signPuestoQR({
      ticket_id: puesto.ticket_id, evento_id: eventoId, codigo: puesto.boleta?.codigo,
      puesto_id: puesto.id, orden: puesto.orden, gen: puesto.credencial_gen || 0,
    });

    /* Quién responde, con nombre y no con un id: es lo que se lee en la puerta
       y en la auditoría cuando algo desaparece, y un uuid ahí no le dice nada
       a nadie. */
    const quien = req.user.email || req.user.id;

    const { data, error } = await supabase
      .from('ticket_puestos')
      .update({ autorizado_at: new Date().toISOString(), autorizado_por: quien, qr_token })
      .eq('id', puestoId).eq('evento_id', eventoId)
      .select(COLS).single();
    if (error) return res.status(500).json({ error: error.message });

    await auditar(req, eventoId, 'acreditado_autorizado', {
      entidad: 'puesto', entidadId: puestoId,
      detalle: { nombre: data.nombre, boleta: puesto.boleta?.codigo },
    });
    res.json({ acreditado: verPuesto(data) });
  } catch (e) {
    res.status(e.message === 'No autorizado.' ? 403 : 400).json({ error: e.message });
  }
});

/* POST /eventos/:eventoId/acreditados/:puestoId/revocar
 *
 * Se le retira la credencial: ya no entra. Existe porque las cuadrillas
 * cambian a mitad de montaje y porque a veces se autoriza a quien no era, y
 * sin esto la única salida sería borrar la fila — que se lleva por delante el
 * rastro de que esa persona estuvo dentro. */
panel.post('/:eventoId/acreditados/:puestoId/revocar', exige(PERMS), async (req, res) => {
  const { eventoId, puestoId } = req.params;
  try {
    await assertPermiso(eventoId, req.user.id, PERMS, 'id, owner_id');

    const { data, error } = await supabase
      .from('ticket_puestos')
      .update({ autorizado_at: null, autorizado_por: null, qr_token: null })
      .eq('id', puestoId).eq('evento_id', eventoId)
      .select(COLS).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Esa persona no está en este evento.' });

    await auditar(req, eventoId, 'acreditado_revocado', {
      entidad: 'puesto', entidadId: puestoId,
      detalle: { nombre: data.nombre, motivo: req.body?.motivo || null },
    });
    res.json({ acreditado: verPuesto(data) });
  } catch (e) {
    res.status(e.message === 'No autorizado.' ? 403 : 400).json({ error: e.message });
  }
});

/* El QR NUNCA sale de aquí.
 *
 * Se manda a la persona por su canal —correo, o la tarjeta que ya sabe pintar
 * la plataforma— y no en la respuesta de una lista: un listado de credenciales
 * es un listado de llaves, y basta con que alguien copie la pantalla. Lo que
 * viaja es si la tiene o no. */
function verPuesto(p) {
  return {
    id: p.id,
    orden: p.orden,
    nombre: p.nombre,
    email: p.email,
    documento: p.documento,
    telefono: p.telefono,
    foto_url: p.foto_url,
    estado: p.estado,
    autorizado_at: p.autorizado_at,
    autorizado_por: p.autorizado_por,
    tiene_credencial: Boolean(p.qr_token),
    entro_at: p.usado_at,
  };
}

module.exports = { publico, panel };
