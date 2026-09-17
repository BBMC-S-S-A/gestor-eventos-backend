'use strict';

/* Lo que incluye la credencial: el catálogo, la entrega y el recuento.
 *
 * ── Qué resuelve ─────────────────────────────────────────────────────────
 *
 * Piden entregar refrigerios y almuerzos a las dos personas de cada stand,
 * dejando constancia de a quién se le dio cada cosa. Lo que se construyó no es
 * eso, sino la frase de la que eso es un caso: una credencial da derecho a N
 * usos de algo, dentro de una ventana, y cada uso queda registrado con quién lo
 * entregó. Migración 0126; diseño en `docs/DERECHOS.md`.
 *
 * Las dos personas del stand no se inventan aquí: son los puestos de la 0118,
 * que ya tienen nombre, documento y QR propio.
 *
 * ── Cómo se reparte con el resto ─────────────────────────────────────────
 *
 * Las reglas puras —a quién le toca, qué ventana está abierta, qué número de
 * uso es éste— viven en `lib/derechos.js` y se prueban sin base. Aquí está lo
 * que escribe.
 */

const express = require('express');
const { exige, sesion } = require('../core/permisos');
const supabase = require('../lib/supabase.js');
const { verifySupabaseJWT } = require('../middleware/auth.js');
const { auditar } = require('../lib/auditar.js');
const { assertPermiso } = require('../lib/acceso.js');
const { verifyTicketQR } = require('../lib/qr.js');
const { leerEscaneo } = require('../lib/leerEscaneo.js');
const { horaDelEscaneo } = require('../lib/horaDeEscaneo.js');
const D = require('../lib/derechos.js');
const credenciales = require('../lib/credenciales.js');

const router = express.Router();
router.use(verifySupabaseJWT);

/* Configurar qué incluye una boleta es decidir qué se vende con ella, así que
   el permiso es el mismo que el de los tipos de boleta. No se inventa uno
   nuevo: obligaría a repartirlo otra vez en todos los roles que ya existen. */
const PERMS_CONFIG = ['gestionar_tickets', 'editar_evento'];

/* Entregar es otra persona y otro momento. `editar_evento` entra en la lista
   por lo mismo que hizo la 0124: sin aplicar nada, quien ya administraba el
   evento sigue pudiendo operar, y el permiso fino se reparte con calma. */
const PERMS_ENTREGA = ['entregar', 'editar_evento'];

/* Leer el catálogo lo necesita quien entrega —para elegir «Almuerzo · día 1»
   antes de escanear—, así que la lectura es más ancha que la escritura. */
const PERMS_LEER = ['entregar', 'gestionar_tickets', 'editar_evento', 'ver_clientes'];

const puedo = (eventoId, userId, perms) => assertPermiso(eventoId, userId, perms, 'id, owner_id');

const fallo = (res, e) =>
  res.status(e.message === 'No autorizado.' ? 403 : e.message === 'Evento no encontrado.' ? 404 : 400)
     .json({ error: e.message });

const COLS_DERECHO = 'id, evento_id, nombre, descripcion, titular, cadencia, usos, aplica_tipos, activo, orden, created_at';
const COLS_VENTANA = 'id, derecho_id, evento_id, nombre, inicio, fin, cupo, orden, created_at';

/* El derecho con sus ventanas, comprobando de paso que es de este evento.
   Se hace en todas las rutas que reciben `:derechoId` en la URL: sin esto, un
   id de otro evento se leería igual. */
