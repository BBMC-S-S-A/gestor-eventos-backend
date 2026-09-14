/* ¿Esta credencial abre esta puerta, ahora? (0127)
 *
 * ── Qué se cuida ─────────────────────────────────────────────────────────
 *
 * Dos peticiones que resultaron ser la misma pregunta:
 *
 *   · el montaje — que al galpón lleno de herramienta entre quien viene a
 *     trabajar y no quien pasaba por ahí;
 *   · los QR ya repartidos — que un reenvío del correo no le cierre la puerta
 *     a quien imprimió el primero.
 *
 * La segunda es la que se rompía en silencio: nadie ve un error, sólo una
 * persona en la puerta con un correo del sistema que no abre.
 *
 * Correr: npm test */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const c = require('../lib/credenciales.js');
const { signPuestoQR, signTicketQR, verifyTicketQR } = require('../lib/qr.js');

const leer = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r/g, '');

const EN = (h) => new Date(`2026-09-14T${h}:00Z`).getTime();

/* ── Los QR que ya se repartieron ────────────────────────────────────── */

test('un reenvío del correo no invalida el QR anterior', () => {
  /* El caso que se rompía. Cada envío firma un token distinto del mismo
     puesto; nadie transfirió nada. Los dos son de la generación 0 y los dos
     abren. */
  const puesto = { credencial_gen: 0 };
  assert.equal(c.credencialAlDia({ genDelToken: 0, puesto }), true);
  assert.equal(c.credencialAlDia({ puesto }), true, 'un QR sin generación es la 0');
});

test('una transferencia sí lo invalida, y sólo ella', () => {
  const transferido = { credencial_gen: 1 };
  assert.equal(c.credencialAlDia({ genDelToken: 0, puesto: transferido }), false);
  assert.equal(c.credencialAlDia({ genDelToken: 1, puesto: transferido }), true);
});

test('los QR de antes de la 0127 abren sin reemitir nada', () => {
  /* Si esto fallara, aplicar la migración dejaría fuera a todo el que ya tiene
     su boleta — y se descubriría en la puerta, el día del evento. */
  const puestoDeAntes = { credencial_gen: undefined };
  assert.equal(c.credencialAlDia({ genDelToken: 0, puesto: puestoDeAntes }), true);
});

test('el QR de un puesto lleva su generación, y el de una boleta no tiene ninguna', () => {
  process.env.QR_JWT_SECRET = process.env.QR_JWT_SECRET || 'x'.repeat(40);
  const dePuesto = verifyTicketQR(signPuestoQR({
    ticket_id: 't1', evento_id: 'e1', codigo: 'ABC', puesto_id: 'p1', orden: 1, gen: 2,
  }));
  assert.equal(dePuesto.ok, true);
  assert.equal(dePuesto.gen, 2);

  /* Y el de la boleta: ahí todos los reenvíos valen siempre, porque no hay
     nada que rotar. */
  const deBoleta = verifyTicketQR(signTicketQR({ ticket_id: 't1', evento_id: 'e1', codigo: 'ABC' }));
  assert.equal(deBoleta.gen, 0);
  assert.equal(deBoleta.puesto_id, null);
});

/* ── Hasta cuándo abre ───────────────────────────────────────────────── */

test('una credencial sin vigencia abre siempre: nada de lo de hoy cambia', () => {
  assert.equal(c.vigenciaDelTipo({ nombre: 'General' }).vigente, true);
  assert.equal(c.vigenciaDelTipo(null).vigente, true);
});

test('la credencial de montaje deja de abrir cuando arranca el evento', () => {
  /* El montajista del lunes no entra gratis el sábado. Con firma válida y QR
     legítimo: lo único que lo para es la vigencia. */
  const montaje = { vigencia_desde: '2026-09-14T06:00:00Z', vigencia_hasta: '2026-09-15T22:00:00Z' };

  assert.equal(c.vigenciaDelTipo(montaje, EN('10:00')).vigente, true);

  const despues = c.vigenciaDelTipo(montaje, new Date('2026-09-19T10:00:00Z').getTime());
  assert.equal(despues.vigente, false);
  assert.match(despues.motivo, /venció/i);
});

test('y la del público no abre el galpón el día del montaje', () => {
  const publico = { vigencia_desde: '2026-09-19T08:00:00Z' };
  const antes = c.vigenciaDelTipo(publico, EN('10:00'));
  assert.equal(antes.vigente, false);
  assert.match(antes.motivo, /todavía no abre/i);
});

/* ── Quién responde por esta persona ─────────────────────────────────── */

test('registrarse no es estar autorizado', () => {
  /* Si lo fuera, quien quiere colarse se registra y ya está: el control se
     cumple en la letra y no impide nada. */
  const tipo = { requiere_autorizacion: true };
  const registrado = { nombre: 'Quien llegó', autorizado_at: null };

  const r = c.autorizacionDelPuesto({ tipo, puesto: registrado });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /nadie la ha autorizado/i);

  const aprobado = { nombre: 'Quien llegó', autorizado_at: '2026-09-13T18:00:00Z' };
  assert.equal(c.autorizacionDelPuesto({ tipo, puesto: aprobado }).ok, true);
});

