'use strict';
/* Las zonas en los permisos de los roles.
 *
 * Crear una zona pedía `editar_pagina_publica` y colocarla en el plano
 * `editar_evento`. Para que logística dibujara el recinto había que darle la
 * landing y el evento enteros. `gestionar_zonas` abre `page_json` sólo por las
 * dos claves de ese trabajo.
 *
 * Correr: node --test test/permisoDeZonas.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TODOS } = require('../core/permisos/catalogo.js');
const { llavesDePageJson, recortarPageJson } = require('../lib/quePuedeEditar.js');

test('gestionar_zonas está en el catálogo', () => {
  assert.ok(TODOS.includes('gestionar_zonas'));
});

test('abre las zonas y el mapa, y nada más de page_json', () => {
  const llaves = llavesDePageJson(new Set(['gestionar_zonas']));
  assert.deepEqual([...llaves].sort(), ['mapa', 'zonas']);

  const r = recortarPageJson(
    { zonas: [{ id: 'z1' }], mapa: { marcadores: [] }, accesos: [1], paginas: [] },
    llaves,
  );
  assert.deepEqual(Object.keys(r.page_json).sort(), ['mapa', 'zonas'],
    'con gestionar_zonas se coló algo que no es la zona ni el plano');
});

test('logística lo trae de serie', () => {
  const { ROLES } = require('../modules/eventos/semillas.js');
  const logistica = ROLES.find(r => /Log[ií]stica/.test(r.nombre));
  assert.ok(logistica, 'no se encontró el rol de logística en la semilla');
  assert.ok(logistica.permissions.includes('gestionar_zonas'));
});
