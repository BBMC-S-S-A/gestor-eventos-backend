'use strict';
/* El QR que además presenta a la persona.
 *
 * Modelo decidido con quien organiza (17-sep): encendida para todos desde el
 * registro —la autorización va en los términos del evento—, con la opción de
 * ocultarse, y sólo con los datos de contacto que elija el organizador.
 *
 * Lo que estas pruebas cuidan no es la función: es que una escarapela colgada
 * del cuello no enseñe nunca el documento, la fecha de nacimiento, la identidad
 * de género o la discapacidad de nadie, aunque alguien marque esa pregunta.
 *
 * Correr: node --test test/tarjetaDeContacto.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { esDeContacto, opcionesParaElegir, tarjetaPublica } = require('../lib/tarjetaContacto.js');

/* Las preguntas reales del formulario de FESTECH, con sus tipos. */
const FORM = [
  { id: 'f-nac',  etiqueta: 'Fecha de nacimiento',            tipo: 'fecha' },
  { id: 'f-doc',  etiqueta: 'Documento de Identidad',         tipo: 'documento' },
  { id: 'f-gen',  etiqueta: 'Identidad de Género',            tipo: 'seleccion' },
  { id: 'f-etn',  etiqueta: 'Autorreconocimiento Étnico',     tipo: 'seleccion' },
  { id: 'f-dis',  etiqueta: 'Discapacidad',                   tipo: 'seleccion' },
  { id: 'f-bar',  etiqueta: 'Barrio o Vereda',                tipo: 'seleccion' },
  { id: 'f-nit',  etiqueta: 'Nombre y Nit de la empresa',     tipo: 'texto' },
  { id: 'f-tel',  etiqueta: 'Número o usuario de WhatsApp para contacto', tipo: 'telefono' },
  { id: 'f-rol',  etiqueta: 'Rol',                            tipo: 'texto' },
  { id: 'f-sens', etiqueta: 'Cargo',                          tipo: 'texto', sensible: true },
];

const BOLETA = {
  guest_nombre: 'Ana Pérez',
  guest_email: 'ana@correo.com',
  respuestas: {
    'f-nac': '1990-01-01', 'f-doc': '1110000000', 'f-gen': 'Mujer', 'f-dis': 'Ninguna',
    'f-tel': '+57 300 000 0000', 'f-rol': 'Directora',
  },
};

test('sólo se ofrecen datos para contactar a alguien', () => {
  const { permitidas, bloqueadas } = opcionesParaElegir(FORM);
  assert.deepEqual(permitidas.map(p => p.id), ['nombre', 'email', 'f-tel', 'f-rol']);
  for (const id of ['f-nac', 'f-doc', 'f-gen', 'f-etn', 'f-dis', 'f-bar', 'f-nit', 'f-sens']) {
    assert.ok(bloqueadas.some(b => b.id === id), `${id} se ofreció como dato de contacto`);
  }
});

test('un texto libre que habla de documento o NIT tampoco se comparte', () => {
  assert.equal(esDeContacto({ tipo: 'texto', etiqueta: 'Número de documento' }), false);
  assert.equal(esDeContacto({ tipo: 'texto', etiqueta: 'Nombre y Nit de la empresa' }), false);
  assert.equal(esDeContacto({ tipo: 'texto', etiqueta: 'Cargo' }), true);
});

test('aunque la lista guardada traiga una pregunta sensible, no sale', () => {
  /* El panel desactiva esas casillas, pero quien decide es el servidor: una
     lista escrita a mano en page_json no puede saltarse la regla. */
  const t = tarjetaPublica({
    ticket: BOLETA,
    config: { campos: ['nombre', 'f-doc', 'f-gen', 'f-tel', 'f-dis', 'f-nac'] },
    camposForm: FORM,
  });
  assert.equal(t.compartido, true);
  assert.deepEqual(t.datos.map(d => d.id), ['nombre', 'f-tel']);
  assert.ok(!JSON.stringify(t).includes('1110000000'), 'salió el documento');
  assert.ok(!JSON.stringify(t).includes('Mujer'), 'salió la identidad de género');
});

test('sin campos elegidos por el organizador no se comparte nada de nadie', () => {
  /* Es lo que deja desplegar esto antes de que los términos del evento lo
     digan: hasta que alguien marque campos, la tarjeta no enseña datos. */
  const t = tarjetaPublica({ ticket: BOLETA, config: {}, camposForm: FORM });
  assert.deepEqual(t, { compartido: false, motivo: 'evento' });
});

test('quien pidió ocultar sus datos no enseña ni el nombre', () => {
  const t = tarjetaPublica({
    ticket: { ...BOLETA, contacto_oculto: true },
    config: { campos: ['nombre', 'email', 'f-tel'] },
    camposForm: FORM,
  });
  assert.deepEqual(t, { compartido: false, motivo: 'persona' });
});

test('encendida por defecto: sin marcar nada, los datos elegidos salen', () => {
  const t = tarjetaPublica({ ticket: BOLETA, config: { campos: ['nombre', 'email', 'f-tel', 'f-rol'] }, camposForm: FORM });
  assert.deepEqual(t.datos.map(d => d.valor), ['Ana Pérez', 'ana@correo.com', '+57 300 000 0000', 'Directora']);
});

test('las rutas tienen freno y ocultarse no toca el ingreso', () => {
  const R = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eventos.publicos.js'), 'utf8');
  const i = R.indexOf("router.get('/contacto/:codigo'");
  assert.ok(i > 0);
  assert.match(R.slice(i, i + 120), /authLimiter/);
  const j = R.indexOf("router.put('/contacto/:codigo'");
  assert.ok(j > 0);
  const cuerpo = R.slice(j, j + 1800);
  assert.match(cuerpo, /update\(\{ contacto_oculto: req\.body\.oculto \}\)/);
  assert.doesNotMatch(cuerpo, /estado:|checked_in_at/, 'ocultar los datos tocó el estado de la boleta');
});
