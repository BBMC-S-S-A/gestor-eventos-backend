'use strict';

/* core/db/postgrest.js — el idioma de PostgREST, hablado contra MySQL.
 *
 * ── Qué es esto y por qué existe ─────────────────────────────────────────
 *
 * Quedan 1.152 llamadas `supabase.from(...)` repartidas en 95 archivos. El
 * camino A era reescribirlas una por una; el B, que es el que se tomó, es
 * implementar el subconjunto del idioma que de verdad se usa y que
 * `lib/supabase.js` devuelva esto en vez del cliente cuando `DATOS_PROPIOS`
 * esté encendido. Las 1.152 no se tocan. El razonamiento completo y la medida
 * de la superficie están en `db/EL-RESTO-DE-LAS-RUTAS.md`.
 *
 * ── LA REGLA ─────────────────────────────────────────────────────────────
 *
 * **Lo que esto no sepa hacer, LANZA.** No devuelve una lista parcial, no
 * ignora un filtro que no entiende y no adivina.
 *
 * Y lanza de verdad —`throw`—, no devuelve `{ error }`. Esa distinción es el
 * corazón del asunto y conviene entender por qué:
 *
 *     const { data: activos } = await supabase.from('webhooks')…   // lib/webhooks.js
 *
 * Así están escritas muchas de las 1.152: recogen `data` y tiran el `error`.
 * Si un método no soportado devolviera `{ data: null, error }`, el código de
 * arriba vería `undefined`, lo trataría como «no hay webhooks» y seguiría tan
 * campante. Eso es exactamente el modo de fallo que este proyecto arrastra:
 * no revienta, devuelve de menos. Una excepción no se puede ignorar sin
 * escribirlo a propósito.
 *
 * Los errores de SQL de verdad SÍ vuelven como `{ data: null, error }`, porque
 * es lo que hace supabase-js hoy y lo que el código de alrededor espera. Eso
 * no es una regresión: es el comportamiento de siempre.
 *
 * ── Lo que cubre hoy (tramo 1 de 8) ──────────────────────────────────────
 *
 *   from · select(columnas) · eq · order · limit · single · maybeSingle
 *
 * Todo lo demás —`insert`, `update`, `delete`, `in`, `is`, `or`, `ilike`,
 * `count`, los JOIN embebidos, `rpc`— lanza con un mensaje que dice en qué
 * tramo entra. Los tramos están en `db/EL-RESTO-DE-LAS-RUTAS.md` §3.
 *
 * ── Cómo está partido, y por qué ─────────────────────────────────────────
 *
 * `compilar(plan)` es una función pura: plan dentro, `{ sql, params }` fuera.
 * Ni base ni red. Así la parte difícil —la semántica— se prueba entera en el
 * CI, que no tiene MySQL, y las pruebas contra MySQL de verdad comprueban que
 * ese SQL hace lo que se cree (`test/postgrest.contraMysql.test.js`).
 */

const { bd } = require('./mysql.js');

/* ── Lanzar ──────────────────────────────────────────────────────────────
 *
 * Un mensaje que diga QUÉ falta y DÓNDE mirarlo. Quien se lo encuentre está a
 * mitad de una migración y necesita saber si es un olvido o un «todavía no».
 */
function noSoportado(que, tramo) {
  const donde = tramo ? ` Entra en el tramo ${tramo} de db/EL-RESTO-DE-LAS-RUTAS.md §3.` : '';
  const e = new Error(
    `[postgrest] ${que} no está soportado por el adaptador de MySQL.${donde}\n` +
    'Esto LANZA a propósito: devolver una lista parcial sería el fallo silencioso ' +
    'que este adaptador existe para evitar (ver la cabecera de core/db/postgrest.js).'
  );
  e.code = 'PGRST_NO_SOPORTADO';
  throw e;
}

/* ── Identificadores ─────────────────────────────────────────────────────
 *
 * Las tablas y columnas no pueden ir como parámetro: van pegadas al SQL. Por
 * eso se validan contra una lista blanca de forma en vez de escaparse. Lo que
 * no case, lanza — y lanza antes de tocar la base, que es donde se quiere que
 * salte.
 */
