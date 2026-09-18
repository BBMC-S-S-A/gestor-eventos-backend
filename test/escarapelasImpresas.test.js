'use strict';
/* Quién ya tiene su escarapela impresa (0132).
 *
 * En la puerta hay varias estaciones imprimiendo. Si esto se guardara en el
 * navegador de cada una, cada mostrador tendría su propia respuesta a «¿a quién
 * le falta?», que es peor que no tener ninguna.
 *
 * Correr: node --test test/escarapelasImpresas.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const leer = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const RUTA = leer('routes/clientes.js');

test('marcar impresas es de quien está en el mostrador, no de quien gestiona clientes', () => {
  const i = RUTA.indexOf("'/:eventoId/clientes/escarapelas-impresas'");
  assert.ok(i > 0, 'no existe la ruta para marcar escarapelas impresas');
  const firma = RUTA.slice(i, i + 200);
  assert.match(firma, /sesion\(/, 'la ruta no comprueba la sesión');
  assert.match(RUTA.slice(i, i + 1500), /assertCheckinAccess/,
    'la ruta no exige el permiso de puerta');
});

test('la primera impresión es la que cuenta', () => {
  const i = RUTA.indexOf("'/:eventoId/clientes/escarapelas-impresas'");
  const cuerpo = RUTA.slice(i, i + 2000);
  assert.match(cuerpo, /if \(!reimprimir\) q = q\.is\('escarapela_impresa_at', null\)/,
    'reimprimir una escarapela rota reescribe la hora de la primera');
  assert.match(cuerpo, /ids\.length > 500/, 'sin tope: una lista entera cabría en una petición');
  assert.match(cuerpo, /UUID\.test/, 'los ids llegan a la consulta sin validar');
});

test('la lista dice si ya está impresa y se puede filtrar por eso', () => {
  assert.match(RUTA, /escarapela_impresa_at,/, 'el dato no viaja en la lista');
  assert.match(RUTA, /impresa === 'no'.*escarapela_impresa_at', null/s, 'no se puede pedir «a quién le falta»');
  assert.match(RUTA, /const desdeCuando = fechaValida\(desde\)/, 'no se puede pedir «registrados desde»');
});

test('sin la 0132 aplicada se dice, no se rompe la impresión', () => {
  const i = RUTA.indexOf("'/:eventoId/clientes/escarapelas-impresas'");
  assert.match(RUTA.slice(i, i + 2000), /Falta aplicar la migración 0132/);
});
