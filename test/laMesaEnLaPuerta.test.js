'use strict';

/* La mesa en la puerta: que entren los cuatro, y sólo los cuatro.
 *
 * ── Lo que estaba roto ───────────────────────────────────────────────────
 *
 * La 0118 emitía un puesto por persona y le firmaba un QR con `pid` dentro,
 * pero NADIE leía ese `pid`. El escáner sacaba el `tid` —que el QR de puesto
 * también lleva— y marcaba la BOLETA entera como usada. En una mesa de cuatro,
 * la primera persona quemaba la mesa y las otras tres se quedaban en la calle
 * con un QR válido en la mano.
 *
 * Y la credencial de un puesto ROTA al transferirlo, pero comprobar la firma
 * no puede notar una rotación: el token viejo lleva una firma nuestra igual de
 * buena y los QR no caducan. Sin comparar contra la base, quien vendía su
 * puesto se quedaba con un QR que abría la puerta igual que el del comprador.
 *
 * Se corre sin base: `supabase` está simulado con una tabla en memoria y lo
 * que se comprueba es qué quedó escrito. Es a propósito — una prueba que
 * necesitara Supabase no se correría nunca aquí, y esto se quedaría sin red
 * justo donde más falta hace.
 *
 * Correr: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

/* ── Doble de Supabase ───────────────────────────────────────────────────
 *
 * Sólo lo que estas rutas usan: from().select().eq().order(), y el
 * update().eq().is().neq().select() que es la cerradura. Los filtros se
 * acumulan y se aplican al resolver, igual que hace el cliente de verdad. */
function baseSimulada(tablas = {}) {
  const datos = JSON.parse(JSON.stringify(tablas));
  const escrituras = [];

  const casa = (fila, filtros) => filtros.every(([tipo, col, val]) => {
    if (tipo === 'eq') return fila[col] === val;
    if (tipo === 'neq') return fila[col] !== val;
    if (tipo === 'is') return fila[col] === val;
    if (tipo === 'in') return val.includes(fila[col]);
    return true;
  });

  function constructor(tabla) {
    const filtros = [];
    let modo = 'select';
    let cambios = null;
    let orden = null;

    const ejecutar = () => {
      const filas = datos[tabla] || [];
      if (modo === 'select') {
        let out = filas.filter(f => casa(f, filtros));
        if (orden) out = [...out].sort((a, b) => (a[orden] > b[orden] ? 1 : -1));
        return { data: out, error: null };
      }
      /* update: sólo las que pasan TODOS los filtros — ahí vive la cerradura. */
      const tocadas = [];
      for (const f of filas) {
        if (!casa(f, filtros)) continue;
        Object.assign(f, cambios);
        tocadas.push({ ...f });
      }
      escrituras.push({ tabla, cambios, filtros: [...filtros], tocadas: tocadas.length });
      return { data: tocadas, error: null };
    };

    const api = {
      select() { return api; },
      update(c) { modo = 'update'; cambios = c; return api; },
      eq(col, val) { filtros.push(['eq', col, val]); return api; },
      neq(col, val) { filtros.push(['neq', col, val]); return api; },
      is(col, val) { filtros.push(['is', col, val]); return api; },
      in(col, val) { filtros.push(['in', col, val]); return api; },
      order(col) { orden = col; return api; },
      maybeSingle() {
        const r = ejecutar();
        return Promise.resolve({ data: r.data[0] || null, error: r.error });
      },
      then(resolver, rechazar) { return Promise.resolve(ejecutar()).then(resolver, rechazar); },
    };
    return api;
  }

  return { cliente: { from: constructor }, datos, escrituras };
}

/* Carga `lib/puertaDePuestos.js` con la base simulada debajo. */
function cargarPuerta(simulada) {
  const ruta = path.resolve(__dirname, '../lib/puertaDePuestos.js');
  const rutaSupabase = path.resolve(__dirname, '../lib/supabase.js');
  delete require.cache[ruta];
  delete require.cache[rutaSupabase];
  const originalLoad = Module._load;
  Module._load = function (pedido) {
    if (String(pedido).includes('supabase.js')) return simulada.cliente;
    return originalLoad.apply(this, arguments);
  };
  try { return require(ruta); }
  finally { Module._load = originalLoad; delete require.cache[ruta]; }
}

const TICKET = { id: 't1', codigo: 'ABC12345', evento_id: 'e1' };
const AHORA = '2026-09-13T20:00:00.000Z';