async function derechoDelEvento(eventoId, derechoId) {
  const { data, error } = await supabase
    .from('derechos').select(COLS_DERECHO)
    .eq('id', derechoId).eq('evento_id', eventoId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Ese derecho no existe en este evento.');

  /* El error se saca junto al dato a propósito: una lista de franjas vacía
     porque la consulta falló se lee igual que un derecho sin franjas, y lo
     segundo hace que la entrega conteste «no hay ninguna franja abierta» sin
     que nada parezca roto. */
  const { data: ventanas, error: eV } = await supabase
    .from('derecho_ventanas').select(COLS_VENTANA)
    .eq('derecho_id', derechoId).order('orden').order('inicio');
  if (eV) throw new Error(eV.message);

  return { ...data, ventanas: ventanas || [] };
}

/* ── El catálogo ────────────────────────────────────────────────────────── */

/* GET /eventos/:eventoId/derechos — qué incluye este evento, con sus franjas. */
router.get('/:eventoId/derechos', exige(PERMS_LEER), async (req, res) => {
  const { eventoId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_LEER);

    const { data: derechos, error } = await supabase
      .from('derechos').select(COLS_DERECHO)
      .eq('evento_id', eventoId).order('orden').order('created_at');
    if (error) return res.status(500).json({ error: error.message });

    const { data: ventanas, error: eV } = await supabase
      .from('derecho_ventanas').select(COLS_VENTANA)
      .eq('evento_id', eventoId).order('orden').order('inicio');
    if (eV) return res.status(500).json({ error: eV.message });

    const porDerecho = new Map();
    for (const v of ventanas || []) {
      if (!porDerecho.has(v.derecho_id)) porDerecho.set(v.derecho_id, []);
      porDerecho.get(v.derecho_id).push(v);
    }

    res.json({
      derechos: (derechos || []).map(d => ({ ...d, ventanas: porDerecho.get(d.id) || [] })),
    });
  } catch (e) { fallo(res, e); }
});

/* POST /eventos/:eventoId/derechos — crear uno. */
router.post('/:eventoId/derechos', exige(PERMS_CONFIG), async (req, res) => {
  const { eventoId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_CONFIG);
    const fila = D.validarDerecho(req.body || {});

    const { data, error } = await supabase
      .from('derechos').insert({ ...fila, evento_id: eventoId })
      .select(COLS_DERECHO).single();
    if (error) return res.status(500).json({ error: error.message });

    await auditar(req, eventoId, 'derecho_creado', {
      entidad: 'derecho', entidadId: data.id,
      detalle: { nombre: data.nombre, titular: data.titular, cadencia: data.cadencia },
    });
    res.status(201).json({ derecho: { ...data, ventanas: [] } });
  } catch (e) { fallo(res, e); }
});

/* PATCH /eventos/:eventoId/derechos/:derechoId */
router.patch('/:eventoId/derechos/:derechoId', exige(PERMS_CONFIG), async (req, res) => {
  const { eventoId, derechoId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_CONFIG);
    await derechoDelEvento(eventoId, derechoId);
    const cambios = D.validarDerecho(req.body || {}, { parcial: true });
    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Nada que cambiar.' });

    const { data, error } = await supabase
      .from('derechos').update(cambios)
      .eq('id', derechoId).eq('evento_id', eventoId)
      .select(COLS_DERECHO).single();
    if (error) return res.status(500).json({ error: error.message });

    await auditar(req, eventoId, 'derecho_editado', {
      entidad: 'derecho', entidadId: derechoId, detalle: { cambios: Object.keys(cambios) },
    });
    res.json({ derecho: data });
  } catch (e) { fallo(res, e); }
});

/* DELETE /eventos/:eventoId/derechos/:derechoId
 *
 * Se borra de verdad, con sus ventanas y sus consumos detrás (la 0126 lo pone
 * en cascada). Es lo correcto para un derecho creado por error el día del
 * montaje; para uno que ya repartió comida, lo que se quiere es `activo:false`,
 * que deja el histórico. La pantalla tiene que ofrecer las dos cosas y no
 * llamar «eliminar» a las dos. */
