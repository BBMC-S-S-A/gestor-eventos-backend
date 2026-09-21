const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = fs.readFileSync(path.join(__dirname, '..', 'lib', 'boletasSinCorreo.js'), 'utf8');
const RUTA = fs.readFileSync(path.join(__dirname, '..', 'routes', 'emails.js'), 'utf8');

test('quien ya tiene su boleta en la cola (enviada o por salir) no se vuelve a encolar', () => {
  assert.match(LIB, /YA_LO_TIENE = \['enviado', 'pendiente', 'enviando'\]/);
  assert.match(LIB, /\.eq\('tipo', 'ticket'\)/);
});

test('sólo boletas activas de ese evento', () => {
  assert.match(LIB, /ACTIVAS = \['emitido', 'pagado', 'usado'\]/);
  assert.match(LIB, /\.eq\('evento_id', eventoId\)/);
});

test('el envío masivo exige la cola encendida y va con prioridad baja', () => {
  const r = RUTA.slice(RUTA.indexOf("'/eventos/:id/emails/sin-boleta/enviar'"));
  assert.match(r.slice(0, 1500), /if \(!cola\.activa\(\)\)/);
  assert.match(r.slice(0, 2500), /prioridad: 5/);
});