/* Una mesa de cuatro con un QR firmado por puesto (modo `individual`). */
const mesaDeCuatro = () => ({
  ticket_puestos: [1, 2, 3, 4].map(n => ({
    id: `p${n}`, ticket_id: 't1', evento_id: 'e1', orden: n,
    nombre: `Persona ${n}`, email: null, estado: 'asignado',
    qr_token: `token-p${n}`, credencial_gen: 0, usado_at: null,
  })),
  tickets: [{ ...TICKET, estado: 'pagado', checked_in_at: null }],
});

/* ── Lo que de verdad se rompía ──────────────────────────────────────── */

test('los cuatro de una mesa entran, uno por escaneo', async () => {
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  for (const n of [1, 2, 3]) {
    const r = await puerta.consumirPuesto({
      ticket: TICKET, puestoIdDelQr: `p${n}`, token: `token-p${n}`, at: AHORA,
    });
    assert.equal(r.ok, true, `el puesto ${n} no pudo entrar`);
    assert.equal(r.agotado, false, `la mesa se dio por agotada en el puesto ${n}`);
    assert.equal(r.estado.dentro, n);
    assert.equal(r.estado.quedan, 4 - n);
  }

  /* El cuarto cierra la mesa: ahí es cuando la boleta pasa a estar usada, y no
     antes — por eso `agotado`, que devuelve a la ruta al camino de siempre. */
  const ultimo = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p4', token: 'token-p4', at: AHORA,
  });
  assert.equal(ultimo.ok, true);
  assert.equal(ultimo.agotado, true);
  assert.equal(ultimo.estado.quedan, 0);
});

test('la boleta NO se marca usada mientras quede sitio en la mesa', async () => {
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: 'p1', token: 'token-p1', at: AHORA });

  assert.equal(sim.datos.tickets[0].estado, 'pagado',
    'marcar la boleta con el primero es lo que dejaba fuera al resto de la mesa');
  /* Y nadie escribió en `tickets`: esa escritura vive en la ruta, una sola vez,
     para que los puntos y las automatizaciones corran una vez por boleta. */
  assert.equal(sim.escrituras.some(e => e.tabla === 'tickets'), false);
});

test('el mismo puesto no entra dos veces', async () => {
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: 'p2', token: 'token-p2', at: AHORA });
  const repetido = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p2', token: 'token-p2', at: AHORA,
  });

  assert.equal(repetido.ok, false);
  assert.equal(repetido.motivo, 'usado');
  /* Y los otros tres siguen pudiendo entrar. */
  assert.equal(repetido.estado.quedan, 3);
});

/* ── La rotación: lo que hace real una transferencia ──────────────────── */

test('un token rotado por una transferencia ya NO abre la puerta', async () => {
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  /* Se transfiere el puesto 3: sube la GENERACIÓN de su credencial (0127) y se
     firma un token nuevo con ella. */
  sim.datos.ticket_puestos[2].qr_token = 'token-p3-NUEVO';
  sim.datos.ticket_puestos[2].credencial_gen = 1;
  sim.datos.ticket_puestos[2].nombre = 'Quien lo compró';

  /* Quien lo vendió se quedó con el QR viejo. Su firma sigue siendo nuestra y
     perfectamente válida — por eso comprobar la firma no bastaba. */
  const viejo = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p3', token: 'token-p3', gen: 0, at: AHORA,
  });
  assert.equal(viejo.ok, false, 'el QR del vendedor abrió la puerta');
  assert.equal(viejo.motivo, 'rotado');
  assert.match(viejo.mensaje, /se transfirió/);
  assert.equal(sim.datos.ticket_puestos[2].estado, 'asignado', 'el puesto se consumió igual');

  /* Y el nuevo sí entra. */
  const nuevo = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p3', token: 'token-p3-NUEVO', gen: 1, at: AHORA,
  });
  assert.equal(nuevo.ok, true, 'quien compró el puesto no pudo entrar');
});

