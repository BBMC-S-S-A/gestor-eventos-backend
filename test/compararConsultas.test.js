'use strict';

/* El comparador de consultas (tramo 8): la red que dice si el adaptador miente.
 *
 * `scripts/comparar-consultas.js` corre las mismas consultas contra PostgREST y
 * contra el adaptador y compara lo que devuelven. Correrlo de verdad necesita
 * las dos bases; lo que se prueba aquí —sin ninguna— es lo que decide si ese
 * informe sirve o engaña:
 *
 *   · **Que SÓLO LEA.** Una entrada de escritura en el catálogo correría un
 *     `insert` contra producción. Dos veces, una por motor.
 *   · **Que la normalización baje por los embebidos.** Si no, dos respuestas
 *     que difieren justo en `rol_detail` —el guardia de los permisos— saldrían
 *     iguales, y el informe diría que todo cuadra.
 *   · **Que el orden no dé falsos positivos** cuando la consulta no lo fija, y
 *     que SÍ se compare en orden cuando la consulta existe para vigilarlo.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const cc = require('../scripts/comparar-consultas.js');
const pg = require('../core/db/postgrest.js');

/* ── La puerta: sólo lectura ───────────────────────────────────────────── */

test('NINGUNA entrada del catálogo escribe', () => {
  /* La prueba que justifica el archivo. Una entrada de escritura correría un
     `insert`/`update`/`delete` contra PRODUCCIÓN, y encima dos veces: una por
     motor. Se comprueba mirando el plan del adaptador, que es lo mismo que
     hace el script antes de tocar nada. */
  const malas = [];
  for (const e of cc.catalogo({ evento: 'f0259473-0000-4000-8000-000000000000' })) {
    const pega = cc.esDeSoloLectura(e, pg);
    if (pega) malas.push(`${e.nombre}: ${pega}`);
  }
  assert.deepEqual(malas, [],
    'Hay entradas que no sólo leen. Eso correría contra producción, dos veces.\n' +
    malas.map(m => `  · ${m}`).join('\n'));
});

test('una entrada de escritura SE DETECTA', () => {
  /* Sin esto, la prueba de arriba podría estar pasando porque la comprobación
     no mira nada. */
  const escritura = { nombre: 'mala', correr: c => c.from('eventos').insert({ titulo: 'x' }) };
  assert.match(cc.esDeSoloLectura(escritura, pg), /SÓLO LEE/);

  const borrado = { nombre: 'peor', correr: c => c.from('eventos').delete().eq('id', 'x') };
  assert.match(cc.esDeSoloLectura(borrado, pg), /delete/);
});

test('las funciones del catálogo son lista de INCLUSIÓN, y ninguna escribe', () => {
  /* Se cruza contra la tabla del adaptador: las que no están en
     `FUNCIONES_QUE_LEEN` tienen que quedar fuera, y las que escriben no pueden
     colarse aunque alguien las añada por descuido. */
  const ESCRIBEN = [
    'canjear_recompensa', 'sumar_aforo_vendido', 'sumar_vendidos_tipo',
    'retener_espacio', 'liberar_espacio', 'confirmar_espacio',
    'promocion_consumir', 'oauth_barrer', 'generar_recordatorios_inapp',
  ];
  for (const n of ESCRIBEN) {
    assert.ok(n in pg._FUNCIONES, `${n} ya no está en el adaptador: ¿cambió de nombre?`);
    assert.ok(!cc.FUNCIONES_QUE_LEEN.includes(n), `${n} ESCRIBE y está en la lista de las que leen`);
  }
  /* Y las que sí leen, existen de verdad. */
  for (const n of cc.FUNCIONES_QUE_LEEN) {
    assert.ok(n in pg._FUNCIONES, `${n} está en la lista pero el adaptador no la conoce`);
  }

  const fuera = { nombre: 'rpc mala', rpc: 'promocion_consumir', correr: () => {} };
  assert.match(cc.esDeSoloLectura(fuera, pg), /sólo leen/);
});

/* ── El catálogo cubre el adaptador ────────────────────────────────────── */

test('el catálogo toca todos los tramos', () => {
  /* Si un tramo se queda sin ninguna consulta, el informe diría «todo cuadra»
     sin haber mirado esa parte. */
  const tramos = new Set(cc.catalogo({ evento: 'x' }).map(e => String(e.tramo)));
  for (const t of ['1', '2', '4', '5', '5b', '6', '7']) {
    assert.ok(tramos.has(t), `no hay ninguna consulta del tramo ${t}`);
  }
});

test('están las consultas que vigilan lo que no da error', () => {
  /* Las cuatro que cubren los fallos mudos que costaron un tramo entero cada
     uno. Se buscan por nombre a propósito: si alguien las quita, esto lo dice. */
  const nombres = cc.catalogo({ evento: 'x' }).map(e => e.nombre).join(' | ');
  assert.match(nombres, /los nulos al final/,      'falta el orden de los NULL ascendente');
  assert.match(nombres, /los nulos al principio/,  'falta el orden de los NULL descendente');
  assert.match(nombres, /EL GUARDIA/,              'falta la consulta de lib/acceso.js');
  assert.match(nombres, /EL PARÉNTESIS/,           'falta el or combinado con eq');
  assert.match(nombres, /el total NO lo recorta/,  'falta el count junto al range');
});

/* ── La normalización ──────────────────────────────────────────────────── */

