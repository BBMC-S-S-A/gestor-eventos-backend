'use strict';
/* El QR que además presenta a la persona (0133).
 *
 * Lo que esto protege no es una función: es que una escarapela colgada del
 * cuello no se convierta en una ficha pública. El formulario de un evento pide
 * documento, fecha de nacimiento, identidad de género o discapacidad según el
 * caso, y nada de eso puede salir por aquí.
 *
 * Correr: node --test test/tarjetaDeContacto.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizarContacto, tarjetaPublica } = require('../lib/tarjetaContacto.js');

test('sin autorización no sale ni el nombre', () => {
  const t = tarjetaPublica({ guest_nombre: 'Ana Pérez', contacto_publico: false, contacto: { empresa: 'ACME' } });
  assert.deepEqual(t, { compartido: false },
    'una tarjeta apagada devolvió datos: registrarse no es aceptar que te encuentren');
});

test('con autorización sale sólo lo que ella escribió', () => {
  const t = tarjetaPublica({
    guest_nombre: 'Ana Pérez',
    contacto_publico: true,
    contacto: { empresa: 'ACME', whatsapp: '+57 300 000 0000' },
  });
  assert.equal(t.compartido, true);
  assert.equal(t.nombre, 'Ana Pérez');
  assert.deepEqual(t.contacto, { empresa: 'ACME', whatsapp: '+57 300 000 0000' });
});

test('lo que no es un campo de la tarjeta se descarta', () => {
  /* La clave del asunto: aunque alguien mande las respuestas del registro en
     el cuerpo de la petición, no se guardan ni se publican. */
  const c = normalizarContacto({
    empresa: 'ACME',
    documento: '1110000000',
    fecha_nacimiento: '1990-01-01',
    'Identidad de Género': 'x',
    respuestas: { a: 1 },
  });
  assert.deepEqual(Object.keys(c), ['empresa']);
});

test('los datos se recortan y se sanean', () => {
  const c = normalizarContacto({
    empresa: '   ACME   S.A.  \n\n ',
    email: 'no-es-un-correo',
    web: 'miempresa.com',
    nota: 'x'.repeat(400),
  });
  assert.equal(c.empresa, 'ACME S.A.');
  assert.equal(c.email, undefined, 'un correo que no lo es se guardó igual');
  assert.equal(c.web, 'https://miempresa.com', 'la web sin esquema no se puede enlazar');
  assert.equal(c.nota.length, 280);
});

test('la ruta pública no deja encender una tarjeta vacía, y tiene freno', () => {
  const RUTAS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eventos.publicos.js'), 'utf8');
  const i = RUTAS.indexOf("router.get('/contacto/:codigo'");
  assert.ok(i > 0, 'no existe la ruta pública de la tarjeta');
  assert.match(RUTAS.slice(i, i + 200), /authLimiter/,
    'sin freno, la ruta es una forma de recorrer códigos de boleta a ciegas');
  const j = RUTAS.indexOf("router.put('/contacto/:codigo'");
  assert.ok(j > 0, 'no se puede editar la propia tarjeta');
  assert.match(RUTAS.slice(j, j + 2500), /Escribe al menos un dato de contacto/,
    'se puede encender una tarjeta sin nada dentro: enseñaría el nombre y nada más');
  /* Una boleta anulada no presenta a nadie. */
  assert.match(RUTAS.slice(i, i + 2500), /invalido', 'reembolsado', 'cancelado/);
});