test('pero el QR de un REENVÍO sigue abriendo, que no es lo mismo', async () => {
  /* Lo que se rompía antes de la 0127.
   *
   * El correo con la boleta se pierde y la persona pide que se lo manden otra
   * vez. Cada envío firma un token nuevo del MISMO puesto: nadie transfirió
   * nada, no hay segundo titular, no hay reventa. Con la comparación contra el
   * token guardado, quien llegaba con el correo del primer envío —o con la
   * escarapela ya impresa— se encontraba la puerta cerrada y, encima, un
   * mensaje que decía «se transfirió», que era mentira.
   *
   * Lo que separa las dos cosas es la generación: reenviar no la mueve. */
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  /* Se reenvía el correo del puesto 2: token nuevo, MISMA generación. */
  sim.datos.ticket_puestos[1].qr_token = 'token-p2-REENVIADO';

  const conElViejo = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p2', token: 'token-p2', gen: 0, at: AHORA,
  });
  assert.equal(conElViejo.ok, true, 'el QR del primer correo dejó de abrir');
  assert.equal(sim.datos.ticket_puestos[1].estado, 'usado');
});

test('y los QR de antes de la 0127, que no llevan generación, abren igual', async () => {
  /* No hay que reemitir nada: un QR sin `g` es la generación 0, y 0 es lo que
     tienen todos los puestos que ya existían. Si esto fallara, aplicar la
     migración dejaría fuera a todo el que ya tiene su boleta. */
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  const r = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p1', token: 'token-p1', at: AHORA,  // sin `gen`
  });
  assert.equal(r.ok, true, 'un QR de antes de la 0127 dejó de abrir');
});

test('un puesto a medio transferir no abre, pero tampoco se pierde', async () => {
  /* `aplicarTransferencia` deja `qr_token` en null a propósito, para que un
     fallo a mitad no deje dos credenciales buenas circulando. */
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);
  sim.datos.ticket_puestos[0].qr_token = null;

  const r = await puerta.consumirPuesto({
    ticket: TICKET, puestoIdDelQr: 'p1', token: 'token-p1', at: AHORA,
  });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'sin_token');
  assert.equal(sim.datos.ticket_puestos[0].estado, 'asignado');
});

/* ── El QR de la boleta en una mesa (modo `contador`) ─────────────────── */

test('con el QR de la boleta, la puerta CUENTA en vez de cerrar la mesa', async () => {
  /* Modo `contador`: los puestos no llevan credencial propia, hay una sola
     —la de la boleta— y cada escaneo consume un sitio. Antes, el primero
     marcaba la boleta y los otros tres se quedaban fuera. */
  const sim = baseSimulada({
    ticket_puestos: [1, 2, 3].map(n => ({
      id: `c${n}`, ticket_id: 't1', evento_id: 'e1', orden: n,
      nombre: null, email: null, estado: 'libre', qr_token: null, usado_at: null,
    })),
    tickets: [{ ...TICKET, estado: 'pagado', checked_in_at: null }],
  });
  const puerta = cargarPuerta(sim);

  const uno = await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: null, token: 'tok-boleta', at: AHORA });
  assert.equal(uno.ok, true);
  assert.equal(uno.estado.dentro, 1);

  const dos = await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: null, token: 'tok-boleta', at: AHORA });
  assert.equal(dos.ok, true);
  assert.equal(dos.estado.dentro, 2);

  const tres = await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: null, token: 'tok-boleta', at: AHORA });
  assert.equal(tres.agotado, true);

  /* El cuarto escaneo ya no: se acabaron los sitios. */
  const cuatro = await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: null, token: 'tok-boleta', at: AHORA });
  assert.equal(cuatro.ok, false);
  assert.equal(cuatro.motivo, 'completa');
});

/* ── Que nada de esto toque a las boletas normales ───────────────────── */

test('una boleta de una persona sigue yendo por el camino de siempre', async () => {
  for (const filas of [[], [{ id: 'p1', ticket_id: 't1', estado: 'asignado', qr_token: 'x', orden: 1 }]]) {
    const sim = baseSimulada({ ticket_puestos: filas, tickets: [{ ...TICKET, estado: 'pagado' }] });
    const puerta = cargarPuerta(sim);
    const r = await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: null, token: 't', at: AHORA });
    assert.equal(r.aplica, false,
      'una boleta sin puestos (o con uno) no puede cambiar de camino: es el 99 % de las boletas');
  }
});

test('sin la 0118 aplicada, el check-in sigue funcionando', async () => {
  /* La tabla no existe: leer los puestos falla. Eso NO puede tumbar la puerta
     de un evento entero — se entra como se entraba antes. */
  const sim = baseSimulada({ tickets: [{ ...TICKET, estado: 'pagado' }] });
  sim.cliente.from = (tabla) => {
    if (tabla === 'ticket_puestos') throw new Error('relation "ticket_puestos" does not exist');
    return baseSimulada({}).cliente.from(tabla);
  };
  const puerta = cargarPuerta(sim);

  assert.deepEqual(await puerta.puestosDe('t1'), []);
  const r = await puerta.consumirPuesto({ ticket: TICKET, puestoIdDelQr: null, token: 't', at: AHORA });
  assert.equal(r.aplica, false);
});

