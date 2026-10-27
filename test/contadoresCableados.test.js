/* Que lo vendido pase SIEMPRE por la costura, y que la costura mande al motor
 * correcto sin tumbar la venta.
 *
 * ── De dónde sale ────────────────────────────────────────────────────────
 *
 * De que este contador ya se rompió una vez y costó 212 personas en FESTECH.
 * La 0138 lo arregló metiendo la suma dentro de una sola sentencia de
 * Postgres; `modules/contadores/` lo reprodujo para MySQL; y `lib/contadores.js`
 * es lo que decide cuál de los dos corre.
 *
 * Lo que se protege aquí son las tres formas de volver a romperlo:
 *
 *   1. Que alguien escriba una llamada NUEVA a `supabase.rpc('sumar_…')`
 *      saltándose la costura. Con la bandera encendida, esa llamada escribiría
 *      en Supabase mientras las demás escriben en MySQL. No daría error: daría
 *      dos contadores, cada uno con la mitad de la verdad.
 *
 *   2. Que la bandera deje de respetarse y se mande al motor equivocado.
 *
 *   3. Que un fallo del contador tumbe la petición. Varias de las trece
 *      llamadas están dentro del webhook de pagos: si una suma fallida
 *      reventara, Mercado Pago reintentaría y un problema de contador se
 *      volvería un problema de cobro.
 *
 * Correr: npm test */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const raiz = (...p) => path.join(__dirname, '..', ...p);

/* Los cinco archivos donde viven las llamadas, y cuántas tiene cada uno. Si
   mañana aparece una sexta, la primera prueba lo dice. */
const DONDE = {
  'lib/confirmarTicket.js'     : 2,
  'lib/agente.js'              : 1,
  'routes/eventos.publicos.js' : 2,
  'routes/clientes.js'         : 4,
  'routes/pagos.js'            : 4,
};

const TODOS = () => fs.readdirSync(raiz('routes')).map(f => `routes/${f}`)
  .concat(fs.readdirSync(raiz('lib')).map(f => `lib/${f}`))
  .filter(f => f.endsWith('.js'));

/* Sin comentarios: este archivo y los de arriba CITAN la llamada vieja al
   explicar por qué no debe usarse, y buscarla en el texto entero la
   encontraría en su propia explicación. Es la trampa que `elLintExiste` ya
   documenta y que ya hizo fallar pruebas en este repo. */
