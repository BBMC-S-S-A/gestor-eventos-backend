'use strict';

/* Qué texto del buscador cuenta como un documento, y qué no.
 *
 * ── Qué se está protegiendo ──────────────────────────────────────────────
 *
 * La caja del mostrador es una sola y sirve para todo: nombre, correo, código
 * y ahora cédula. Decidir mal aquí falla de las dos maneras y ninguna avisa:
 *
 *   · De más: tratar «Juan 12345» como documento dispara una consulta extra
 *     por cada búsqueda por nombre, y en la puerta eso se paga en segundos.
 *   · De menos: no reconocer «1.107.979.125» deja sin encontrar a quien
 *     escribió su cédula con puntos, que es como la escribe media Colombia.
 *
 * Y hay una tercera, que es la que de verdad importa: un documento es un dato
 * personal. El mínimo de dígitos existe para que nadie pueda teclear «123» y
 * pasearse por los documentos de los demás a ver qué sale.
 *
 * Correr: npm test */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { valoresDeDocumento, MINIMO_DIGITOS } = require('../lib/busquedaPorDocumento.js');

test('una cédula normal se busca tal cual, sin duplicar el valor', () => {
  /* El caso del 99,6% de FESTECH: dígitos limpios. Un solo valor, una sola
     consulta. */
  assert.deepEqual(valoresDeDocumento('1107979125'), ['1107979125']);
  assert.deepEqual(valoresDeDocumento('93404907'), ['93404907']);
});

test('escrita con puntos se busca de las dos formas', () => {
  /* Lo guardado casi siempre viene sin puntos, así que la versión en dígitos
     es la que encuentra; la cruda está por si alguien la guardó igual. */
  assert.deepEqual(valoresDeDocumento('1.107.979.125'), ['1.107.979.125', '1107979125']);
  assert.deepEqual(valoresDeDocumento('93-404-907'), ['93-404-907', '93404907']);
});

test('los espacios de alrededor no cuentan', () => {
  assert.deepEqual(valoresDeDocumento('  1107979125  '), ['1107979125']);
});

test('lo que no parece un documento no dispara ninguna consulta', () => {
  /* Lista vacía es la forma de decir «esto era una búsqueda por nombre». */
  for (const q of ['Juan', 'Juan Pérez', 'ana@gmail.com', 'ABC123', '', '   ', null, undefined]) {
    assert.deepEqual(valoresDeDocumento(q), [], `«${q}» no debería buscarse como documento`);
  }
});

test('un número corto no abre la puerta a pasearse por los documentos', () => {
  /* Cuatro dígitos es «a ver qué sale». Las cédulas colombianas van de seis a
     diez, y el mínimo está en cinco para no cerrarle la puerta a ningún
     documento corto legítimo. */
  assert.deepEqual(valoresDeDocumento('123'), []);
  assert.deepEqual(valoresDeDocumento('1234'), []);
  assert.equal(valoresDeDocumento('1'.repeat(MINIMO_DIGITOS)).length, 1);
  assert.deepEqual(valoresDeDocumento('1'.repeat(MINIMO_DIGITOS - 1)), []);
});

test('un nombre con un número dentro sigue siendo un nombre', () => {
  /* «Juan 12345» tiene cinco dígitos, pero lleva un espacio, y eso es lo que
     lo delata. Si entrara aquí se buscaría por nombre Y por documento: dos
     consultas para una sola pregunta. */
  assert.deepEqual(valoresDeDocumento('Juan Perez 12345'), []);
  assert.deepEqual(valoresDeDocumento('Casa Automaticas 2026'), []);
});

test('un pasaporte con letras también es un documento', () => {
  /* El campo es «documento», no «cédula»: quien llega con pasaporte tiene que
     aparecer. El precio de admitir letras es que un código de boleta como
     «FEST-12345» también dispara la consulta y no devuelve nada — barato, y
     preferible a dejar fuera a quien viene de afuera. */
  assert.deepEqual(valoresDeDocumento('AB123456'), ['AB123456', '123456']);
  assert.equal(valoresDeDocumento('FEST-12345').length, 2);
});

test('lo que lleva espacios nunca es un documento', () => {
  /* Es la regla que separa un documento de un nombre con un número dentro. */
  assert.deepEqual(valoresDeDocumento('Juan 12345'), []);
  assert.deepEqual(valoresDeDocumento('1107979125 '), ['1107979125']);
});

test('no revienta con lo que le echen', () => {
  for (const q of [{}, [], 0, false, 12345678]) {
    assert.doesNotThrow(() => valoresDeDocumento(q));
  }
  /* Un número de verdad, no un texto, se trata igual que su forma escrita. */
  assert.deepEqual(valoresDeDocumento(12345678), ['12345678']);
});