/* ── La cerradura ────────────────────────────────────────────────────── */

test('marcar un puesto compara la generación DENTRO del update, no antes', async () => {
  /* Entre leer el puesto y escribirlo cabe una transferencia. Si la
     comparación viviera sólo en la lectura, ese hueco dejaría entrar a quien
     acaba de dejar de ser el titular. Por eso `eq('credencial_gen', …)` viaja
     en el propio update, junto al `neq('estado','usado')` que impide el doble
     escaneo desde dos puertas a la vez.

     Era `eq('qr_token', …)` hasta la 0127, y cerraba el mismo hueco: lo que
     cambió es que el token también se mueve al reenviar un correo, y la
     generación sólo al transferir. */
  const sim = baseSimulada(mesaDeCuatro());
  const puerta = cargarPuerta(sim);

  await puerta.marcarPuestoUsado({ puesto: { id: 'p1' }, gen: 0, at: AHORA });

  const escritura = sim.escrituras.find(e => e.tabla === 'ticket_puestos');
  const tipos = escritura.filtros.map(f => `${f[0]}:${f[1]}`);
  assert.ok(tipos.includes('eq:credencial_gen'), 'el update no compara la generación');
  assert.ok(tipos.includes('neq:estado'), 'el update no lleva la cerradura del doble escaneo');
});

/* ── El ir y venir: que el aforo cuente personas, no boletas ──────────── */

/* El reingreso sin `tipo` alterna según el último movimiento de la BOLETA.
 * Con cuatro personas compartiéndola, alternaba ENTRE ELLAS: entraba la 1,
 * «salía» la 2, entraba la 3, «salía» la 4. Cuatro personas entrando y el
 * aforo diciendo que no hay nadie — sin ningún error a la vista, que es el
 * peor modo de fallo para el número que decide si se cierra una puerta. */

const mesaConMovimientos = () => ({
  ...mesaDeCuatro(),
  ticket_movimientos: [],
});

test('cuatro escaneos de reingreso son cuatro ENTRADAS, no un vaivén', async () => {
  const sim = baseSimulada(mesaConMovimientos());
  const puerta = cargarPuerta(sim);
  const lista = sim.datos.ticket_puestos;

  const sentidos = [];
  for (const n of [1, 2, 3, 4]) {
    const v = await puerta.vaivenDePuesto({
      ticket: TICKET, puestoIdDelQr: `p${n}`, tipoPedido: null, puestos: lista,
    });
    sentidos.push(v.tipo);
    /* Se anota el movimiento, como haría la ruta. */
    sim.datos.ticket_movimientos.push({
      ticket_id: 't1', puesto_id: v.puesto.id, tipo: v.tipo,
      created_at: `2026-09-13T20:0${n}:00Z`, zona: null, zona_id: null,
    });
  }

  assert.deepEqual(sentidos, ['entrada', 'entrada', 'entrada', 'entrada'],
    'el escáner volvió a alternar entre las personas de la misma mesa');
});

test('cada persona de la mesa va y viene por su cuenta', async () => {
  const sim = baseSimulada(mesaConMovimientos());
  const puerta = cargarPuerta(sim);
  const lista = sim.datos.ticket_puestos;
  const anotar = (v) => sim.datos.ticket_movimientos.push({
    ticket_id: 't1', puesto_id: v.puesto.id, tipo: v.tipo,
    created_at: `2026-09-13T2${sim.datos.ticket_movimientos.length}:00:00Z`,
    zona: null, zona_id: null,
  });

  /* Entran la 1 y la 2. */
  for (const n of [1, 2]) {
    anotar(await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: `p${n}`, puestos: lista }));
  }
  /* La 1 sale a fumar: es SU segundo escaneo, así que es una salida. */
  const sale = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: 'p1', puestos: lista });
  assert.equal(sale.tipo, 'salida');
  anotar(sale);

  /* Y la 2 sigue dentro: su estado no se movió porque salió otra persona. */
  const dosSale = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: 'p2', puestos: lista });
  assert.equal(dosSale.tipo, 'salida', 'la persona 2 no constaba dentro');

  /* La 1 vuelve. */
  const vuelve = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: 'p1', puestos: lista });
  assert.equal(vuelve.tipo, 'entrada');
});