const FORMA_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(nombre, de) {
  const n = String(nombre ?? '');
  if (!FORMA_IDENT.test(n)) noSoportado(`el nombre «${n}» en ${de}`);
  return `\`${n}\``;
}

/* ── El `select` ─────────────────────────────────────────────────────────
 *
 * PostgREST mete tres cosas distintas en la misma cadena:
 *
 *   'id, nombre'                            → columnas. Esto sí.
 *   'alias:columna'                         → renombrado. Cero usos hoy.
 *   '*, autor:profiles!autor_id(id, nombre)' → JOIN embebido. 66 usos, tramo 5.
 *
 * Los dos últimos lanzan. El JOIN embebido se reconoce por el paréntesis, y es
 * importante cazarlo aquí: si se colara, el `(` acabaría dentro de un nombre de
 * columna y MySQL daría un error de sintaxis a destiempo, con un mensaje que no
 * explicaría nada.
 */
function columnas(seleccion) {
  const s = String(seleccion ?? '*').trim();
  if (s === '*') return '*';
  if (s.includes('(')) noSoportado('un `select` con JOIN embebido', 5);
  if (s.includes(':')) noSoportado('un `select` con renombrado (`alias:columna`)', 1);

  const partes = s.split(',').map(p => p.trim()).filter(Boolean);
  if (!partes.length) noSoportado('un `select` vacío');
  return partes.map(c => (c === '*' ? '*' : ident(c, 'un `select`'))).join(', ');
}

/* ── El orden, que es donde los dos motores NO coinciden ─────────────────
 *
 * Esto es la trampa fina de todo el adaptador, porque no da error: ordena, y
 * ordena distinto.
 *
 *   Postgres : ASC → los NULL al FINAL. DESC → los NULL al PRINCIPIO.
 *   MySQL    : el NULL es el valor más bajo, siempre.
 *              ASC → los NULL al PRINCIPIO. DESC → los NULL al FINAL.
 *
 * O sea que están cambiados en los dos sentidos. Una lista de eventos ordenada
 * por una fecha que admite NULL saldría con los sin-fecha arriba en vez de
 * abajo, y nadie lo llamaría un fallo: lo llamarían «se ve raro».
 *
 * Se arregla ordenando primero por si la columna es NULL:
 *
 *   ORDER BY (`col` IS NULL) ASC, `col` ASC    → nulos al final  (Postgres ASC)
 *   ORDER BY (`col` IS NULL) DESC, `col` DESC  → nulos al principio (Postgres DESC)
 *
 * `nullsFirst` por defecto vale `!ascending`, que es justo la regla de
 * Postgres, así que las dos líneas de arriba son el mismo caso general. Cuando
 * quien llama lo dice explícitamente —`routes/vacantes.js:73` es el único hoy—
 * manda lo que diga.
 */
function unOrden({ col, ascending, nullsFirst }) {
  const c = ident(col, 'un `order`');
  const dir = ascending ? 'ASC' : 'DESC';
  const primero = (nullsFirst ?? !ascending) ? 'DESC' : 'ASC';
  return `(${c} IS NULL) ${primero}, ${c} ${dir}`;
}

/* ── Compilar ────────────────────────────────────────────────────────────
 *
 * Pura: ni base, ni red, ni reloj. Es lo que hace que la semántica se pueda
 * probar entera en un CI sin MySQL.
 */
