/* Lo que incluye la credencial (0126).
 *
 * ── Qué se cuida ─────────────────────────────────────────────────────────
 *
 * Que el almuerzo, la camiseta y el parqueadero sigan siendo configuración y
 * no tres desarrollos: casi todas estas pruebas son la misma función con otro
 * `titular` y otra `cadencia`.
 *
 * Y sobre todo, que la regla de verdad —«uno por persona y por ventana»— NO
 * esté aquí. Vive en un índice único de la base, y lo que se prueba en este
 * archivo es que el código la respeta y sabe traducir el choque; que el índice
 * existe se comprueba contra Postgres, con el `insert` repetido que está al
 * final de la migración.
 *
 * Correr: npm test */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../lib/derechos.js');

const leer = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r/g, '');

/* Los tres casos de la petición original, escritos como configuración. */
const ALMUERZO = { id: 'd1', nombre: 'Almuerzo', titular: 'persona', cadencia: 'ventana', usos: 1, aplica_tipos: [] };
const AGUAS    = { id: 'd2', nombre: 'Agua', titular: 'grupo', cadencia: 'ventana', usos: 2, aplica_tipos: [] };
const CAMISETA = { id: 'd3', nombre: 'Camiseta', titular: 'persona', cadencia: 'total', usos: 1, aplica_tipos: [] };

const V = (id, nombre, desde, hasta, extra = {}) =>
  ({ id, nombre, inicio: desde ? `2026-09-17T${desde}:00Z` : null, fin: hasta ? `2026-09-17T${hasta}:00Z` : null, ...extra });

const EN = (h) => new Date(`2026-09-17T${h}:00Z`).getTime();

/* ── A quién le toca ─────────────────────────────────────────────────── */

test('un derecho sin tipos aplica a todas las boletas, y con tipos sólo a ésos', () => {
  /* La lista vacía como «a todas» es cómoda y es una trampa: reparte almuerzo a
     los 2.000 asistentes en vez de a los 40 expositores. Se prueba que las dos
     lecturas son las que se documentaron, porque la pantalla de configuración
     tiene que avisar apoyándose en esto. */
  assert.equal(D.aplicaATipo(ALMUERZO, 'tt-cualquiera'), true);

  const soloExpositores = { ...ALMUERZO, aplica_tipos: ['tt-expo'] };
  assert.equal(D.aplicaATipo(soloExpositores, 'tt-expo'), true);
  assert.equal(D.aplicaATipo(soloExpositores, 'tt-general'), false);
});

test('el titular es la persona o la boleta, y ésa es la diferencia entre comer y no', () => {
  /* Dos personas en el stand. Con `persona`, cada una tiene su almuerzo. Con
     `grupo`, son almuerzos del stand y se los puede comer quien esté. */
  const porPersona = D.titularDe(ALMUERZO, { ticketId: 'tk1', puestoId: 'p1' });
  assert.deepEqual(porPersona, { ticket_id: 'tk1', puesto_id: 'p1' });

  const delGrupo = D.titularDe(AGUAS, { ticketId: 'tk1', puestoId: 'p1' });
  assert.deepEqual(delGrupo, { ticket_id: 'tk1', puesto_id: null },
    'un derecho de grupo tiene que olvidar el puesto: si no, el índice único lo cuenta por persona');
});

test('un consumo sin boleta no se puede escribir', () => {
  assert.throws(() => D.titularDe(ALMUERZO, { puestoId: 'p1' }), /boleta/i);
});

/* ── La ventana ──────────────────────────────────────────────────────── */

test('la ventana vigente es la que está abierta ahora', () => {
  const ventanas = [V('v1', 'Refrigerio mañana', '09', '11'), V('v2', 'Almuerzo', '12', '15')];

  assert.equal(D.ventanaVigente(ventanas, EN('12:30'))?.id, 'v2');
  assert.equal(D.ventanaVigente(ventanas, EN('10:00'))?.id, 'v1');
  assert.equal(D.ventanaVigente(ventanas, EN('16:00')), null);
});

test('una ventana sin horas está siempre abierta', () => {
  /* «El kit, cuando lleguen». No es un caso raro: es lo normal en la
     acreditación. */
  assert.equal(D.ventanaVigente([V('v1', 'Kit', null, null)], EN('03:00'))?.id, 'v1');
});

test('con dos ventanas solapadas gana la que abrió más tarde', () => {
  /* El refrigerio que se alarga sobre el almuerzo. Lo que se está sirviendo es
     lo último que abrió; sin una regla, la elección dependía del orden en que
     salieran de la base. */
  const ventanas = [V('v1', 'Refrigerio', '09', '13'), V('v2', 'Almuerzo', '12', '15')];
  assert.equal(D.ventanaVigente(ventanas, EN('12:30'))?.id, 'v2');
});