router.delete('/:eventoId/derechos/:derechoId', exige(PERMS_CONFIG), async (req, res) => {
  const { eventoId, derechoId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_CONFIG);
    const derecho = await derechoDelEvento(eventoId, derechoId);

    const { count } = await supabase
      .from('derecho_consumos').select('id', { count: 'exact', head: true })
      .eq('derecho_id', derechoId);

    const { error } = await supabase
      .from('derechos').delete().eq('id', derechoId).eq('evento_id', eventoId);
    if (error) return res.status(500).json({ error: error.message });

    await auditar(req, eventoId, 'derecho_borrado', {
      entidad: 'derecho', entidadId: derechoId,
      detalle: { nombre: derecho.nombre, consumos_borrados: count ?? 0 },
    });
    res.json({ ok: true, consumos_borrados: count ?? 0 });
  } catch (e) { fallo(res, e); }
});

/* ── Las ventanas ───────────────────────────────────────────────────────── */

/* POST /eventos/:eventoId/derechos/:derechoId/ventanas */
router.post('/:eventoId/derechos/:derechoId/ventanas', exige(PERMS_CONFIG), async (req, res) => {
  const { eventoId, derechoId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_CONFIG);
    await derechoDelEvento(eventoId, derechoId);
    const fila = D.validarVentana(req.body || {});

    const { data, error } = await supabase
      .from('derecho_ventanas')
      .insert({ ...fila, derecho_id: derechoId, evento_id: eventoId })
      .select(COLS_VENTANA).single();
    if (error) return res.status(500).json({ error: error.message });

    await auditar(req, eventoId, 'derecho_ventana_creada', {
      entidad: 'derecho', entidadId: derechoId, detalle: { ventana: data.nombre },
    });
    res.status(201).json({ ventana: data });
  } catch (e) { fallo(res, e); }
});

/* PATCH /eventos/:eventoId/ventanas/:ventanaId */
router.patch('/:eventoId/ventanas/:ventanaId', exige(PERMS_CONFIG), async (req, res) => {
  const { eventoId, ventanaId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_CONFIG);
    const cambios = D.validarVentana(req.body || {}, { parcial: true });
    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Nada que cambiar.' });

    const { data, error } = await supabase
      .from('derecho_ventanas').update(cambios)
      .eq('id', ventanaId).eq('evento_id', eventoId)
      .select(COLS_VENTANA).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Esa franja no existe en este evento.' });

    res.json({ ventana: data });
  } catch (e) { fallo(res, e); }
});

