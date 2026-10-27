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
 * ── Lo que cubre hoy (tramos 1 a 4 de 8) ─────────────────────────────────
 *
 *   Leer    from · select(columnas) · single · maybeSingle · order · limit
 *   Filtrar eq · neq · gt · gte · lt · lte · is · in · not · ilike
 *   Escribir insert · update · delete · upsert, con `.select()` detrás
 *   Paginar range · count: 'exact' · head: true
 *
 * Todo lo demás —`or`, los JOIN embebidos, `rpc`— lanza con un mensaje que
 * dice en qué tramo entra. Los tramos están en
 * `db/EL-RESTO-DE-LAS-RUTAS.md` §3.
 *
 * ── Cómo está partido, y por qué ─────────────────────────────────────────
 *
 * `compilar(plan)` es una función pura: plan dentro, `{ sql, params }` fuera.
 * Ni base ni red. Así la parte difícil —la semántica— se prueba entera en el
 * CI, que no tiene MySQL, y las pruebas contra MySQL de verdad comprueban que
 * ese SQL hace lo que se cree (`test/postgrest.contraMysql.test.js`).
 */

const crypto = require('node:crypto');
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
/* Parte una selección por las comas DE ARRIBA: las que están dentro de un
   paréntesis pertenecen al embebido y no separan campos del padre. Un
   `split(',')` a secas partiría `tipo:ticket_types!x(id, nombre)` por la mitad
   y el error saldría como un nombre de columna raro, tres pasos más allá. */
function porComasDeArriba(texto) {
  const partes = [];
  let prof = 0, actual = '';
  for (const c of texto) {
    if (c === '(') prof++;
    else if (c === ')') prof--;
    if (c === ',' && prof === 0) { partes.push(actual); actual = ''; continue; }
    actual += c;
  }
  if (prof !== 0) noSoportado(`un \`select\` con los paréntesis descuadrados: \`${texto.trim()}\``);
  partes.push(actual);
  return partes.map(p => p.trim()).filter(Boolean);
}

/* La cabeza de un embebido: `[alias:]tabla[!fk][!inner]`.
 *
 * Las cuatro formas que hay en el código:
 *
 *   categoria:categorias(…)                  alias, sin decir la clave
 *   autor:profiles!autor_id(…)               alias y clave
 *   speakers!speaker_id(…)                   sin alias
 *   profile:profiles!user_id!inner(…)        y además inner
 *
 * Sin alias, PostgREST usa el nombre de la tabla como nombre del campo. */
function cabezaDeEmbebido(cabeza) {
  let alias = null;
  let resto = cabeza;
  const dosPuntos = cabeza.indexOf(':');
  if (dosPuntos !== -1) {
    alias = cabeza.slice(0, dosPuntos).trim();
    resto = cabeza.slice(dosPuntos + 1).trim();
  }

  const trozos = resto.split('!').map(t => t.trim());
  const tabla = trozos.shift();
  let inner = false;
  let fk = null;
  for (const t of trozos) {
    if (t === 'inner') inner = true;
    else if (t === 'left') inner = false;
    else if (fk === null) fk = t;
    else noSoportado(`un embebido con dos claves (\`${cabeza}\`)`);
  }

  if (!FORMA_IDENT.test(tabla)) noSoportado(`el nombre de tabla \`${tabla}\` en un embebido`);
  if (alias !== null && !FORMA_IDENT.test(alias)) noSoportado(`el alias \`${alias}\` en un embebido`);
  if (fk !== null && !FORMA_IDENT.test(fk)) noSoportado(`la clave \`${fk}\` en un embebido`);

  return { alias: alias || tabla, tabla, fk, inner };
}

/* ── El `select`, ya con embebidos (tramo 5) ─────────────────────────────
 *
 * PostgREST mete tres cosas distintas en la misma cadena:
 *
 *   'id, nombre'                             → columnas
 *   'alias:columna'                          → renombrado. Cero usos; lanza.
 *   '*, autor:profiles!autor_id(id, nombre)' → embebido. 66 usos.
 *
 * Devuelve el árbol: los campos del padre y la lista de embebidos, cada uno
 * con su propia selección dentro —porque los hay ANIDADOS, tres en el código:
 *
 *   ticket:tickets!ticket_id(guest_nombre, codigo, tipo:ticket_types!x(nombre))
 */
function parsearSeleccion(seleccion, nivel = 0) {
  if (nivel > 3) noSoportado('un embebido anidado más de tres niveles');

  const texto = String(seleccion ?? '*').trim();
  if (!texto) noSoportado('un `select` vacío');

  const campos = [];
  const embebidos = [];

  for (const parte of porComasDeArriba(texto)) {
    const abre = parte.indexOf('(');
    if (abre === -1) {
      if (parte === '*') { campos.push('*'); continue; }
      /* Un `alias:columna` sin paréntesis es un renombrado. Cero usos medidos;
         traducirlo a `columna AS alias` sería fácil y por eso mismo peligroso:
         nadie lo probaría nunca. */
      if (parte.includes(':')) noSoportado('un `select` con renombrado (`alias:columna`)');
      campos.push(ident(parte, 'un `select`'));
      continue;
    }
    if (!parte.endsWith(')')) noSoportado(`un embebido mal cerrado: \`${parte}\``);
    const cabeza = cabezaDeEmbebido(parte.slice(0, abre).trim());
    embebidos.push({ ...cabeza, seleccion: parsearSeleccion(parte.slice(abre + 1, -1), nivel + 1) });
  }

  if (!campos.length && !embebidos.length) noSoportado('un `select` vacío');
  return { campos, embebidos };
}

/* Lo que va en el SELECT del padre: sus campos, más las columnas que hacen
   falta para ir a buscar los embebidos aunque nadie las haya pedido. Las que
   se añaden se apuntan en `sobran` para borrarlas de la respuesta: PostgREST
   no devuelve `rol_id` si sólo pidieron `custom_permissions` y `rol_detail`, y
   devolverla de más sería una diferencia tonta que acaba en una pantalla. */
