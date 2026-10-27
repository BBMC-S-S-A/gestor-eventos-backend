/* Que `ver_clientes` sirva para ver clientes.
 *
 * ── De dónde sale ────────────────────────────────────────────────────────
 *
 * De un 403 en producción el 27 de octubre:
 *
 *     GET /eventos/f0259473-…/clientes?limit=1  →  403
 *
 * Quien lo pedía era un miembro con rol «VIP host» de TechNova Summit 2026.
 * Ese rol trae `["vip_zone","ver_clientes","checkin"]` — o sea que TENÍA el
 * permiso cuyo nombre es exactamente esto— y la ruta pedía `gestionar_clientes`.
 *
 * No era una frontera de seguridad: era un descuido, y hay dos pruebas de ello
 * dentro del propio archivo.
 *
 *   1. El comentario de `routes/clientes.js` ya lo decía: «el listado acepta
 *      también ver_clientes». La intención estaba escrita; el código no la
 *      cumplía.
 *
 *   2. **Exportar sí lo aceptaba.** `GET /clientes/exportar` pide
 *      `['ver_clientes','gestionar_clientes']` desde siempre. Un VIP host podía
 *      bajarse la lista entera en un archivo y no podía mirarla en el panel.
 *
 * Lo que dejaba fuera: Puerta, VIP host, Coordinador, Finanzas y Coordinación
 * de expositores. Cinco roles con el permiso de ver que no podían ver.
 *
 * ── Qué protege esta prueba ──────────────────────────────────────────────
 *
 * Las dos mitades, porque arreglar una y romper la otra es fácil: que leer la
 * lista siga abierto a `ver_clientes`, y que ESCRIBIRLA siga cerrado.
 *
 * Correr: npm test */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = (...p) => path.join(__dirname, '..', ...p);
const SRC = fs.readFileSync(raiz('routes', 'clientes.js'), 'utf8').replace(/\r/g, '');
/* Sin comentarios: este arreglo se explica CITANDO los permisos, y buscarlos
   en el texto entero los encontraría dentro de su propia explicación. */
const CODIGO = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const inventario = () => JSON.parse(fs.readFileSync(raiz('core', 'permisos', 'inventario.json'), 'utf8'));

test('ver la lista de clientes acepta `ver_clientes`', () => {
  /* El fallo de producción, en una línea. */
  const acciones = inventario().rutas['GET /eventos/:eventoId/clientes']?.acciones || [];
  assert.ok(acciones.includes('ver_clientes'),
    'el listado volvió a exigir sólo gestionar_clientes: Puerta, VIP host, Coordinador, ' +
    'Finanzas y Coordinación de expositores se quedan sin ver la pantalla de clientes');
});

test('y lo sigue aceptando quien la gestiona', () => {
  /* Ampliar no puede ser cambiar: quien podía antes tiene que poder ahora. */
  const acciones = inventario().rutas['GET /eventos/:eventoId/clientes']?.acciones || [];
  assert.ok(acciones.includes('gestionar_clientes'));
});

test('ESCRIBIR la lista sigue cerrado a `ver_clientes`', () => {
  /* La otra mitad, y la que importa para que esto no sea un agujero. Editar,
     reenviar e importar mueven datos de personas y cobran correos; borrar va
     aparte con su propio permiso. */
  const inv = inventario().rutas;
  for (const ruta of [
    'PATCH /eventos/:eventoId/clientes/:ticketId',
    'POST /eventos/:eventoId/clientes/:ticketId/reenviar',
    'POST /eventos/:eventoId/clientes/importar',
  ]) {
    const acciones = inv[ruta]?.acciones || [];
    assert.ok(acciones.length > 0, `${ruta} desapareció del inventario`);
    assert.ok(!acciones.includes('ver_clientes'),
      `${ruta} se abrió a ver_clientes: eso es leer, no escribir`);
  }

  const borrar = inv['DELETE /eventos/:eventoId/clientes/:ticketId']?.acciones || [];
  assert.deepEqual(borrar, ['borrar_boletas'],
    'borrar tiene su propio permiso a propósito: quien atiende todo el día no borra de paso');
});

test('la constante de leer y la de escribir no son la misma', () => {
  /* Si alguien las junta, el siguiente que toque las escrituras abre la puerta
     sin enterarse. */
  assert.match(CODIGO, /const PERMS_CLIENTES\s*=\s*\['gestionar_clientes'\]/);
  assert.match(CODIGO, /const PERMS_VER_CLIENTES\s*=\s*\['gestionar_clientes',\s*'ver_clientes'\]/);
  assert.match(CODIGO, /router\.get\('\/:eventoId\/clientes',\s*exige\(PERMS_VER_CLIENTES\)/);
});

test('exportar y listar piden lo mismo', () => {
  /* La incoherencia que delató el fallo: se podía bajar la lista entera en un
     archivo y no se podía mirar. Que no vuelvan a separarse. */
  const listar = (inventario().rutas['GET /eventos/:eventoId/clientes']?.acciones || []).slice().sort();
  assert.deepEqual(listar, ['gestionar_clientes', 'ver_clientes']);
  assert.match(CODIGO, /assertOwner\(eventoId, req\.user\.id, \['ver_clientes', 'gestionar_clientes'\]\)/,
    'exportar dejó de aceptar los dos: mirar y descargar tienen que pedir lo mismo');
});