/* DELETE /eventos/:eventoId/ventanas/:ventanaId */
router.delete('/:eventoId/ventanas/:ventanaId', exige(PERMS_CONFIG), async (req, res) => {
  const { eventoId, ventanaId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_CONFIG);
    const { error } = await supabase
      .from('derecho_ventanas').delete()
      .eq('id', ventanaId).eq('evento_id', eventoId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { fallo(res, e); }
});

/* ── La entrega ─────────────────────────────────────────────────────────── */

/* Quién es, a partir de lo que trae el escáner.
 *
 * Tres caminos y no uno porque los tres pasan el día del evento: el QR (como
 * debe ser), el código corto de la boleta, y el puesto elegido a dedo desde la
 * búsqueda por nombre — que existe porque siempre llega quien perdió el
 * teléfono, y si esa salida no es obvia el staff acaba entregando sin registrar
 * nada, que es peor. */
async function resolverTitular({ eventoId, puesto_id, ...escaneo }) {
  const { qr_token, codigo } = leerEscaneo(escaneo);
  if (qr_token) {
    const r = verifyTicketQR(qr_token);
    if (!r.ok) throw Object.assign(new Error('QR inválido.'), { http: 400, sound: 'error' });
    if (r.evento_id !== eventoId) throw Object.assign(new Error('Este QR es de otro evento.'), { http: 400, sound: 'error' });
    return { ticketId: r.ticket_id, puestoId: r.puesto_id || null, token: qr_token, gen: r.gen || 0, origen: 'qr' };
  }
  if (puesto_id) {
    const { data: p } = await supabase
      .from('ticket_puestos').select('id, ticket_id, evento_id')
      .eq('id', puesto_id).maybeSingle();
    if (!p || p.evento_id !== eventoId) throw Object.assign(new Error('Esa persona no es de este evento.'), { http: 404 });
    return { ticketId: p.ticket_id, puestoId: p.id, token: null, origen: 'manual' };
  }
  if (codigo) {
    const { data: t } = await supabase
      .from('tickets').select('id, evento_id')
      .eq('codigo', String(codigo).toUpperCase().trim()).eq('evento_id', eventoId).maybeSingle();
    if (!t) throw Object.assign(new Error('Boleta no encontrada.'), { http: 404, sound: 'error' });
    return { ticketId: t.id, puestoId: null, token: null, origen: 'manual' };
  }
  throw Object.assign(new Error('Hace falta un QR, un código o una persona.'), { http: 400 });
}

/* POST /eventos/:eventoId/consumo — entregar.
 *
 * Body: { derecho_id, qr_token | codigo | puesto_id, ventana_id?, at?, nota?, origen? }
 *
 * Calcado del control de ingreso (`routes/clientes.js`), que ya resolvió una
 * vez todos estos problemas: la hora real de un escaneo que llega tarde, el
 * token rotado que sigue teniendo firma válida, y el duplicado que decide la
 * base y no un `if`.
 */
router.post('/:eventoId/consumo', sesion('Lo opera quien reparte: la ruta comprueba el permiso `entregar` sobre el rol del miembro, no un permiso de edición del evento.'), async (req, res) => {
  const { eventoId } = req.params;
  const { derecho_id, qr_token, codigo, puesto_id, ventana_id, at, nota, origen } = req.body || {};
  if (!derecho_id) return res.status(400).json({ error: 'Falta qué se está entregando.' });

  /* La hora REAL de la entrega. Sin esto, todo lo que entregó una tableta sin
     señal aparecería apelotonado en el minuto en que volvió el wifi. */
  const entregadoAt = horaDelEscaneo(at);

  try {
    await puedo(eventoId, req.user.id, PERMS_ENTREGA);
    const derecho = await derechoDelEvento(eventoId, derecho_id);
    if (!derecho.activo) return res.status(400).json({ error: `${derecho.nombre} está desactivado.` });

    const quien = await resolverTitular({ eventoId, qr_token, codigo, puesto_id });

    /* La boleta: hace falta su tipo para saber si el derecho le aplica, y su
       estado para no repartir sobre una anulada. */
    const { data: ticket } = await supabase
      .from('tickets')
      .select('id, evento_id, estado, codigo, guest_nombre, guest_email, ticket_type_id, tipo:ticket_types!ticket_type_id(nombre)')
      .eq('id', quien.ticketId).maybeSingle();
    if (!ticket || ticket.evento_id !== eventoId) {
      return res.status(404).json({ error: 'Boleta no encontrada.', sound: 'error' });
    }
    if (ticket.estado === 'invalido' || ticket.estado === 'reembolsado') {
      return res.status(400).json({ error: `Boleta ${ticket.estado}.`, sound: 'error' });
    }

    if (!D.aplicaATipo(derecho, ticket.ticket_type_id)) {
      return res.status(403).json({
        error: `Esta boleta (${ticket.tipo?.nombre || 'sin tipo'}) no incluye ${derecho.nombre}.`,
        sound: 'error',
      });
    }

    /* La persona, cuando el QR es de un puesto.
     *
     * Y aquí el token se compara con el que guarda la base, no sólo se
     * verifica su firma. Un puesto transferido rota su credencial, pero el
     * token viejo sigue llevando una firma válida y los QR no caducan: sin
     * esta comparación, quien vendió su puesto se queda con un QR que recoge
     * el almuerzo del comprador. Es el mismo agujero que se cerró en la
     * puerta. */
    let persona = null;
    if (quien.puestoId) {
      const { data: p } = await supabase
        .from('ticket_puestos').select('id, ticket_id, orden, nombre, email, documento, qr_token, credencial_gen')
        .eq('id', quien.puestoId).maybeSingle();
      if (!p || p.ticket_id !== ticket.id) {
        return res.status(404).json({ error: 'Esa persona no está en esta boleta.', sound: 'error' });
      }
      /* No se compara el token con el guardado: eso mata también el QR de un
         reenvío legítimo —el correo se pierde y se manda otra vez, y cada
         envío firma un token nuevo del mismo puesto—. Lo que invalida es la
         generación, que sube sólo al transferir (0127). */
      /* Sólo cuando hay QR: la entrega a mano (buscando por nombre) no
         presenta credencial ninguna, y medirle la generación la rechazaría
         siempre en un puesto ya transferido — a la persona correcta. */
      if (quien.token && !credenciales.credencialAlDia({ genDelToken: quien.gen, puesto: p })) {
        return res.status(409).json({ error: 'Credencial vencida: este puesto se transfirió.', sound: 'error' });
      }
      persona = p;
    } else {
      persona = { nombre: ticket.guest_nombre, email: ticket.guest_email };
    }

    const titular = D.titularDe(derecho, { ticketId: ticket.id, puestoId: quien.puestoId });
    const { ventana, aviso } = D.resolverVentana({
      derecho, ventanas: derecho.ventanas, ventanaId: ventana_id || null, at: entregadoAt,
    });

    /* Lo que ya tiene, para saber qué número de uso toca. No es la última
       palabra —entre leerlo y escribirlo cabe otra tableta—, sólo el número que
       se intenta. La última palabra es el índice único. */
    let previos = supabase
      .from('derecho_consumos').select('id, uso_num, entregado_at, operador_id')
      .eq('derecho_id', derecho.id).eq('ticket_id', titular.ticket_id);
    previos = titular.puesto_id
      ? previos.eq('puesto_id', titular.puesto_id)
      : previos.is('puesto_id', null);
    previos = ventana ? previos.eq('ventana_id', ventana.id) : previos.is('ventana_id', null);
    const { data: yaTiene } = await previos;

    const uso = D.siguienteUso(derecho, yaTiene || []);
    if (uso == null) {
      return res.status(409).json(D.yaLoRecibio({
        derecho, consumo: (yaTiene || [])[0],
        operador: await nombreDelOperador((yaTiene || [])[0]?.operador_id),
      }));
    }

    const { data: consumo, error } = await supabase
      .from('derecho_consumos').insert({
        evento_id: eventoId,
        derecho_id: derecho.id,
        ventana_id: ventana?.id || null,
        ticket_id: titular.ticket_id,
        puesto_id: titular.puesto_id,
        uso_num: uso,
        operador_id: req.user.id,
        entregado_at: entregadoAt,
        origen: D.ORIGENES.includes(origen) ? origen : quien.origen,
        nota: nota || null,
      })
      .select('id, entregado_at, uso_num, operador_id').single();

    /* El duplicado lo dice la base.
     *
     * Es todo el motivo de la 0126: un `if` lee «¿ya almorzó?» y luego escribe
     * «almorzó», y entre las dos cosas caben las tres tabletas de la fila y la
     * cola sin conexión vaciándose sola. El choque contra el índice único no
     * es un error del sistema: es la respuesta correcta llegando por el único
     * camino que no se puede colar. */
    if (error) {
      if (!D.esDuplicado(error)) return res.status(500).json({ error: error.message });
      const { data: elPrimero } = await (() => {
        let q = supabase.from('derecho_consumos')
          .select('id, entregado_at, operador_id')
          .eq('derecho_id', derecho.id).eq('ticket_id', titular.ticket_id).eq('uso_num', uso);
        q = titular.puesto_id ? q.eq('puesto_id', titular.puesto_id) : q.is('puesto_id', null);
        q = ventana ? q.eq('ventana_id', ventana.id) : q.is('ventana_id', null);
        return q.maybeSingle();
      })();
      return res.status(409).json(D.yaLoRecibio({
        derecho, consumo: elPrimero,
        operador: await nombreDelOperador(elPrimero?.operador_id),
      }));
    }

    /* El cupo advierte y no bloquea: ver `lib/derechos.js`. La cuenta va
       después de escribir, para no gastar una consulta por escaneo en la
       inmensa mayoría de entregas que no llegan al tope. */
    const avisos = [aviso];
    if (ventana?.cupo != null) {
      const { count } = await supabase
        .from('derecho_consumos').select('id', { count: 'exact', head: true })
        .eq('ventana_id', ventana.id);
      if ((count ?? 0) > ventana.cupo) avisos.push(`Van ${count} de ${ventana.cupo} raciones.`);
    }

    await auditar(req, eventoId, 'consumo_entregado', {
      entidad: 'derecho', entidadId: derecho.id,
      detalle: {
        consumo: consumo.id, ticket: ticket.codigo, puesto: titular.puesto_id,
        ventana: ventana?.nombre || null, uso: consumo.uso_num, origen: quien.origen,
      },
    });

    res.json({
      ...D.veredicto({ derecho, ventana, persona, uso: consumo.uso_num, avisos }),
      consumo_id: consumo.id,
      entregado_at: consumo.entregado_at,
      boleta: { codigo: ticket.codigo, tipo: ticket.tipo?.nombre || null },
    });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message, sound: e.sound || 'error' });
    fallo(res, e);
  }
});