test('en un tipo que exige acreditar personas, una credencial sin nombre no pasa', () => {
  /* Sería el agujero entero: una boleta de montaje a nombre de nadie abriendo
     la puerta del galpón. */
  const r = c.autorizacionDelPuesto({ tipo: { requiere_autorizacion: true }, puesto: null });
  assert.equal(r.ok, false);
});

test('una boleta normal no pasa por la autorización', () => {
  assert.equal(c.autorizacionDelPuesto({ tipo: { nombre: 'General' }, puesto: null }).ok, true);
});

/* ── La puerta que abre a sus horas ──────────────────────────────────── */

test('una puerta sin horario está siempre abierta', () => {
  assert.equal(c.puertaAbierta({ nombre: 'Principal' }).abierta, true);
  assert.equal(c.puertaAbierta(null).abierta, true);
});

test('la puerta del montaje cierra a su hora', () => {
  const galpon = { nombre: 'Galpón', reglas: { horario: { desde: '2026-09-14T06:00:00Z', hasta: '2026-09-14T20:00:00Z' } } };

  assert.equal(c.puertaAbierta(galpon, EN('10:00')).abierta, true);

  const tarde = c.puertaAbierta(galpon, EN('22:00'));
  assert.equal(tarde.abierta, false);
  assert.match(tarde.motivo, /Galpón/);
});

/* ── El veredicto entero ─────────────────────────────────────────────── */

test('sin nada configurado, todo abre: aplicar la 0127 no cambia ningún evento', () => {
  /* La prueba que decide si esto se puede desplegar sin avisar a nadie. */
  assert.equal(c.puedeAbrir({ tipo: { nombre: 'General' }, puesto: null, puerta: null }).ok, true);
  assert.equal(c.puedeAbrir({}).ok, true);
});

test('el orden de los motivos no es casual', () => {
  /* Con cien personas esperando, el primer mensaje que sale es el que se lee.
     A alguien cuya credencial simplemente venció no se le dice «no estás
     autorizado»: manda a discutir por lo que no es. */
  const vencidaYSinAutorizar = c.puedeAbrir({
    tipo: { vigencia_hasta: '2026-09-14T08:00:00Z', requiere_autorizacion: true },
    puesto: { autorizado_at: null },
    ahora: EN('20:00'),
  });
  assert.equal(vencidaYSinAutorizar.causa, 'vigencia');
});

