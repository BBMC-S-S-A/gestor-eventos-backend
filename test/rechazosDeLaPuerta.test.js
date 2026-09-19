const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'clientes.js'), 'utf8');

test('los dos «ya fue usada» de la puerta dejan constancia', () => {
  const avisos = SRC.split("error: 'Esta boleta ya fue usada.'").length - 1;
  const anotados = (SRC.match(/ anotarRechazo\(ticket, req\.user\?\.id, [^,)]+\);/g) || []).length;
  assert.equal(anotados, avisos, 'un camino que rechaza sin anotarlo vuelve a esconder los repetidos');
});

test('anotar un rechazo no hace esperar a la puerta', () => {
  const f = SRC.slice(SRC.indexOf('function anotarRechazo'), SRC.indexOf('function anotarRechazo') + 600);
  assert.doesNotMatch(f, /await /, 'la puerta contesta en el acto; la constancia va detrás');
  assert.match(f, /from\('puerta_rechazos'\)/, 'va a su tabla, no a ticket_movimientos (el aforo la lee)');
});

test('una boleta vencida también deja constancia, con su motivo', () => {
  assert.match(SRC, /anotarRechazo\(ticket, req\.user\?\.id, ticket\.checked_in_at, 'vencida'\)/);
});