function compilar(plan) {
  const partes = [`SELECT ${plan.columnas} FROM ${ident(plan.tabla, 'un `from`')}`];
  const params = [];

  if (plan.filtros.length) {
    const donde = plan.filtros.map((f) => {
      if (f.tipo !== 'eq') noSoportado(`el filtro \`${f.tipo}\``, 2);
      /* `eq` con null: PostgREST lo traduce a `IS NULL`, y en SQL `= NULL`
         nunca casa con nada. Sin esto, un `.eq('borrado_at', null)` devolvería
         cero filas en silencio en vez de las no borradas. */
      if (f.valor === null) return `${ident(f.col, 'un `eq`')} IS NULL`;
      params.push(f.valor);
      return `${ident(f.col, 'un `eq`')} = ?`;
    });
    partes.push(`WHERE ${donde.join(' AND ')}`);
  }

  if (plan.orden.length) partes.push(`ORDER BY ${plan.orden.map(unOrden).join(', ')}`);

  /* El límite.
   *
   * Cuando se pide UNA fila y no hay límite propio, se pone 2. No es un capricho
   * de rendimiento: `single()` tiene que distinguir «una» de «más de una», y con
   * dos filas ya se sabe. Traer las 40.000 que podría haber para contarlas y
   * tirarlas sería lo mismo de cara afuera y mucho más caro.
   *
   * Si quien llama puso su propio `limit`, manda el suyo: `.limit(5).single()`
   * tiene que fallar igual que falla hoy, no arreglarse solo. */
  const limite = plan.limite ?? (plan.forma === 'muchas' ? null : 2);
  if (limite !== null) {
    if (!Number.isInteger(limite) || limite < 0) noSoportado(`un \`limit\` de «${plan.limite}»`);
    /* El límite va pegado al SQL, no como parámetro: MySQL no admite `?` en
       LIMIT con sentencias preparadas. Es seguro porque acaba de comprobarse
       que es un entero. */
    partes.push(`LIMIT ${limite}`);
  }

  return { sql: partes.join(' '), params };
}

/* ── Ejecutar ────────────────────────────────────────────────────────────
 *
 * La forma de la respuesta es la de supabase-js, porque las 1.152 llamadas
 * están escritas contra ella: `{ data, error }`, y `error` con `code`,
 * `message`, `details` y `hint`.
 *
 * `PGRST116` es el código que devuelve PostgREST cuando se pidió un objeto y
 * no vino exactamente una fila. Se copia tal cual para que el código que ya lo
 * mira —hay quien distingue «no encontrado» de «falló»— siga funcionando.
 */
function errorPgrst(mensaje, { code = 'PGRST116', details = null, hint = null } = {}) {
  return { code, message: mensaje, details, hint };
}

async function ejecutar(plan, { base = bd('datos') } = {}) {
  const { sql, params } = compilar(plan);

  let filas;
  try {
    filas = await base.consultar(sql, params);
  } catch (e) {
    /* Un error de SQL de verdad vuelve como `{ error }`, no lanzado: es lo que
       hace supabase-js y lo que el código de alrededor espera. Lo que lanza es
       lo NO SOPORTADO, que es cosa distinta y pasa antes de llegar aquí. */
    return {
      data : null,
      error: errorPgrst(e.message, { code: e.code || 'PGRST_SQL', details: sql }),
      count: null,
    };
  }

  if (plan.forma === 'muchas') return { data: filas, error: null, count: null };

  if (filas.length === 1) return { data: filas[0], error: null, count: null };

  if (filas.length === 0) {
    /* `maybeSingle()` con cero filas NO es un error: devuelve null limpio. Es
       la diferencia entera entre los dos métodos, y hay 378 `maybeSingle` que
       dependen de ella. */
    if (plan.forma === 'unaONinguna') return { data: null, error: null, count: null };
    return {
      data : null,
      error: errorPgrst('JSON object requested, multiple (or no) rows returned', {
        details: 'The result contains 0 rows',
      }),
      count: null,
    };
  }

  return {
    data : null,
    error: errorPgrst('JSON object requested, multiple (or no) rows returned', {
      details: `The result contains ${filas.length} rows`,
    }),
    count: null,
  };
}

/* ── El constructor ──────────────────────────────────────────────────────
 *
 * Es «thenable»: no es una promesa, pero tiene `then`, así que `await` sobre él
 * lo ejecuta. Es como funciona supabase-js y por eso las 1.152 llamadas están
 * escritas sin un `.ejecutar()` al final.
 *
 * Va envuelto en un Proxy, y eso es LA REGLA hecha código: cualquier método que
 * no esté implementado lanza al tocarlo, con su nombre dentro del mensaje. Sin
 * el Proxy, un `.ilike(...)` daría «ilike is not a function», que no dice si
 * falta implementarlo o si está mal escrito.
 */