test('una diferencia DENTRO de un embebido se ve', () => {
  /* El guardia de los permisos vive dentro de un embebido: si una diferencia
     ahí no se viera, el informe diría que todo cuadra. */
  const a = cc.normalizarFila({ id: 1, rol_detail: { permissions: ['ver'] } });
  const b = cc.normalizarFila({ id: 1, rol_detail: { permissions: ['editar'] } });
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('la normalización BAJA por los embebidos: una fecha dentro no inventa diferencias', () => {
  /* Esto es lo que de verdad aporta recorrerlos, y una mutación lo demostró:
     quitar la recursión NO rompía la prueba de arriba, porque `normalizar`
     serializa el objeto entero y la diferencia se sigue viendo.
     Lo que se pierde sin recorrer es la normalización de los valores de
     DENTRO: la misma fecha escrita como la da Postgres y como la da MySQL
     saldría distinta, y el informe marcaría una diferencia que no existe.
     Con un embebido por consulta y cincuenta filas, eso es un informe
     inservible — que es como se acaba ignorando. */
  const a = cc.normalizarFila({ id: 1, tipo: { creado: '2026-09-01 10:00:00+00',    precio: '1500' } });
  const b = cc.normalizarFila({ id: 1, tipo: { creado: '2026-09-01 10:00:00.000000', precio: '1500.00' } });
  assert.equal(JSON.stringify(a), JSON.stringify(b),
    'la misma fecha en los dos formatos salió distinta dentro del embebido');
});

test('y también dentro de una LISTA de hijos', () => {
  const a = cc.normalizarFila({ id: 1, notas: [{ creado: '2026-09-01 10:00:00+00' }] });
  const b = cc.normalizarFila({ id: 1, notas: [{ creado: '2026-09-01 10:00:00.000000' }] });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('el orden de las claves no cuenta como diferencia', () => {
  const a = cc.normalizarFila({ b: 2, a: 1, hijo: { y: 2, x: 1 } });
  const b = cc.normalizarFila({ a: 1, b: 2, hijo: { x: 1, y: 2 } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('las formas distintas de la misma fecha y del mismo número se igualan', () => {
  /* Postgres da `+00`, MySQL `.000000`; el dinero sale «1500» de un lado y
     «1500.00» del otro. Sin esto, toda columna de fecha o de dinero saldría
     distinta y el informe sería inservible. */
  const a = cc.normalizarFila({ cuando: '2026-09-01 10:00:00+00', precio: '1500' });
  const b = cc.normalizarFila({ cuando: '2026-09-01 10:00:00.000000', precio: '1500.00' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('null NO se confunde con ausente ni con cadena vacía', () => {
  /* La diferencia entre «no tiene rol» y «no se miró» es justo lo que el
     tramo 5 protege. */
  const conNull  = JSON.stringify(cc.normalizarFila({ id: 1, rol: null }));
  const sinCampo = JSON.stringify(cc.normalizarFila({ id: 1 }));
  const vacio    = JSON.stringify(cc.normalizarFila({ id: 1, rol: '' }));
  assert.notEqual(conNull, sinCampo);
  assert.notEqual(conNull, vacio);
});

test('una lista de hijos vacía no es lo mismo que null', () => {
  assert.notEqual(
    JSON.stringify(cc.normalizarFila({ id: 1, notas: [] })),
    JSON.stringify(cc.normalizarFila({ id: 1, notas: null })));
});

/* ── La comparación ────────────────────────────────────────────────────── */

const resp = (data, count = null, error = null) => cc.normalizarRespuesta({ data, count, error });

test('dos respuestas iguales no dan diferencia', () => {
  assert.equal(cc.comparar(resp([{ id: 1 }]), resp([{ id: 1 }]), { ordenado: true }), null);
});

test('el conteo distinto SÍ es una diferencia', () => {
  /* Es la que caza que el `count` no vea un `!inner` o un `or`. */
  const pega = cc.comparar(resp([{ id: 1 }], 1), resp([{ id: 1 }], 99), { ordenado: true });
  assert.match(pega, /conteo difiere/);
});

test('un error en un solo lado es una diferencia', () => {
  const pega = cc.comparar(resp([{ id: 1 }]), resp(null, null, { message: 'x' }), { ordenado: true });
  assert.match(pega, /dio error/);
});

test('faltar una fila se dice con los dos números', () => {
  const pega = cc.comparar(resp([{ id: 1 }, { id: 2 }]), resp([{ id: 1 }]), { ordenado: true });
  assert.match(pega, /postgrest=2, adaptador=1/);
});

test('sin `ordenado`, el orden de las filas NO cuenta', () => {
  /* Sin `ORDER BY` ningún motor promete un orden; compararlo daría
     diferencias falsas en cuanto hubiera más de una fila. */
  assert.equal(
    cc.comparar(resp([{ id: 1 }, { id: 2 }]), resp([{ id: 2 }, { id: 1 }]), { ordenado: false }),
    null);
});

test('con `ordenado`, el orden SÍ cuenta', () => {
  /* Es lo que hace que las consultas del orden de los NULL sirvan de algo: si
     se compararan sin orden, la diferencia que buscan desaparecería. */
  assert.ok(
    cc.comparar(resp([{ id: 1 }, { id: 2 }]), resp([{ id: 2 }, { id: 1 }]), { ordenado: true }),
    'con ordenado:true, dos órdenes distintos tienen que ser una diferencia');
});

test('la primera diferencia señala la fila y los dos valores', () => {
  const d = cc.primeraDiferencia(resp([{ id: 1 }, { id: 2 }]), resp([{ id: 1 }, { id: 9 }]));
  assert.equal(d.i, 1);
  assert.match(d.postgrest, /"id":2/);
  assert.match(d.adaptador, /"id":9/);
});