/* Quién entregó algo, para poder decirlo en la pantalla del duplicado. */
async function nombreDelOperador(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('profiles').select('nombre, email').eq('id', userId).maybeSingle();
  return data || null;
}

/* DELETE /eventos/:eventoId/consumos/:consumoId — deshacer una entrega.
 *
 * Existe porque se escanea a la persona equivocada, y sin esto esa persona se
 * queda sin almorzar el resto del día con el sistema diciendo que ya comió. Se
 * borra la fila (para que el índice único vuelva a dejar entregar) y queda en
 * auditoría, que es donde tiene que estar el rastro de una corrección. */
router.delete('/:eventoId/consumos/:consumoId', sesion('Lo opera quien reparte: corregir un escaneo equivocado es parte de entregar, y la ruta comprueba el permiso `entregar`.'), async (req, res) => {
  const { eventoId, consumoId } = req.params;
  try {
    await puedo(eventoId, req.user.id, PERMS_ENTREGA);

    const { data: previo } = await supabase
      .from('derecho_consumos')
      .select('id, derecho_id, ventana_id, ticket_id, puesto_id, uso_num, entregado_at, operador_id')
      .eq('id', consumoId).eq('evento_id', eventoId).maybeSingle();
    if (!previo) return res.status(404).json({ error: 'Esa entrega no existe en este evento.' });

    const { error } = await supabase
      .from('derecho_consumos').delete().eq('id', consumoId).eq('evento_id', eventoId);
    if (error) return res.status(500).json({ error: error.message });

    await auditar(req, eventoId, 'consumo_deshecho', {
      entidad: 'derecho', entidadId: previo.derecho_id,
      detalle: {
        consumo: consumoId, ticket: previo.ticket_id, puesto: previo.puesto_id,
        entregado_at: previo.entregado_at, lo_entrego: previo.operador_id,
        motivo: req.body?.motivo || null,
      },
    });
    res.json({ ok: true });
  } catch (e) { fallo(res, e); }
});