test('con el QR de la boleta se elige por el sentido: fuera para entrar, dentro para salir', async () => {
  /* Una sola credencial para toda la mesa: no hay forma de saber cuál de los
     cuatro la enseña, pero la CUENTA tiene que quedar bien. */
  const sim = baseSimulada(mesaConMovimientos());
  const puerta = cargarPuerta(sim);
  const lista = sim.datos.ticket_puestos;

  const primera = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: null, puestos: lista });
  assert.equal(primera.tipo, 'entrada');
  assert.equal(primera.puesto.orden, 1, 'se eligió un puesto al azar en vez del primero libre');
  sim.datos.ticket_movimientos.push({
    ticket_id: 't1', puesto_id: primera.puesto.id, tipo: 'entrada',
    created_at: '2026-09-13T20:01:00Z', zona: null, zona_id: null,
  });

  /* El segundo escaneo es otra entrada —queda gente fuera—, no una salida. */
  const segunda = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: null, puestos: lista });
  assert.equal(segunda.tipo, 'entrada');
  assert.notEqual(segunda.puesto.id, primera.puesto.id, 'contó dos veces a la misma persona');

  /* Pidiendo salida explícita, sale alguien que esté dentro. */
  const salida = await puerta.vaivenDePuesto({
    ticket: TICKET, puestoIdDelQr: null, tipoPedido: 'salida', puestos: lista,
  });
  assert.equal(salida.puesto.id, primera.puesto.id, 'sacó a alguien que no estaba dentro');
});

test('no se puede sacar a quien no entró, ni meter a quien ya está dentro', async () => {
  const sim = baseSimulada(mesaConMovimientos());
  const puerta = cargarPuerta(sim);
  const lista = sim.datos.ticket_puestos;

  const sinNadie = await puerta.vaivenDePuesto({
    ticket: TICKET, puestoIdDelQr: null, tipoPedido: 'salida', puestos: lista,
  });
  assert.equal(sinNadie.ok, false);
  assert.equal(sinNadie.motivo, 'nadie_dentro');

  /* Con los cuatro dentro, una entrada más no tiene a quién meter. */
  sim.datos.ticket_movimientos = lista.map((p, i) => ({
    ticket_id: 't1', puesto_id: p.id, tipo: 'entrada',
    created_at: `2026-09-13T20:0${i}:00Z`, zona: null, zona_id: null,
  }));
  const llena = await puerta.vaivenDePuesto({
    ticket: TICKET, puestoIdDelQr: null, tipoPedido: 'entrada', puestos: lista,
  });
  assert.equal(llena.ok, false);
  assert.equal(llena.motivo, 'todos_dentro');
});

test('quien entró por el check-in cuenta como dentro aunque no tenga movimientos', async () => {
  /* Si no, la primera salida de la noche se registraría como una entrada y el
     aforo sumaría a alguien que ya estaba contado. */
  const sim = baseSimulada(mesaConMovimientos());
  const puerta = cargarPuerta(sim);
  sim.datos.ticket_puestos[0].estado = 'usado';
  const lista = sim.datos.ticket_puestos;

  const dentro = await puerta.quienEstaDentro({ puestos: lista });
  assert.deepEqual(dentro, ['p1']);

  const v = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: 'p1', puestos: lista });
  assert.equal(v.tipo, 'salida', 'quien ya había entrado volvió a «entrar»');
});

test('el vaivén de una zona no hereda la entrada al recinto', async () => {
  /* Se puede estar dentro del recinto y fuera de una sala. */
  const sim = baseSimulada(mesaConMovimientos());
  const puerta = cargarPuerta(sim);
  sim.datos.ticket_puestos[0].estado = 'usado';
  const lista = sim.datos.ticket_puestos;

  const enZona = await puerta.quienEstaDentro({ puestos: lista, zona: { id: 'z1', nombre: 'Sala A' } });
  assert.deepEqual(enZona, [], 'entrar al recinto contó como entrar a la sala');
});

test('una boleta de una persona no cambia de camino en el reingreso', async () => {
  const sim = baseSimulada({ ticket_puestos: [], ticket_movimientos: [], tickets: [TICKET] });
  const puerta = cargarPuerta(sim);
  const v = await puerta.vaivenDePuesto({ ticket: TICKET, puestoIdDelQr: null });
  assert.equal(v.aplica, false);
});