test('la credencial del montajista después del montaje: cerrada, y con el motivo bueno', () => {
  const r = c.puedeAbrir({
    tipo: { vigencia_hasta: '2026-09-15T22:00:00Z', requiere_autorizacion: true },
    puesto: { autorizado_at: '2026-09-13T10:00:00Z', credencial_gen: 0 },
    ahora: new Date('2026-09-19T10:00:00Z').getTime(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.causa, 'vigencia');
});

test('el puesto transferido se para antes de mirar si está autorizado', () => {
  const r = c.puedeAbrir({
    tipo: { requiere_autorizacion: true },
    puesto: { credencial_gen: 1, autorizado_at: '2026-09-13T10:00:00Z' },
    genDelToken: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.causa, 'transferido');
});

/* ── Lo que la puerta necesita VER ───────────────────────────────────── */

test('la ficha lleva con qué comparar la cédula', () => {
  /* La comprobación de verdad en un montaje no la hace el software: la hace
     quien está en la puerta mirando el documento. Con sólo un nombre en
     pantalla no hay nada que comparar, y el QR reenviado por WhatsApp abre
     igual. */
  const ficha = c.fichaDeLaPuerta({
    puesto: { nombre: 'Ana', documento: '1020304', foto_url: 'https://x/f.jpg', telefono: '300', autorizado_por: 'Stand 14' },
    ticket: {},
  });
  assert.equal(ficha.documento, '1020304');
  assert.equal(ficha.foto_url, 'https://x/f.jpg');
  assert.equal(ficha.autorizado_por, 'Stand 14');
});

test('en una boleta normal la ficha es casi toda vacía, y eso está bien', () => {
  /* La pantalla no tiene que enseñar campos en blanco a quien escanea una
     entrada general. */
  const ficha = c.fichaDeLaPuerta({ puesto: null, ticket: { guest_nombre: 'Pedro' } });
  assert.equal(ficha.nombre, 'Pedro');
  assert.equal(ficha.documento, null);
  assert.equal(ficha.foto_url, null);
});

/* ── Que la regla no se duplique ─────────────────────────────────────── */

test('la puerta del evento usa estas reglas y no una copia suya', () => {
  /* Dos puertas con dos criterios es el modo de fallo de este proyecto: una
     deja pasar y la otra no, y la diferencia se descubre con la persona
     delante. */
  const ruta = leer('routes/clientes.js');
  assert.match(ruta, /credenciales\.puedeAbrir/);
  assert.match(ruta, /credenciales\.fichaDeLaPuerta/);
});

test('el update que consume un puesto compara la generación, no el token', () => {
  /* Si alguien vuelve a poner `eq('qr_token', …)`, los reenvíos vuelven a
     romperse — y ninguna prueba de una sola tableta lo notaría. */
  const puerta = leer('lib/puertaDePuestos.js');
  assert.match(puerta, /\.eq\('credencial_gen'/);
  assert.doesNotMatch(puerta, /\.eq\('qr_token'/);
});

test('la migración no enciende nada por su cuenta', () => {
  /* Las siete columnas nacen con el valor que reproduce el comportamiento de
     hoy. Si alguna naciera en `true`, aplicar la 0127 caducaría credenciales
     que nadie pidió caducar. */
  const m = leer('db/migrations/0127_la_credencial_de_quien_monta.sql');
  assert.match(m, /requiere_autorizacion boolean not null default false/);
  assert.match(m, /visible_publico boolean not null default true/);
  assert.match(m, /credencial_gen integer not null default 0/);
});

/* ── La sustitución del día del montaje (0128) ────────────────────────── */

test('sustituir es transferir: la credencial del que no vino deja de abrir', () => {
  /* Es la mitad que se olvida. Si sustituir sólo escribiera el nombre nuevo,
     el QR del que se enfermó seguiría abriendo: dos credenciales buenas para
     un puesto, que es peor que no haber acreditado a nadie. */
  const puestos = require('../lib/puestos.js');
  const previo = { id: 'p1', evento_id: 'e1', nombre: 'El que iba', credencial_gen: 0,
                   autorizado_at: '2026-09-13T10:00:00Z', autorizado_por: 'La organización' };

  const { puesto, rastro } = puestos.aplicarTransferencia({ puesto: previo, destino: { nombre: 'El primo' } });

  assert.equal(puesto.credencial_gen, 1, 'sin subir la generación, el QR del otro sigue valiendo');
  assert.equal(c.credencialAlDia({ genDelToken: 0, puesto }), false);
  /* Y no hereda la autorización: por el primo hay que responder otra vez. */
  assert.equal(puesto.autorizado_at, null);
  /* El rastro dice a quién sustituyó, que es lo que se pregunta después. */
  assert.equal(rastro.de_nombre, 'El que iba');
  assert.equal(rastro.a_nombre, 'El primo');
});

test('la sustitución en el momento está apagada mientras nadie la encienda', () => {
  /* `autoriza` nace en 'evento': aplicar la 0128 no le da a ningún stand el
     poder de acreditar a quien quiera. */
  const m = leer('db/migrations/0128_el_que_iba_se_enfermo.sql');
  assert.match(m, /autoriza text not null default 'evento'/);
  assert.match(m, /check \(autoriza in \('evento', 'responsable'\)\)/);
});

/* ── La foto ──────────────────────────────────────────────────────────── */

test('una ruta privada sin firmador no sale en la respuesta', () => {
  /* Media filtración es una filtración: si quien pregunta no puede ver fotos,
     lo que no puede recibir es la ruta donde está. */
  assert.equal(c.fotoParaVer('acreditacion/2026/ab12.jpg', null), null);
});

test('la ruta privada se firma, y una URL de fuera se deja como está', () => {
  const firmada = c.fotoParaVer('acreditacion/2026/ab12.jpg', (r) => `https://x/privado?ruta=${r}`);
  assert.match(firmada, /privado\?ruta=acreditacion/);
  assert.equal(c.fotoParaVer('https://cdn.ajeno/foto.jpg', () => 'no'), 'https://cdn.ajeno/foto.jpg');
});

test('la foto de acreditación vive en una carpeta privada y sin sesión', () => {
  /* Privada porque es la cara de un trabajador junto a su documento. Sin sesión
     porque la sube la cuadrilla desde el enlace del stand, y pedirle cuenta a
     esa gente es garantizar que no suba nadie ninguna. */
  const tipos = leer('modules/archivos/tipos.js');
  const bloque = tipos.slice(tipos.indexOf("'acreditacion'"), tipos.indexOf("'hojas-de-vida'"));
  assert.match(bloque, /publico:\s*false/);
  assert.match(bloque, /exigeSesion:\s*false/);
});

test('una imagen privada se sirve para verla, no para descargarla', () => {
  /* Con `attachment`, un `<img src>` no pinta nada — y la foto existe para
     ponerla al lado de la cara en la puerta. */
  const rutas = leer('modules/archivos/rutas.js');
  assert.match(rutas, /enLinea \? 'inline' : 'attachment'/);
  assert.match(rutas, /X-Content-Type-Options/, 'servir en línea sin nosniff sí sería un riesgo');
});