/* ── El recuento ────────────────────────────────────────────────────────── */

/* GET /eventos/:eventoId/derechos/:derechoId/consumos?ventana_id=
 *
 * El reporte: quién recibió qué, cuándo y de manos de quién. Es la petición
 * original —«que se sepa a quién se le entregaron»— y la que se pierde cuando
 * esto se resuelve con una casilla en una hoja de cálculo. */
router.get('/:eventoId/derechos/:derechoId/consumos', exige(PERMS_LEER), async (req, res) => {
  const { eventoId, derechoId } = req.params;
  const { ventana_id } = req.query;
  try {
    await puedo(eventoId, req.user.id, PERMS_LEER);
    const derecho = await derechoDelEvento(eventoId, derechoId);

    let q = supabase
      .from('derecho_consumos')
      .select(`id, ventana_id, uso_num, origen, nota, entregado_at, operador_id,
               puesto:ticket_puestos!puesto_id(id, orden, nombre, email, documento),
               boleta:tickets!ticket_id(id, codigo, guest_nombre, guest_email)`)
      .eq('evento_id', eventoId).eq('derecho_id', derechoId)
      .order('entregado_at', { ascending: false });
    if (ventana_id) q = q.eq('ventana_id', ventana_id);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    /* Los nombres de quienes entregaron, de una consulta y no una por fila: en
       una franja de almuerzo son cuatrocientas filas y cuatro operadores. */
    const ids = [...new Set((data || []).map(c => c.operador_id).filter(Boolean))];
    const porId = new Map();
    if (ids.length) {
      const { data: gente } = await supabase
        .from('profiles').select('id, nombre, email').in('id', ids);
      for (const p of gente || []) porId.set(p.id, p);
    }

    res.json({
      derecho: { id: derecho.id, nombre: derecho.nombre, ventanas: derecho.ventanas },
      consumos: (data || []).map(c => ({
        id: c.id,
        ventana_id: c.ventana_id,
        uso_num: c.uso_num,
        origen: c.origen,
        nota: c.nota,
        entregado_at: c.entregado_at,
        recibio: c.puesto?.nombre || c.boleta?.guest_nombre || null,
        documento: c.puesto?.documento || null,
        boleta: c.boleta?.codigo || null,
        entrego: porId.get(c.operador_id)?.nombre || porId.get(c.operador_id)?.email || null,
      })),
    });
  } catch (e) { fallo(res, e); }
});