test('fuera de ventana se entrega igual, avisando', () => {
  /* Deliberado: quedarse con la comida en la mano y una persona delante sin
     poder entregarla es peor que servir a destiempo. */
  const ventanas = [V('v1', 'Almuerzo', '12', '15')];
  const r = D.resolverVentana({ derecho: ALMUERZO, ventanas, ventanaId: 'v1', at: '2026-09-17T16:00:00Z' });

  assert.equal(r.ventana.id, 'v1', 'se entrega');
  assert.match(r.aviso, /no está abierta/i, 'y queda constancia de que fue a destiempo');
});

test('sin ninguna franja abierta y sin elegir, no se inventa dónde anotarlo', () => {
  const ventanas = [V('v1', 'Almuerzo', '12', '15')];
  assert.throws(
    () => D.resolverVentana({ derecho: ALMUERZO, ventanas, at: '2026-09-17T18:00:00Z' }),
    /franja abierta/i);
});

test('una franja de otro derecho no sirve para entregar éste', () => {
  assert.throws(
    () => D.resolverVentana({ derecho: ALMUERZO, ventanas: [V('v1', 'Almuerzo', '12', '15')], ventanaId: 'v9' }),
    /no es de este derecho/i);
});

test('un derecho total no tiene ventana y no la pide', () => {
  const r = D.resolverVentana({ derecho: CAMISETA, ventanas: [] });
  assert.equal(r.ventana, null);
  assert.equal(r.aviso, null);
});

/* ── El tope ─────────────────────────────────────────────────────────── */

test('el segundo almuerzo de la misma persona no tiene número que usar', () => {
  assert.equal(D.siguienteUso(ALMUERZO, []), 1);
  assert.equal(D.siguienteUso(ALMUERZO, [{ uso_num: 1 }]), null);
});

test('un derecho de dos usos entrega dos y rechaza el tercero', () => {
  assert.equal(D.siguienteUso(AGUAS, []), 1);
  assert.equal(D.siguienteUso(AGUAS, [{ uso_num: 1 }]), 2);
  assert.equal(D.siguienteUso(AGUAS, [{ uso_num: 1 }, { uso_num: 2 }]), null);
});

test('un hueco en el medio se reutiliza', () => {
  /* Pasa al deshacer una entrega equivocada: se borró el uso 1 y quedó el 2.
     Si el siguiente número fuera «el último más uno», la persona se quedaría
     sin su agua con una libre. */
  assert.equal(D.siguienteUso(AGUAS, [{ uso_num: 2 }]), 1);
});

test('el duplicado se reconoce por el código de Postgres, no por el texto', () => {
  /* El texto del error cambia con el idioma del servidor. Una comparación de
     cadenas que falle aquí convierte un «ya comió» en un error 500. */
  assert.equal(D.esDuplicado({ code: '23505', message: 'cualquier cosa en otro idioma' }), true);
  assert.equal(D.esDuplicado({ code: '23503', message: 'foreign key' }), false);
  assert.equal(D.esDuplicado(null), false);
});

/* ── Lo que ve quien entrega ─────────────────────────────────────────── */

test('el duplicado dice la hora y quién lo entregó', () => {
  /* «Ya lo recibió» a secas deja al operador discutiendo con la persona
     delante. Con la hora y el nombre, se resuelve. */
  const r = D.yaLoRecibio({
    derecho: ALMUERZO,
    consumo: { entregado_at: '2026-09-17T17:14:00Z' },
    operador: { nombre: 'María' },
  });
  assert.equal(r.ya_entregado, true);
  assert.equal(r.entregado_por, 'María');
  assert.match(r.error, /Almuerzo/);
});

test('el veredicto dice cuál de los usos es, sólo cuando hay más de uno', () => {
  assert.equal(D.veredicto({ derecho: ALMUERZO, uso: 1, persona: {} }).titulo, 'Almuerzo');
  assert.equal(D.veredicto({ derecho: AGUAS, uso: 2, persona: {} }).titulo, 'Agua (2 de 2)');
});

test('los avisos vacíos no llegan a la pantalla', () => {
  /* Con cien personas en la fila, un aviso en blanco es ruido que tapa el
     veredicto. */
  const r = D.veredicto({ derecho: ALMUERZO, persona: {}, avisos: [null, undefined, 'Van 201 de 200.'] });
  assert.deepEqual(r.avisos, ['Van 201 de 200.']);
});

/* ── El recuento ─────────────────────────────────────────────────────── */

test('el recuento dice cuántos faltan, y avisa del cupo sin bloquear', () => {
  const r = D.recuento({ entregados: 38, conDerecho: 40, cupo: 40 });
  assert.equal(r.faltan, 2);
  assert.equal(r.sobre_cupo, false);

  assert.equal(D.recuento({ entregados: 40, conDerecho: 40, cupo: 40 }).sobre_cupo, true);
  assert.equal(D.recuento({ entregados: 100, conDerecho: 40, cupo: null }).sobre_cupo, false,
    'sin cupo no hay nada de qué avisar');
});

test('faltan nunca es negativo', () => {
  /* Pasa de verdad: se entregó a alguien de un tipo de boleta que se quitó del
     derecho después. Un «faltan -3» en la pantalla de la cocina no significa
     nada. */
  assert.equal(D.recuento({ entregados: 45, conDerecho: 40 }).faltan, 0);
});