const codigo = (f) => fs.readFileSync(raiz(f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('nadie llama a las RPC de los contadores por fuera de la costura', () => {
  /* El fallo que esto evita no da error: con la bandera encendida, una llamada
     suelta escribe en Supabase mientras el resto escribe en MySQL. */
  const sueltas = TODOS()
    .filter(f => f !== 'lib/contadores.js')
    .filter(f => /rpc\(\s*['"]sumar_(aforo_vendido|vendidos_tipo)['"]/.test(codigo(f)));

  assert.deepEqual(sueltas, [],
    'estas llamadas se saltan lib/contadores.js: usá contadores.sumarAforoVendido() ' +
    'o contadores.sumarVendidosTipo() en vez de supabase.rpc(...)');
});

test('las trece llamadas siguen donde se contaron', () => {
  /* No es por el número en sí: es que si aparecen en un sitio nuevo, hay que
     mirar si ese sitio también tiene que contar — y si desaparecen de uno,
     hay que mirar si se dejó de contar algo que se vende. */
  for (const [archivo, cuantas] of Object.entries(DONDE)) {
    const n = (codigo(archivo).match(/contadores\.sumar(AforoVendido|VendidosTipo)\(/g) || []).length;
    assert.equal(n, cuantas, `${archivo} tenía ${cuantas} y ahora tiene ${n}`);
  }
});

/* ── La costura ─────────────────────────────────────────────────────────── */

/* Carga `lib/contadores.js` con el config y los dos motores simulados.
 *
 * El doble se queda PUESTO hasta que la prueba llame a `restaurar()`, y no se
 * quita al terminar el `require` como sería natural. El motivo es el diseño
 * del propio archivo: pide `supabase` y `modules/contadores` **dentro** de la
 * función, no en la cabecera, para no cargar MySQL con la bandera apagada. Así
 * que el `require` de verdad ocurre en la primera llamada, no al cargar — y un
 * doble que se quita antes no intercepta nada.
 *
 * Costó un rato: la prueba fallaba con «Faltan SUPABASE_URL», que es el
 * Supabase de verdad cargándose porque el doble ya se había retirado. */
function cargarCostura({ datosPropios, errorSupabase = null }) {
  const llamadas = { supabase: [], mysql: [] };
  const ruta = raiz('lib', 'contadores.js');
  delete require.cache[ruta];

  const originalLoad = Module._load;
  Module._load = function (pedido) {
    if (String(pedido).includes('core/config')) return { DATOS_PROPIOS: datosPropios };
    if (String(pedido).includes('supabase')) {
      return { rpc: async (fn, args) => {
        llamadas.supabase.push({ fn, args });
        return errorSupabase ? { data: null, error: errorSupabase } : { data: 1, error: null };
      } };
    }
    if (String(pedido).includes('modules/contadores')) {
      return {
        sumarAforoVendido: async (id, d) => { llamadas.mysql.push({ fn: 'aforo', id, d }); },
        sumarVendidosTipo: async (id, d) => { llamadas.mysql.push({ fn: 'tipo', id, d }); },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  return { mod: require(ruta), llamadas, restaurar: () => { Module._load = originalLoad; } };
}

test('con la bandera apagada va a Supabase, como hasta hoy', async () => {
  const { mod, llamadas, restaurar } = cargarCostura({ datosPropios: false });

  await mod.sumarAforoVendido('e1', 3);
  await mod.sumarVendidosTipo('t1', 1);
  restaurar();

  assert.equal(llamadas.mysql.length, 0, 'apagada, MySQL no se toca');
  assert.deepEqual(llamadas.supabase, [
    { fn: 'sumar_aforo_vendido', args: { p_evento: 'e1', p_delta: 3 } },
    { fn: 'sumar_vendidos_tipo', args: { p_tipo: 't1', p_delta: 1 } },
  ], 'los nombres y los parámetros tienen que ser los mismos que esperan las funciones de la 0138');
});

test('con la bandera encendida va a MySQL', async () => {
  const { mod, llamadas, restaurar } = cargarCostura({ datosPropios: true });

  await mod.sumarAforoVendido('e1', 3);
  await mod.sumarVendidosTipo('t1', -1);
  restaurar();

  assert.equal(llamadas.supabase.length, 0, 'encendida, Supabase no se toca');
  assert.deepEqual(llamadas.mysql, [
    { fn: 'aforo', id: 'e1', d: 3 },
    { fn: 'tipo',  id: 't1', d: -1 },
  ]);
});

test('un fallo del contador NO tumba la petición', async () => {
  /* La razón entera de que esto avise en vez de reventar: varias de las trece
     están dentro del webhook de pagos. Un contador desajustado se recalcula
     —la 0138 trae el update—; una venta perdida, no. */
  const { mod, restaurar } = cargarCostura({
    datosPropios: false,
    errorSupabase: { message: 'la base dijo que no' },
  });

  const errores = [];
  const errorOriginal = console.error;
  console.error = (m) => errores.push(String(m));

  await assert.doesNotReject(() => mod.sumarAforoVendido('e1', 5));

  console.error = errorOriginal;
  restaurar();

  assert.equal(errores.length, 1, 'y tampoco se calla: tiene que quedar dicho');
  /* Con los tres datos, que son los únicos con los que se puede recalcular. */
  assert.match(errores[0], /e1/);
  assert.match(errores[0], /\+5/);
  assert.match(errores[0], /la base dijo que no/);
});

test('sumar cero no viaja a la base', async () => {
  /* Llega de verdad: `ajustarAforo` de clientes.js calcula un delta que da 0
     cuando se edita una boleta sin cambiarle el tipo. */
  const { mod, llamadas, restaurar } = cargarCostura({ datosPropios: false });
  await mod.sumarAforoVendido('e1', 0);
  await mod.sumarVendidosTipo('t1', 0);
  restaurar();
  assert.equal(llamadas.supabase.length, 0);
  assert.equal(llamadas.mysql.length, 0);
});

test('con la bandera apagada no se carga nada de MySQL', () => {
  /* El `require` de `modules/contadores` va DENTRO de la rama encendida a
     propósito: arriba abriría la puerta a que una máquina sin MySQL
     configurado falle al arrancar por una bandera que está apagada. */
  const fuente = codigo('lib/contadores.js');
  const lineas = fuente.split('\n');
  const iRequire = lineas.findIndex(l => l.includes("require('../modules/contadores')"));
  const iBandera = lineas.findIndex(l => l.includes('config.DATOS_PROPIOS'));
  assert.ok(iRequire > 0, 'tiene que requerir el módulo de MySQL en algún punto');
  assert.ok(iBandera > 0 && iBandera < iRequire,
    'el require de MySQL tiene que ir DESPUÉS de comprobar la bandera, no en la cabecera');
});