/* GET /eventos/:eventoId/derechos/:derechoId/recuento?ventana_id=
 *
 * Cuántos van y cuántos faltan. Es lo que la cocina pregunta cada media hora, y
 * lo que decide si hay que ir a buscar a los que no han comido. */
router.get('/:eventoId/derechos/:derechoId/recuento', exige(PERMS_LEER), async (req, res) => {
  const { eventoId, derechoId } = req.params;
  const { ventana_id } = req.query;
  try {
    await puedo(eventoId, req.user.id, PERMS_LEER);
    const derecho = await derechoDelEvento(eventoId, derechoId);

    const ventana = ventana_id
      ? derecho.ventanas.find(v => String(v.id) === String(ventana_id))
      : D.ventanaVigente(derecho.ventanas);

    let q = supabase
      .from('derecho_consumos').select('id', { count: 'exact', head: true })
      .eq('evento_id', eventoId).eq('derecho_id', derechoId);
    q = ventana ? q.eq('ventana_id', ventana.id) : q.is('ventana_id', null);
    const { count: entregados } = await q;

    res.json({
      ventana: ventana ? { id: ventana.id, nombre: ventana.nombre } : null,
      ...D.recuento({
        entregados: entregados ?? 0,
        conDerecho: await cuantosTienenDerecho(eventoId, derecho),
        cupo: ventana?.cupo ?? null,
      }),
    });
  } catch (e) { fallo(res, e); }
});

/* A cuánta gente le toca este derecho.
 *
 * Cuenta personas y no boletas cuando el derecho es por persona: una mesa de
 * cuatro son cuatro almuerzos. Es la misma cuenta que hace el aforo, y por eso
 * mira `ticket_puestos` — si estos dos números se separan, el recuento de la
 * cocina deja de cuadrar con la puerta.
 *
 * Las boletas anuladas y reembolsadas no cuentan: nadie va a venir a recoger
 * el almuerzo de una boleta que no existe, y contarlas hace que «faltan 12»
 * mande a alguien a buscar a gente que no está. */