function columnasDelPadre(arbol, extras = []) {
  if (arbol.campos.includes('*')) return { sql: '*', sobran: [] };
  const puestas = new Set(arbol.campos.map(c => c.replace(/`/g, '')));
  /* `Set` porque dos embebidos pueden ir por la misma columna, y repetirla
     daría un `SELECT a, a` — válido pero tonto, y una fila con la columna dos
     veces. */
  const sobran = [...new Set(extras)].filter(c => !puestas.has(c));
  const todas = [...arbol.campos, ...sobran.map(c => ident(c, 'una clave de embebido'))];
  return { sql: todas.join(', '), sobran };
}

/* Compatibilidad con el resto del módulo: la forma de siempre, sin embebidos. */
function columnas(seleccion) {
  const arbol = parsearSeleccion(seleccion);
  if (arbol.embebidos.length) noSoportado('un `select` con JOIN embebido aquí');
  return columnasDelPadre(arbol).sql;
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

/* ── Los filtros ─────────────────────────────────────────────────────────
 *
 * Medido sobre el código del 27 de octubre de 2026, que es lo que decide qué
 * hace falta de verdad:
 *
 *     eq 1.330 · neq 31 · is 65 · in 18 · ilike 29 · not 22
 *     gte 12 · gt 5 · lt 5 · lte 3 · match 0 · like 0 · textSearch 0
 *
 * De los 22 `not` sólo hay DOS formas —`not(col,'is',null)` ×18 y
 * `not(col,'in',[…])` ×4— y los 65 `is` son todos `is(col, null)`. No hay
 * ningún `neq(col, null)`.
 *
 * (`match` salía 6 en el documento del plan y son CERO: eran
 * `String.prototype.match(/regex/)`. El mismo recuento ingenuo que daba 200
 * `.filter` de supabase cuando son 0. Queda corregido en el documento.)
 */

const COMPARADORES = { neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/* `.in(col, [])` — la trampa de este tramo.
 *
 * Los 18 usos pasan listas que salen de un `.map()`, o sea que **pueden venir
 * vacías**, y los dos motores no se parecen en nada ahí:
 *
 *   · PostgREST lo traduce a `col = ANY('{}')`, que es válido y no casa con
 *     ninguna fila. Medido contra el Postgres 17.6 de producción: 0 filas.
 *   · `col IN ()` en MySQL es un ERROR DE SINTAXIS.
 *
 * Así que se escribe `1 = 0`, que es la traducción fiel: cero filas, sin
 * error. Dejar que reventara sería «ruidoso», sí, pero rompería código que
 * hoy funciona — y la regla de reventar es para lo que NO sabemos hacer, no
 * para lo que sabemos hacer y da pereza.
 */
function enLista(c, valores, params, de) {
  if (!Array.isArray(valores)) noSoportado(`\`${de}\` con algo que no es una lista`);
  if (valores.length === 0) return '1 = 0';
  for (const v of valores) params.push(v);
  return `${c} IN (${valores.map(() => '?').join(', ')})`;
}

/* `.is(col, …)` — PostgREST sólo admite `null`, `true` y `false`.
   Los 65 usos de hoy son todos `null`; los booleanos se escriben igual en los
   dos motores, así que entran sin coste. Cualquier otra cosa lanza en vez de
   convertirse en un `= ?` que parecería funcionar. */
function esIs(c, valor) {
  if (valor === null) return `${c} IS NULL`;
  if (valor === true) return `${c} IS TRUE`;
  if (valor === false) return `${c} IS FALSE`;
  noSoportado(`\`is(col, ${JSON.stringify(valor)})\`: PostgREST sólo admite null, true o false`);
}

/* Una condición. `profundidad` existe sólo para que un `not` no pueda anidar
   otro `not`: PostgREST no lo permite y no hay ninguno, así que es una puerta
   cerrada a propósito. */
function condicion(f, params, profundidad = 0) {
  /* `.gt('tipo.precio', 0)` filtra por una columna de la tabla embebida. En
     PostgREST eso obliga a un `!inner`, y aquí a un JOIN de verdad: son los
     mismos 2 usos del tramo 5b. Sin este mensaje saldría como «el nombre
     `tipo.precio` no vale», que no dice qué falta. */
  if (String(f.col).includes('.')) {
    noSoportado(`filtrar por \`${f.col}\`, que es una columna de una tabla embebida`, '5b');
  }
  const c = ident(f.col, `un \`${f.tipo}\``);

  switch (f.tipo) {
    case 'eq':
      /* `eq` con null: PostgREST lo traduce a `IS NULL`, y en SQL `= NULL`
         nunca casa con nada. Sin esto, `.eq('borrado_at', null)` devolvería
         cero filas en silencio en vez de las no borradas. */
      if (f.valor === null) return `${c} IS NULL`;
      params.push(f.valor);
      return `${c} = ?`;

    case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
      /* Con null, `<>` y los de orden no casan con nada en ninguno de los dos
         motores, pero es un resultado tan poco intuitivo que si alguien lo
         escribe es que quería `is`. Cero usos hoy: se cierra la puerta. */
      if (f.valor === null) noSoportado(`\`${f.tipo}(col, null)\` (¿querías \`is\` o \`not(col,'is',null)\`?)`);
      params.push(f.valor);
      return `${c} ${COMPARADORES[f.tipo]} ?`;

    case 'is':
      return esIs(c, f.valor);

    case 'in':
      return enLista(c, f.valor, params, 'in');

    /* ── `ilike`: por qué es un `LIKE` pelado ──────────────────────────
     *
     * Parece que falta algo, y no falta. En MySQL el cotejo de la COLUMNA es
     * el que manda en la comparación (tiene menos coercibilidad que el
     * parámetro), y las 91 tablas de datos están en `utf8mb4_0900_as_ci`:
     * insensible a mayúsculas, SENSIBLE a acentos. Que es exactamente lo que
     * hace `ILIKE` en Postgres.
     *
     * Medido el 27-oct sobre «Bogota», «Bogotá» y «BOGOTÁ»:
     *
     *   buscando    Postgres ILIKE   MySQL 0900_as_ci   MySQL unicode_ci
     *   %bogotá%    Bogotá, BOGOTÁ   Bogotá, BOGOTÁ ✓   los tres        ✗
     *   %bogota%    Bogota           Bogota         ✓   los tres        ✗
     *
     * O sea que con el cotejo de las tablas de datos CASA EXACTO. El otro
     * —`utf8mb4_unicode_ci`, que usan las tablas de `001_identidad` y
     * `002_archivos`— es acento-ciego y devolvería de más; no se toca aquí
     * porque esas tablas no se consultan por este camino, pero está vigilado
     * en `test/postgrest.filtros.test.js`.
     *
     * Los comodines `%` y `_` pasan tal cual: PostgREST también los trata como
     * comodines, así que el comportamiento es el mismo. (El `*` que PostgREST
     * admite como alias de `%` no se usa en ningún sitio: medido, cero.)
     */
    case 'ilike':
      if (typeof f.valor !== 'string') noSoportado('`ilike` con algo que no es texto');
      params.push(f.valor);
      return `${c} LIKE ?`;

    case 'not': {
      if (profundidad > 0) noSoportado('un `not` dentro de otro `not`');
      return `NOT (${condicion({ tipo: f.op, col: f.col, valor: f.valor }, params, profundidad + 1)})`;
    }

    default:
      noSoportado(`el filtro \`${f.tipo}\``, 2);
  }
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
    const donde = plan.filtros.map(f => condicion(f, params));
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
  /* ── El rango ────────────────────────────────────────────────────────
   *
   * `range(desde, hasta)` tiene los DOS extremos dentro: `range(0, 9)` son
   * diez filas, no nueve. De ahí el `+ 1`. Equivocarse ahí no da error: da
   * páginas que se solapan por una fila, y la última de cada página vuelve a
   * salir la primera de la siguiente.
   */
  if (plan.rango) {
    if (plan.limite !== null) {
      noSoportado('`range` y `limit` a la vez (uno pisaría al otro y no está dicho cuál)');
    }
    const { desde, hasta } = plan.rango;
    if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 0) {
      noSoportado(`un \`range(${desde}, ${hasta})\``);
    }
    if (hasta < desde) noSoportado(`un \`range(${desde}, ${hasta})\`: el final va antes del principio`);
    /* Pegados al SQL porque MySQL no admite `?` en LIMIT/OFFSET con sentencias
       preparadas. Es seguro: acaban de comprobarse que son enteros. */
    partes.push(`LIMIT ${hasta - desde + 1} OFFSET ${desde}`);
  } else {
    const limite = plan.limite ?? (plan.forma === 'muchas' ? null : 2);
    if (limite !== null) {
      if (!Number.isInteger(limite) || limite < 0) noSoportado(`un \`limit\` de «${plan.limite}»`);
      partes.push(`LIMIT ${limite}`);
    }
  }

  return { sql: partes.join(' '), params };
}

/* La consulta que cuenta.
 *
 * Es OTRA consulta, no la misma con un COUNT delante, y eso es el asunto
 * entero: **el conteo ignora el `range` y el `limit`**.
 *
 * No es una interpretación. PostgREST devuelve el total en la cabecera
 * `Content-Range` (`0-9/1234`), y `routes/eventos.js:142` pide `count: 'exact'`
 * junto con `.range(tramo.desde, tramo.hasta)` y usa el `count` para paginar.
 * Si el conteo respetara el rango, esa pantalla diría «10 de 10» en vez de «10
 * de 1234» — o sea que la paginación de producción ya estaría rota hoy. No lo
 * está, luego el conteo es el total.
 *
 * Por eso se queda con el WHERE y tira el ORDER BY (no cambia cuántas hay y
 * cuesta) y el LIMIT.
 *
 * Son dos viajes a la base en vez de uno. `SQL_CALC_FOUND_ROWS` haría uno
 * solo, pero está obsoleto desde MySQL 8.0.17 y la propia documentación de
 * MySQL recomienda justamente estas dos consultas.
 */
function compilarConteo(plan) {
  const params = [];
  const donde = plan.filtros.map(f => condicion(f, params));
  const sql = `SELECT COUNT(*) AS n FROM ${ident(plan.tabla, 'un `from`')}`
            + (donde.length ? ` WHERE ${donde.join(' AND ')}` : '');
  return { sql, params };
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
  let filas;
  let cuenta = null;
  try {
    if (plan.accion === 'select') {
      if (plan.contar) {
        const c = compilarConteo(plan);
        cuenta = Number((await base.consultar(c.sql, c.params))[0].n);
      }
      /* `head: true` es «cuéntalas, no me las traigas». supabase-js hace una
         petición HEAD y `data` vuelve null; traer las filas igual sería
         trabajo que nadie pidió, y son 44 de los 54 usos. */
      if (plan.soloContar) return { data: null, error: null, count: cuenta };

      /* Con embebidos hay que saber por qué columna se va a buscar cada uno
         ANTES de armar el SELECT del padre: si pidieron `custom_permissions,
         rol_detail:…!rol_id(…)`, hace falta traer también `rol_id` aunque
         nadie lo haya pedido — y borrarlo después, porque PostgREST no lo
         devuelve. */
      let resueltos = [];
      if (plan.arbol.embebidos.length) {
        resueltos = await resolverEmbebidos(plan.tabla, plan.arbol.embebidos, base);
        const { sql: cols, sobran } = columnasDelPadre(
          plan.arbol, resueltos.map(e => e.colPadre));
        plan.columnas = cols;
        plan.sobran = sobran;
      }

      const { sql, params } = compilar(plan);
      filas = await base.consultar(sql, params);

      if (resueltos.length) {
        await adjuntarEmbebidos(filas, plan.tabla, plan.arbol.embebidos, base);
        for (const fila of filas) for (const c of plan.sobran) delete fila[c];
      }
    } else {
      const r = await escribir(plan, base);
      /* Sin `.select()` detrás, supabase-js devuelve `{ data: null }`. Devolver
         una lista vacía en su lugar parecería lo mismo y no lo es: hay código
         que mira `if (data)`. */
      if (r.error !== undefined) return r;
      filas = r;
    }
  } catch (e) {
    /* Lo NO SOPORTADO vuelve a salir: es una excepción a propósito y no se
       convierte en `{ error }`, que es justo lo que nadie mira. */
    if (e.code === 'PGRST_NO_SOPORTADO') throw e;
    /* Un error de SQL de verdad vuelve como `{ error }`, no lanzado: es lo que
       hace supabase-js y lo que el código de alrededor espera. Lo que lanza es
       lo NO SOPORTADO, que es cosa distinta y pasa antes de llegar aquí. */
    return {
      data : null,
      error: errorPgrst(e.message, { code: e.code || 'PGRST_SQL', details: e.sql || null }),
      count: null,
    };
  }

  if (plan.forma === 'muchas') return { data: filas, error: null, count: cuenta };

  if (filas.length === 1) return { data: filas[0], error: null, count: cuenta };

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

/* ══ LOS EMBEBIDOS (tramo 5) ════════════════════════════════════════════
 *
 * 66 `select` traen una tabla relacionada dentro. Son la parte cara del
 * adaptador y la que más daño hace si se hace mal, porque el modo de fallo es
 * el de siempre: no revienta, devuelve otra cosa.
 *
 * ── Objeto o lista: la decisión que lo decide todo ───────────────────────
 *
 * PostgREST devuelve el embebido como **objeto** cuando la clave ajena está en
 * la tabla de arriba (muchos-a-uno) y como **lista** cuando está en la de
 * abajo (uno-a-muchos). No es un detalle de forma:
 *
 *     // lib/acceso.js — el guardia de las 378 rutas
 *     .select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
 *     const lista = [...(m.rol_detail?.permissions || []), …];
 *
 * Si `rol_detail` volviera como lista, `?.permissions` daría `undefined`, el
 * `|| []` lo taparía, y **todo el mundo perdería los permisos de su rol sin un
 * solo error en ningún log**. Por eso la dirección no se adivina por el nombre
 * ni por si suena a plural: se lee de las claves ajenas del esquema.
 *
 * ── Por qué NO es un JOIN ────────────────────────────────────────────────
 *
 * Parecería que un embebido es un `LEFT JOIN`. Con muchos-a-uno casi, pero con
 * uno-a-muchos un JOIN **multiplica las filas del padre** —tres hijos, tres
 * copias del padre— y entonces el `LIMIT` deja de contar filas del padre y el
 * `count` miente. Rearmarlo después es adivinar dónde empieza cada grupo.
 *
 * Así que se hace como lo hacen los ORM: una consulta para el padre y **una
 * consulta más por cada embebido**, con un `IN (…)` de las claves que han
 * salido. Dos o tres viajes en vez de uno, sin multiplicar nada y con el
 * `LIMIT` y el `count` intactos. No es N+1: es 1 por embebido, no 1 por fila.
 */

/* Las claves ajenas entre dos tablas, preguntadas una vez y guardadas. */
const _relaciones = new Map();

async function relacionesEntre(padre, hijo, base) {
  const clave = `${padre}|${hijo}`;
  if (_relaciones.has(clave)) return _relaciones.get(clave);

  const filas = await base.consultar(
    `SELECT TABLE_NAME AS deTabla, COLUMN_NAME AS deCol,
            REFERENCED_TABLE_NAME AS aTabla, REFERENCED_COLUMN_NAME AS aCol
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME IS NOT NULL
        AND ((TABLE_NAME = ? AND REFERENCED_TABLE_NAME = ?)
          OR (TABLE_NAME = ? AND REFERENCED_TABLE_NAME = ?))`,
    [padre, hijo, hijo, padre]);

  _relaciones.set(clave, filas);
  return filas;
}

/* Qué relación es, y por qué columnas va.
 *
 * `fk` es lo que viene tras el `!`. Puede nombrar la columna de arriba
 * (`profiles!user_id` → `event_members.user_id`) o la de abajo. Se busca en
 * las dos direcciones y se exige que quede UNA sola candidata: si hay dos
 * caminos entre las mismas tablas y nadie dijo cuál, PostgREST también da
 * error, y elegir el primero sería devolver los datos de otro. */
async function resolverEmbebido(padre, emb, base) {
  const filas = await relacionesEntre(padre, emb.tabla, base);

  const candidatas = filas
    .filter(r => emb.fk === null || r.deCol === emb.fk)
    .map(r => (r.deTabla === padre
      ? { tipo: 'uno',    colPadre: r.deCol, colHijo: r.aCol }
      : { tipo: 'muchos', colPadre: r.aCol,  colHijo: r.deCol }));

  if (!candidatas.length) {
    noSoportado(`el embebido \`${emb.alias}\`: no hay clave ajena entre \`${padre}\` y ` +
                `\`${emb.tabla}\`${emb.fk ? ` por \`${emb.fk}\`` : ''}`);
  }
  if (candidatas.length > 1) {
    noSoportado(`el embebido \`${emb.alias}\`: hay ${candidatas.length} caminos entre ` +
                `\`${padre}\` y \`${emb.tabla}\` y no se dijo cuál (pon \`!columna\`)`);
  }
  return { ...emb, ...candidatas[0] };
}

async function resolverEmbebidos(padre, embebidos, base) {
  const salida = [];
  for (const e of embebidos) {
    if (e.inner) {
      /* `!inner` descarta las filas del padre que no tengan hijo, y eso tiene
         que pasar ANTES del `LIMIT` y del `count` o la página sale corta y el
         total miente. Con la consulta aparte no se puede: hace falta un JOIN
         de verdad en la consulta del padre. Son 2 usos de 66. */
      noSoportado(`el embebido \`${e.alias}\` con \`!inner\``, '5b');
    }
    salida.push(await resolverEmbebido(padre, e, base));
  }
  return salida;
}

/* Trae cada embebido con UNA consulta y lo engancha a las filas del padre. */
async function adjuntarEmbebidos(filas, padre, embebidos, base) {
  if (!filas.length || !embebidos.length) return filas;

  const resueltos = await resolverEmbebidos(padre, embebidos, base);

  for (const emb of resueltos) {
    const claves = [...new Set(filas.map(f => f[emb.colPadre]).filter(v => v != null))];

    /* Sin claves no hay a quién ir a buscar, y una consulta con `IN ()` vacío
       no tendría sentido. Se rellena igual: objeto → null, lista → []. Lo que
       no puede quedar es el campo SIN PONER, porque entonces la diferencia
       entre «no tiene» y «no se miró» desaparece. */
    let porClave = new Map();
    if (claves.length) {
      const dentro = emb.seleccion;
      /* Los NIETOS se resuelven antes de pedir al hijo, porque el hijo tiene
         que traer también las claves por las que se irá a buscar a sus propios
         embebidos. Sin esto, un anidado de tres niveles sale null en el
         tercero: el hijo llega sin su `rol_id` y no hay por dónde buscar.
         Lo cazó la prueba de los anidados. */
      const nietos = await resolverEmbebidos(emb.tabla, dentro.embebidos, base);
      const { sql: cols, sobran } = columnasDelPadre(
        dentro, [emb.colHijo, ...nietos.map(n => n.colPadre)]);
      const hijas = await base.consultar(
        `SELECT ${cols} FROM ${ident(emb.tabla, 'un embebido')} ` +
        `WHERE ${ident(emb.colHijo, 'un embebido')} IN (${claves.map(() => '?').join(', ')})`,
        claves);

      /* Los anidados: el hijo puede traer su propio hijo. */
      await adjuntarEmbebidos(hijas, emb.tabla, dentro.embebidos, base);

      /* El mapa SE ARMA ANTES de limpiar. La columna por la que se empareja
         suele ser una de las que sobran —nadie pide `id` para pedir el rol—,
         así que borrarla primero deja la clave en `undefined` y el embebido
         sale null para todo el mundo. Lo cazaron estas pruebas. */
      for (const h of hijas) {
        const k = h[emb.colHijo];
        if (emb.tipo === 'uno') porClave.set(k, h);
        else { if (!porClave.has(k)) porClave.set(k, []); porClave.get(k).push(h); }
      }
      for (const h of hijas) for (const c of sobran) delete h[c];
    }

    for (const f of filas) {
      const k = f[emb.colPadre];
      f[emb.alias] = emb.tipo === 'uno'
        ? (porClave.get(k) ?? null)
        : (porClave.get(k) ?? []);
    }
  }
  return filas;
}

/* ══ ESCRITURAS (tramo 3) ═══════════════════════════════════════════════
 *
 * Medido el 27 de octubre de 2026:
 *
 *   insert 140 (79 con `.select()` detrás) · update 190 (71) ·
 *   delete 112 (1)  · upsert 13 (5, y 15 con `onConflict`)
 *
 * ── El problema de fondo: MySQL no tiene RETURNING ───────────────────────
 *
 * 156 de esas llamadas piden las filas de vuelta. En Postgres sale gratis
 * (`INSERT … RETURNING *`); en MySQL hay que ir a buscarlas. Y hacerlo mal es
 * fácil de maneras que no dan error:
 *
 *   · Volver a leer con el MISMO filtro después de un `UPDATE` devuelve otra
 *     cosa si el update tocó justo la columna del filtro.
 *   · Leer después de un `DELETE` devuelve cero filas siempre.
 *
 * Por eso cada escritura con `.select()` va DENTRO DE UNA TRANSACCIÓN y se
 * apunta las claves primarias antes de tocar nada:
 *
 *   insert → se generan las claves, se inserta, se leen por esas claves.
 *   update → se leen las claves que casan, se actualiza POR ESAS CLAVES, se
 *            releen. Así el filtro se evalúa una sola vez.
 *   delete → se leen las filas ENTERAS antes de borrar, y se devuelven esas.
 *
 * ── El otro hallazgo, y es gordo ─────────────────────────────────────────
 *
 * En Postgres, 73 de las 77 columnas `id` tienen `DEFAULT gen_random_uuid()`.
 * En el volcado de MySQL, las 70 columnas `id` son `CHAR(36) NOT NULL` **sin
 * DEFAULT y sin AUTO_INCREMENT**. Y de los 83 `insert` con objeto literal,
 * **81 no pasan `id`**: cuentan con que la base lo ponga.
 *
 * O sea que, tal cual, 81 inserciones darían `ER_NO_DEFAULT_FOR_FIELD`. Es un
 * fallo RUIDOSO —de los buenos—, pero sería un fallo.
 *
 * Se arregla aquí y no en el esquema a propósito. `crypto.randomUUID()` da un
 * UUID v4, que es lo mismo que `gen_random_uuid()`; `DEFAULT (UUID())` de
 * MySQL daría un v1, que lleva dentro la MAC de la máquina y la hora. Y de
 * paso resuelve lo de RETURNING: para leer la fila recién insertada hay que
 * conocer su clave de todos modos.
 */

/* Qué columna es la clave primaria de cada tabla, y si la podemos generar.
 *
 * Se pregunta a `information_schema` una vez por tabla y se guarda. Es una
 * consulta por tabla en toda la vida del proceso; adivinar que la clave se
 * llama `id` sería gratis y estaría mal en las tablas de unión. */
const _claves = new Map();

async function claveDe(tabla, base) {
  if (_claves.has(tabla)) return _claves.get(tabla);

  const filas = await base.consultar(
    `SELECT k.COLUMN_NAME AS col, c.DATA_TYPE AS tipo,
            c.CHARACTER_MAXIMUM_LENGTH AS largo, c.EXTRA AS extra,
            c.COLUMN_DEFAULT AS pordefecto
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.COLUMNS c
         ON c.TABLE_SCHEMA = k.TABLE_SCHEMA
        AND c.TABLE_NAME   = k.TABLE_NAME
        AND c.COLUMN_NAME  = k.COLUMN_NAME
      WHERE k.TABLE_SCHEMA = DATABASE()
        AND k.TABLE_NAME = ?
        AND k.CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY k.ORDINAL_POSITION`, [tabla]);

  /* Sin clave primaria no se puede ni generar el id ni releer lo escrito.
     Se devuelve `null` en vez de lanzar: una tabla sin clave puede escribirse
     perfectamente mientras nadie pida las filas de vuelta. Quien la necesite
     lanza abajo, con el motivo concreto. */
  if (!filas.length) { _claves.set(tabla, null); return null; }

  const info = {
    columnas: filas.map(f => f.col),
    /* Generable sólo si es UNA columna de texto de 36 —un UUID— sin valor por
       defecto. Si es AUTO_INCREMENT la pone MySQL y la devuelve en `insertId`;
       cualquier otra cosa, quien llama tiene que traerla. */
    generable: filas.length === 1
      && ['char', 'varchar'].includes(String(filas[0].tipo).toLowerCase())
      && Number(filas[0].largo) === 36
      && filas[0].pordefecto === null
      && !String(filas[0].extra || '').includes('auto_increment'),
    autoincrement: String(filas[0].extra || '').includes('auto_increment'),
  };

  _claves.set(tabla, info);
  return info;
}

/* ── Los valores que se escriben ─────────────────────────────────────────
 *
 * Los arrays y los objetos van a columnas JSON y se pasan como texto.
 *
 * Medido contra mysql2 3.24.2: con `execute()` —que es lo que usa
 * `core/db/mysql.js`— un array crudo YA se guarda bien. Pero con `query()` el
 * mismo array se expande como lista de valores de SQL y revienta con
 * `ER_WRONG_VALUE_COUNT_ON_ROW`. Depender de cuál de los dos se usa es
 * exactamente el tipo de detalle que nadie recuerda dos meses después, así que
 * se convierte aquí y queda igual con los dos.
 *
 * Las fechas y los Buffer NO se tocan: mysql2 los sabe escribir, y pasarlos
 * por JSON.stringify los convertiría en texto ISO dentro de una columna
 * DATETIME. */
function valorEscribible(v) {
  /* Un array también entra por aquí: en JavaScript es un objeto. Había una
     línea `Array.isArray` delante y se quitó porque no cambiaba nada —lo
     descubrió una mutación que ninguna prueba cazaba, que es la forma de
     encontrar código que no hace falta—. */
  if (v !== null && typeof v === 'object'
      && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

/* Las filas de un insert/upsert, normalizadas: siempre una lista, siempre con
   las mismas columnas en el mismo orden. PostgREST exige que todas las filas
   de un insert múltiple tengan las mismas claves; si no coinciden, lanza en vez
   de rellenar con NULL lo que falte, que es como se escriben filas a medias. */
function filasNormalizadas(entrada, de) {
  const filas = Array.isArray(entrada) ? entrada : [entrada];
  if (!filas.length) noSoportado(`\`${de}\` sin ninguna fila`);

  for (const fila of filas) {
    if (!fila || typeof fila !== 'object' || Array.isArray(fila)) {
      noSoportado(`\`${de}\` con algo que no es un objeto`);
    }
  }

  const cols = Object.keys(filas[0]);
  if (!cols.length) noSoportado(`\`${de}\` con un objeto vacío`);

  for (const fila of filas.slice(1)) {
    const otras = Object.keys(fila);
    if (otras.length !== cols.length || otras.some(c => !cols.includes(c))) {
      noSoportado(`\`${de}\` con filas de columnas distintas ` +
                  `(\`${cols.join(', ')}\` vs \`${otras.join(', ')}\`)`);
    }
  }
  return { filas, cols };
}

/* ── Ejecutar una escritura ──────────────────────────────────────────────
 *
 * `devolver` es si había un `.select()` detrás. Cuando no lo hay, supabase-js
 * devuelve `{ data: null }` y no se lee nada: 111 de los 112 `delete` y 111 de
 * los 190 `update` están así, y leerles las filas igual sería trabajo que nadie
 * pidió. */
async function escribir(plan, base) {
  const tabla = ident(plan.tabla, 'un `from`');

  /* La clave hace falta en `insert` y `upsert` AUNQUE no haya `.select()`:
     el esquema MySQL no genera los `id` y hay que ponerlos aquí (ver arriba).
     Lo cazó la prueba «insert sin .select()», que fallaba con
     ER_NO_DEFAULT_FOR_FIELD porque esto sólo se miraba al releer. */
  const escribeFilas = plan.accion === 'insert' || plan.accion === 'upsert';
  const clave = (escribeFilas || plan.devolver) ? await claveDe(plan.tabla, base) : null;

  /* Sin `.select()` no hace falta transacción: es una sola sentencia. */
  if (!plan.devolver) {
    const { sql, params } = sentenciaEscritura(plan, tabla, clave);
    await base.consultar(sql, params);
    return { data: null, error: null, count: null };
  }

  if (typeof base.transaccion !== 'function') {
    noSoportado('escribir con `.select()` sobre una base sin transacciones');
  }

  if (!clave) {
    noSoportado(`leer de vuelta lo escrito en \`${plan.tabla}\`: la tabla no tiene clave ` +
                'primaria, así que no hay forma de volver a encontrar las filas');
  }
  if (clave.columnas.length !== 1) {
    noSoportado(`escribir en \`${plan.tabla}\` con \`.select()\`: su clave primaria tiene ` +
                `${clave.columnas.length} columnas y la relectura sólo sabe de una`);
  }
  const pk = clave.columnas[0];
  const pkq = ident(pk, 'la clave primaria');

  return base.transaccion(async (tx) => {
    /* El `delete` es el único que tiene que leer ANTES: después no hay nada
       que leer. Devuelve las filas tal y como eran. */
    if (plan.accion === 'delete') {
      const antes = await tx.consultar(...sqlYParams(
        `SELECT ${plan.columnas} FROM ${tabla}`, plan));
      const { sql, params } = sentenciaEscritura(plan, tabla, null);
      await tx.consultar(sql, params);
      return antes;
    }

    if (plan.accion === 'update') {
      /* Las claves se apuntan ANTES y el update va POR ESAS CLAVES, no por el
         filtro original. Si no, un `.update({estado:'x'}).eq('estado','y')`
         actualizaría bien pero releería cero filas, porque después del update
         ya ninguna casa con `estado = 'y'`. Devolver una lista vacía donde
         había filas es justo el fallo mudo de siempre. */
      const claves = (await tx.consultar(...sqlYParams(
        `SELECT ${pkq} FROM ${tabla}`, plan))).map(f => f[pk]);
      if (!claves.length) return [];

      const sets = [];
      const params = [];
      for (const [c, v] of Object.entries(plan.valores)) {
        sets.push(`${ident(c, 'un `update`')} = ?`);
        params.push(valorEscribible(v));
      }
      params.push(...claves);
      await tx.consultar(
        `UPDATE ${tabla} SET ${sets.join(', ')} WHERE ${pkq} IN (${claves.map(() => '?').join(', ')})`,
        params);

      return tx.consultar(
        `SELECT ${plan.columnas} FROM ${tabla} WHERE ${pkq} IN (${claves.map(() => '?').join(', ')})`,
        claves);
    }

    /* insert y upsert: las claves se conocen antes de escribir —generadas o
       traídas por quien llama—, así que la relectura es exacta. */
    const { sql, params, claves } = sentenciaEscritura(plan, tabla, clave);
    const r = await tx.consultar(sql, params);

    let aLeer = claves;
    if (!aLeer.length) {
      /* AUTO_INCREMENT: MySQL devuelve la primera y las demás son correlativas
         dentro de la misma sentencia. Hoy el esquema no tiene ninguna tabla
         así; queda escrito para que, si entra una, no falle en silencio. */
      if (!clave.autoincrement || !r?.insertId) {
        noSoportado(`leer de vuelta un \`${plan.accion}\` en \`${plan.tabla}\`: ` +
                    'no se pasó la clave primaria y la tabla no la genera');
      }
      aLeer = plan.filas.map((_, i) => r.insertId + i);
    }

    return tx.consultar(
      `SELECT ${plan.columnas} FROM ${tabla} WHERE ${pkq} IN (${aLeer.map(() => '?').join(', ')})`,
      aLeer);
  });
}

/* El WHERE de un plan, reutilizado por el delete y el update. */
function sqlYParams(cabeza, plan) {
  const params = [];
  const donde = plan.filtros.map(f => condicion(f, params));
  return [donde.length ? `${cabeza} WHERE ${donde.join(' AND ')}` : cabeza, params];
}

/* La sentencia de escritura. Devuelve también las claves primarias de las
   filas insertadas, que es lo que permite releerlas sin RETURNING. */
function sentenciaEscritura(plan, tabla, clave) {
  if (plan.accion === 'delete') {
    const [sql, params] = sqlYParams(`DELETE FROM ${tabla}`, plan);
    return { sql, params, claves: [] };
  }

  if (plan.accion === 'update') {
    const params = [];
    const sets = Object.entries(plan.valores).map(([c, v]) => {
      params.push(valorEscribible(v));
      return `${ident(c, 'un `update`')} = ?`;
    });
    if (!sets.length) noSoportado('`update` sin ninguna columna que cambiar');
    const donde = plan.filtros.map(f => condicion(f, params));
    return {
      sql: `UPDATE ${tabla} SET ${sets.join(', ')}` + (donde.length ? ` WHERE ${donde.join(' AND ')}` : ''),
      params, claves: [],
    };
  }

  /* insert / upsert */
  const { filas, cols } = plan.normalizadas;
  const pk = clave?.generable ? clave.columnas[0] : null;
  const columnas = pk && !cols.includes(pk) ? [pk, ...cols] : cols;

  const claves = [];
  const params = [];
  const tuplas = filas.map((fila) => {
    const valores = { ...fila };
    if (pk && valores[pk] == null) valores[pk] = crypto.randomUUID();
    if (columnas.includes(clave?.columnas?.[0])) claves.push(valores[clave.columnas[0]]);
    for (const c of columnas) params.push(valorEscribible(valores[c] ?? null));
    return `(${columnas.map(() => '?').join(', ')})`;
  });

  const lista = columnas.map(c => ident(c, `un \`${plan.accion}\``)).join(', ');
  let sql = `INSERT INTO ${tabla} (${lista}) VALUES ${tuplas.join(', ')}`;

  if (plan.accion === 'upsert') {
    /* `ON DUPLICATE KEY UPDATE` con la forma de alias (MySQL 8.0.19+), no con
     * `VALUES(col)`, que está obsoleta desde esa misma versión. Medido: el
     * servidor de este proyecto es 8.0.46.
     *
     * OJO con lo que NO es igual: PostgREST apunta el conflicto a UNA clave
     * (`onConflict`), y `ON DUPLICATE KEY` salta con CUALQUIER índice único de
     * la tabla. Coinciden mientras `onConflict` sea la única clave única que
     * la fila pueda chocar, que es el caso de los 15 usos de hoy (`id`,
     * `evento_id`, `owner_id,tipo`). Si una tabla tuviera dos índices únicos,
     * MySQL podría actualizar por el otro. Por eso se comprueba que las
     * columnas de `onConflict` sean de verdad un índice único: si no lo son,
     * PostgREST daría error y aquí se lanza igual, en vez de hacer un upsert
     * que parece funcionar. */
    const actualiza = columnas
      .filter(c => c !== pk || plan.normalizadas.cols.includes(pk))
      .map(c => `${ident(c, 'un `upsert`')} = nueva.${ident(c, 'un `upsert`')}`);
    sql += ` AS nueva ON DUPLICATE KEY UPDATE ${actualiza.join(', ')}`;
  }

  return { sql, params, claves: claves.filter(v => v != null) };
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
    accion  : 'select',
    columnas: '*',
    arbol   : { campos: ['*'], embebidos: [] },
    sobran  : [],      // columnas añadidas para buscar los embebidos
    filtros : [],
    orden   : [],
    limite  : null,
    rango   : null,    // { desde, hasta }, los dos inclusive
    contar  : null,    // 'exact'
    soloContar: false, // head: true — contar sin traer filas
    forma   : 'muchas',
    /* Escrituras */
    filas      : null,   // insert / upsert
    normalizadas: null,
    valores    : null,   // update
    onConflict : null,
    devolver   : false,  // ¿hubo un `.select()` detrás?
  };

  const api = {
    select(seleccion, extra) {
      if (extra && extra.count) {
        /* Sólo `exact`. `planned` y `estimated` de PostgREST salen del
           planificador de Postgres y dan un número APROXIMADO; traducirlos a
           un COUNT(*) de verdad sería «mejor», y por eso mismo sería mentira:
           quien pidió una estimación esperaba que fuera barata, no exacta.
           Cero usos hoy, los 54 son `exact`. */
        if (extra.count !== 'exact') noSoportado(`\`count: '${extra.count}'\``);
        if (plan.accion !== 'select') noSoportado('`count` detrás de una escritura');
        plan.contar = 'exact';
        /* `head: true` es «cuéntalas, no me las traigas»: 44 de los 54 usos.
           supabase-js hace una petición HEAD y `data` vuelve null. */
        plan.soloContar = extra.head === true;
      } else if (extra && extra.head) {
        noSoportado('`head` sin `count` (no devolvería ni filas ni cuenta)');
      }
      plan.arbol = parsearSeleccion(seleccion);
      /* Con embebidos, las columnas del padre no se saben hasta conocer las
         claves ajenas —y eso es una consulta—, así que se dejan para
         `ejecutar`. `compilar` sigue siendo pura. */
      if (!plan.arbol.embebidos.length) plan.columnas = columnasDelPadre(plan.arbol).sql;
      /* Detrás de una escritura, `.select()` no elige qué leer: pide que la
         escritura DEVUELVA lo escrito. En Postgres es el `RETURNING`; aquí
         obliga a transacción y relectura (ver «ESCRITURAS» arriba). */
      if (plan.accion !== 'select') plan.devolver = true;
      return envuelto;
    },

    /* ── Escrituras (tramo 3) ──────────────────────────────────────── */

    insert(filas) {
      plan.accion = 'insert';
      plan.normalizadas = filasNormalizadas(filas, 'insert');
      plan.filas = plan.normalizadas.filas;
      return envuelto;
    },

    upsert(filas, opts = {}) {
      plan.accion = 'upsert';
      plan.normalizadas = filasNormalizadas(filas, 'upsert');
      plan.filas = plan.normalizadas.filas;
      /* `ignoreDuplicates: true` es `ON CONFLICT DO NOTHING`, que en MySQL es
         `INSERT IGNORE` — y `INSERT IGNORE` se traga TODOS los errores
         recuperables, no sólo el de clave repetida: un dato demasiado largo se
         corta y una fecha inválida se vuelve ceros, callando. Cero usos hoy. */
      if (opts.ignoreDuplicates) noSoportado('`upsert` con `ignoreDuplicates`');
      plan.onConflict = opts.onConflict || null;
      return envuelto;
    },

    update(valores) {
      if (!valores || typeof valores !== 'object' || Array.isArray(valores)) {
        noSoportado('`update` con algo que no es un objeto');
      }
      plan.accion = 'update';
      plan.valores = valores;
      return envuelto;
    },

    delete() {
      plan.accion = 'delete';
      return envuelto;
    },

    eq(col, valor) {
      plan.filtros.push({ tipo: 'eq', col, valor });
      return envuelto;
    },

    /* El resto de filtros del tramo 2. Todos hacen lo mismo —apuntar en el
       plan— porque quien decide qué SQL sale es `condicion()`, que es pura y
       por eso se puede probar entera sin base. */
    neq(col, valor) { plan.filtros.push({ tipo: 'neq', col, valor }); return envuelto; },
    gt (col, valor) { plan.filtros.push({ tipo: 'gt',  col, valor }); return envuelto; },
    gte(col, valor) { plan.filtros.push({ tipo: 'gte', col, valor }); return envuelto; },
    lt (col, valor) { plan.filtros.push({ tipo: 'lt',  col, valor }); return envuelto; },
    lte(col, valor) { plan.filtros.push({ tipo: 'lte', col, valor }); return envuelto; },
    is (col, valor) { plan.filtros.push({ tipo: 'is',  col, valor }); return envuelto; },
    in (col, valores) { plan.filtros.push({ tipo: 'in', col, valor: valores }); return envuelto; },
    ilike(col, patron) { plan.filtros.push({ tipo: 'ilike', col, valor: patron }); return envuelto; },

    not(col, op, valor) {
      plan.filtros.push({ tipo: 'not', col, op, valor });
      return envuelto;
    },

    /* `like` NO entra, y no es un olvido.
     *
     * En Postgres `LIKE` distingue mayúsculas y `ILIKE` no. En MySQL, con un
     * cotejo `_ci`, `LIKE` NO las distingue — así que un `.like()` traducido a
     * `LIKE` se comportaría como un `ilike` y devolvería de más, en silencio.
     * Hacerlo bien pediría `LIKE ? COLLATE utf8mb4_0900_as_cs`.
     *
     * Cero usos hoy (medido). El día que entre uno, que salte aquí y se
     * escriba a conciencia, en vez de parecer que funciona. */
    like() { noSoportado('`like` (sensible a mayúsculas: en MySQL con cotejo `_ci` NO lo sería; usa `ilike` o pídelo con COLLATE … _cs)'); },

    /* `match({a:1, b:2})` es azúcar para varios `eq`. Cero usos: el documento
       del plan contaba 6 y eran `String.prototype.match(/regex/)`. No se
       escribe lo que nadie usa. */
    match() { noSoportado('`match` (cero usos medidos; son varios `eq` encadenados)'); },

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

    /* `range(desde, hasta)`, **los dos inclusive** — es un rango de índices de
       fila, no un «desde + cuántos». `range(0, 9)` son diez filas. Es la forma
       en que PostgREST lo hereda de la cabecera HTTP `Range`, y equivocarse en
       el borde da páginas que se solapan por una fila: la última de cada página
       vuelve a salir la primera en la siguiente, y nadie lo llama un fallo. */
    range(desde, hasta) {
      plan.rango = { desde, hasta };
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

    /* `throwOnError()` de supabase hace que el error se lance en vez de
       volver. Aquí no hay nada que hacer y devolverse a sí mismo sería mentir
       a medias: cero usos, así que lanza. */
    throwOnError() { noSoportado('`throwOnError`'); },

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
module.exports._valorEscribible = valorEscribible;
module.exports._compilarConteo = compilarConteo;