/* Nombres que las herramientas de JavaScript preguntan solas —`console.log`,
   `JSON.stringify`, el `assert` de las pruebas— y que no son métodos de
   PostgREST. Devuelven `undefined` en vez de lanzar, o no se podría ni mirar un
   constructor en un depurador. */
const DE_LA_CASA = new Set([
  'toJSON', 'toString', 'valueOf', 'constructor', 'inspect', 'nodeType',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '$$typeof',
]);

function constructor(tabla, opciones = {}) {
  const plan = {
    tabla,
    columnas: '*',
    filtros : [],
    orden   : [],
    limite  : null,
    forma   : 'muchas',
  };

  const api = {
    select(seleccion, extra) {
      /* `select('*', { count: 'exact' })` — 53 usos, y contar tiene su propia
         semántica (¿antes o después del `limit`?). Tramo 4. */
      if (extra && extra.count) noSoportado('`select` con `count`', 4);
      plan.columnas = columnas(seleccion);
      return envuelto;
    },

    eq(col, valor) {
      plan.filtros.push({ tipo: 'eq', col, valor });
      return envuelto;
    },

    order(col, opts = {}) {
      /* Ordenar por una columna de una tabla relacionada necesita el JOIN, que
         es el tramo 5. Cero usos hoy, pero si entra uno tiene que saltar. */
      if (opts.referencedTable || opts.foreignTable) noSoportado('`order` sobre una tabla relacionada', 5);
      plan.orden.push({
        col,
        ascending : opts.ascending !== false,
        nullsFirst: opts.nullsFirst,
      });
      return envuelto;
    },

    limit(n) {
      plan.limite = n;
      return envuelto;
    },

    single() {
      plan.forma = 'una';
      return envuelto;
    },

    maybeSingle() {
      plan.forma = 'unaONinguna';
      return envuelto;
    },

    /* Lo que hace que `await` funcione. Se ejecuta aquí, una sola vez por
       `await`, igual que supabase-js. */
    then(alCumplir, alFallar) {
      return ejecutar(plan, opciones).then(alCumplir, alFallar);
    },

    /* Para las pruebas y para depurar: el SQL sin ir a la base. No lleva `_`
       por capricho — marca que no es parte del idioma de PostgREST. */
    _compilar() { return compilar(plan); },
    _plan() { return { ...plan }; },
  };

  const envuelto = new Proxy(api, {
    get(destino, prop) {
      if (prop in destino) return destino[prop];
      if (typeof prop === 'symbol' || DE_LA_CASA.has(prop)) return undefined;
      noSoportado(`el método \`.${String(prop)}()\``, 'que corresponda');
    },
  });

  return envuelto;
}

/* ── La puerta ───────────────────────────────────────────────────────────
 *
 * La misma forma que el cliente de supabase, para que `lib/supabase.js` pueda
 * devolver una cosa o la otra según `DATOS_PROPIOS` sin que nadie más se entere.
 */
function crear(opciones = {}) {
  return {
    from: (tabla) => constructor(tabla, opciones),
    rpc : (nombre) => noSoportado(`la función \`${nombre}()\``, 7),
    /* `storage` y `auth` no viven aquí: los cubren `ARCHIVOS_PROPIOS` y
       `AUTH_PROPIA`, que son banderas aparte. Si alguien los pide desde este
       objeto es que se cableó mal, y tiene que saltar. */
    get storage() { return noSoportado('`storage` desde el adaptador de datos (es `ARCHIVOS_PROPIOS`)'); },
    get auth() { return noSoportado('`auth` desde el adaptador de datos (es `AUTH_PROPIA`)'); },
  };
}

module.exports = crear();
module.exports.crear = crear;
module.exports._compilar = compilar;
module.exports._noSoportado = noSoportado;