const NO_CUENTAN = ['invalido', 'reembolsado'];

async function cuantosTienenDerecho(eventoId, derecho) {
  const tipos = Array.isArray(derecho.aplica_tipos) ? derecho.aplica_tipos : [];

  let q = supabase.from('tickets').select('id').eq('evento_id', eventoId)
    .not('estado', 'in', `(${NO_CUENTAN.join(',')})`);
  if (tipos.length) q = q.in('ticket_type_id', tipos);
  const { data: boletas } = await q;
  const ids = (boletas || []).map(t => t.id);
  if (!ids.length) return 0;
  if (derecho.titular === 'grupo') return ids.length;

  const { count } = await supabase
    .from('ticket_puestos').select('id', { count: 'exact', head: true })
    .in('ticket_id', ids);

  /* Sin puestos, cada boleta es una persona: es lo que pasa con las boletas de
     antes de la 0118, que son casi todas. */
  return count ? count : ids.length;
}

/* GET /eventos/:eventoId/derechos/:derechoId/pendientes?ventana_id=
 *
 * A quién le falta. Es la pregunta de las 14:30, cuando quedan raciones y hay
 * que ir a buscar a los stands que no han bajado a comer. */
router.get('/:eventoId/derechos/:derechoId/pendientes', exige(PERMS_LEER), async (req, res) => {
  const { eventoId, derechoId } = req.params;
  const { ventana_id } = req.query;
  try {
    await puedo(eventoId, req.user.id, PERMS_LEER);
    const derecho = await derechoDelEvento(eventoId, derechoId);
    const ventana = ventana_id
      ? derecho.ventanas.find(v => String(v.id) === String(ventana_id))
      : D.ventanaVigente(derecho.ventanas);

    const tipos = Array.isArray(derecho.aplica_tipos) ? derecho.aplica_tipos : [];
    let qb = supabase.from('tickets')
      .select('id, codigo, guest_nombre, guest_email')
      .eq('evento_id', eventoId)
      .not('estado', 'in', `(${NO_CUENTAN.join(',')})`);
    if (tipos.length) qb = qb.in('ticket_type_id', tipos);
    const { data: boletas } = await qb;
    const ids = (boletas || []).map(t => t.id);
    if (!ids.length) return res.json({ pendientes: [] });

    const { data: puestos } = await supabase
      .from('ticket_puestos').select('id, ticket_id, orden, nombre, email, documento')
      .in('ticket_id', ids);

    let qc = supabase.from('derecho_consumos')
      .select('ticket_id, puesto_id')
      .eq('evento_id', eventoId).eq('derecho_id', derechoId);
    qc = ventana ? qc.eq('ventana_id', ventana.id) : qc.is('ventana_id', null);
    const { data: hechos } = await qc;

    const yaFue = new Set((hechos || []).map(c => String(c.puesto_id || c.ticket_id)));
    const porBoleta = new Map((boletas || []).map(t => [t.id, t]));

    const candidatos = derecho.titular === 'grupo' || !(puestos || []).length
      ? (boletas || []).map(t => ({
          clave: String(t.id), ticket_id: t.id, boleta: t.codigo,
          nombre: t.guest_nombre, email: t.guest_email, documento: null,
        }))
      : (puestos || []).map(p => ({
          clave: String(p.id), ticket_id: p.ticket_id, puesto_id: p.id,
          boleta: porBoleta.get(p.ticket_id)?.codigo || null,
          nombre: p.nombre || `Puesto ${p.orden}`,
          email: p.email, documento: p.documento,
        }));

    res.json({
      ventana: ventana ? { id: ventana.id, nombre: ventana.nombre } : null,
      pendientes: candidatos.filter(c => !yaFue.has(c.clave)),
    });
  } catch (e) { fallo(res, e); }
});

module.exports = router;