/* ── La configuración ────────────────────────────────────────────────── */

test('un derecho sin nombre no se guarda', () => {
  assert.throws(() => D.validarDerecho({}), /nombre/i);
  assert.throws(() => D.validarDerecho({ nombre: '   ' }), /nombre/i);
});

test('los usos tienen tope', () => {
  /* Sin tope, el 100 escrito donde iba 1 se descubre cuando alguien se ha
     llevado cien almuerzos. */
  assert.throws(() => D.validarDerecho({ nombre: 'X', usos: 0 }), /usos/i);
  assert.throws(() => D.validarDerecho({ nombre: 'X', usos: 1000 }), /usos/i);
  assert.equal(D.validarDerecho({ nombre: 'X', usos: 3 }).usos, 3);
});

test('titular y cadencia sólo aceptan lo que la base acepta', () => {
  /* El `check` de la 0126 rechazaría estos valores con un error 500 y un texto
     de Postgres. Mejor pararlos aquí con algo legible. */
  assert.throws(() => D.validarDerecho({ nombre: 'X', titular: 'stand' }), /titular/i);
  assert.throws(() => D.validarDerecho({ nombre: 'X', cadencia: 'diaria' }), /cadencia/i);
});

test('una ventana que termina antes de empezar no se guarda', () => {
  /* No da ningún error por sí sola: se queda cerrada todo el evento y nadie
     sabe por qué. */
  assert.throws(
    () => D.validarVentana({ nombre: 'Almuerzo', inicio: '2026-09-17T15:00:00Z', fin: '2026-09-17T12:00:00Z' }),
    /antes de empezar/i);
});

test('el cupo es un número de raciones o nada', () => {
  assert.equal(D.validarVentana({ nombre: 'A', cupo: '' }).cupo, null);
  assert.equal(D.validarVentana({ nombre: 'A', cupo: 200 }).cupo, 200);
  assert.throws(() => D.validarVentana({ nombre: 'A', cupo: -1 }), /cupo/i);
});

test('lo que no está en la lista de columnas no llega a la base', () => {
  /* Un `evento_id` o un `id` que viniera en el cuerpo escribiría el derecho de
     otro evento. La lista blanca es lo que lo impide. */
  const fila = D.validarDerecho({ nombre: 'Almuerzo', evento_id: 'otro', id: 'suplantado', activo: true });
  assert.deepEqual(Object.keys(fila).sort(), ['activo', 'nombre']);
});

/* ── Que la regla siga estando donde tiene que estar ─────────────────── */

test('la unicidad vive en la base, no en la aplicación', () => {
  /* Esta prueba no mira comportamiento: mira que nadie haya «mejorado» el
     código sustituyendo el índice por un `if`, que es exactamente el fallo que
     la 0126 existe para impedir y que ninguna prueba de una sola tableta
     detectaría.

     La 0117 con la doble venta y la 0125 con el aforo son la misma historia. */
  const migracion = leer('db/migrations/0126_lo_que_incluye_la_credencial.sql');

  assert.match(migracion, /create unique index if not exists\s+derecho_consumo_unico_por_ventana/i);
  assert.match(migracion, /create unique index if not exists\s+derecho_consumo_unico_total/i);
  assert.match(migracion, /coalesce\(puesto_id, ticket_id\)/i,
    'las dos formas de titular tienen que caber en la misma regla');
  assert.match(migracion, /uso_num/,
    'sin uso_num en la clave, el tope de un derecho de N usos lo decide la aplicación');

  const ruta = leer('routes/derechos.js');
  assert.match(ruta, /esDuplicado\(error\)/,
    'la ruta tiene que saber leer el choque contra el índice');
});

test('la ruta mira la generación de la credencial, no el texto del token', () => {
  /* Un puesto transferido rota su credencial, pero el token viejo sigue
     llevando una firma válida y los QR no caducan. Sin comprobar nada, quien
     vendió su puesto recoge el almuerzo del comprador.

     Y la comprobación tiene que ser la generación (0127) y no el texto: un
     reenvío del correo también cambia el token, y ahí no se transfirió nada —
     comparar cadenas le cerraba la puerta a quien llegaba con el primer
     correo. */
  const ruta = leer('routes/derechos.js');
  assert.match(ruta, /credenciales\.credencialAlDia/);
  assert.doesNotMatch(ruta, /qr_token !== quien\.token/);
});

test('entregar es un permiso propio y no el de la puerta', () => {
  /* Quien sirve la comida no tiene por qué poder abrir la puerta del evento, y
     al revés. A menudo son dos empresas distintas. */
  const catalogo = leer('core/permisos/catalogo.js');
  assert.match(catalogo, /id: 'entregar'/);

  const ruta = leer('routes/derechos.js');
  assert.match(ruta, /PERMS_ENTREGA = \['entregar', 'editar_evento'\]/,
    '`editar_evento` en la lista es lo que evita que nada se rompa antes de repartir el permiso');
  assert.doesNotMatch(ruta, /'checkin'/,
    'entregar el almuerzo no puede depender del permiso de la puerta');
});
