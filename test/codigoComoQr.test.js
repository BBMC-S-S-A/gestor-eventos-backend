'use strict';
/* Un QR que trae sólo el código de la boleta.
 *
 * Las etiquetas pequeñas imprimen el código corto suelto en el QR. El panel
 * nuevo lo manda como `codigo`, pero un móvil de la puerta con la versión vieja
 * en caché lo manda como `qr_token`, y el servidor lo rechazaba como «QR
 * inválido». Ahora cada entrada del escáner pasa por `leerEscaneo`.
 *
 * Correr: node --test test/codigoComoQr.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { leerEscaneo } = require('../lib/leerEscaneo.js');

test('un código suelto que llega como qr_token se lee como código', () => {
  assert.deepEqual(leerEscaneo({ qr_token: 'pe6667pq' }), { qr_token: null, codigo: 'PE6667PQ' });
  assert.deepEqual(leerEscaneo({ qr_token: ' AB10OI99 ' }), { qr_token: null, codigo: 'AB10OI99' });
});

test('un token firmado sigue siendo token', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOiIxIn0.firma';
  assert.deepEqual(leerEscaneo({ qr_token: jwt }), { qr_token: jwt, codigo: undefined });
});

test('el código manual pasa igual', () => {
  assert.deepEqual(leerEscaneo({ codigo: 'ABCD1234' }), { qr_token: null, codigo: 'ABCD1234' });
});

test('check-in, reingreso y entrega pasan por leerEscaneo', () => {
  const leer = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.equal((leer('routes/clientes.js').match(/= leerEscaneo\(req\.body/g) || []).length, 2,
    'check-in o reingreso leen qr_token sin normalizar');
  assert.match(leer('routes/derechos.js'), /= leerEscaneo\(escaneo\)/, 'la entrega lee qr_token sin normalizar');
  assert.match(leer('lib/ticketLookup.js'), /= leerEscaneo\(escaneo\)/, 'resolverTicket lee qr_token sin normalizar');
});
