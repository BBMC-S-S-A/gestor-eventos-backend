#!/usr/bin/env node
'use strict';

/* scripts/comparar-consultas.js — ¿el adaptador responde lo mismo que PostgREST?
 *
 * Tramo 8 de 8, y el último del adaptador (ver db/EL-RESTO-DE-LAS-RUTAS.md).
 *
 *   node scripts/comparar-consultas.js               # todo el catálogo
 *   node scripts/comparar-consultas.js embebidos     # sólo las que casen
 *   node scripts/comparar-consultas.js --detalle     # además, qué fila difiere
 *
 * Sale con código 1 si algo no cuadra, para poder usarlo como puerta en el
 * `CORTE.md` y no como un informe que alguien lee por encima.
 *
 * ── Qué compara esto que NO compara `comparar-bases.js` ──────────────────
 *
 * Aquél pregunta «¿llegaron los datos intactos?»: cuenta filas y hace una
 * huella por tabla. Es sobre la CARGA.
 *
 * Éste pregunta otra cosa: **dada la misma consulta, ¿responden lo mismo los
 * dos motores?** Es sobre el ADAPTADOR. Se pueden haber cargado los datos
 * perfectos y aun así una consulta devolver de más o de menos, porque un
 * filtro se tradujo mal o un embebido volvió como lista en vez de objeto.
 *
 * Los dos hacen falta, y en ese orden: primero que los datos estén, después
 * que las consultas los vean igual.
 *
 * ── SÓLO LEE. Y eso se comprueba, no se promete ──────────────────────────
 *
 * Correr un `insert` contra los dos motores dejaría basura en producción, y
 * un `update` o un `delete`, algo peor. Así que:
 *
 *   1. Cada consulta del catálogo se arma primero contra el adaptador y se le
 *      mira el plan. Si `accion` no es `select`, el script PARA — no la salta:
 *      para, porque una entrada de escritura en este catálogo es un error que
 *      hay que arreglar, no un caso a ignorar.
 *   2. De las funciones (`rpc`) sólo entran las que leen. Están nombradas una
 *      a una abajo; no hay lista de exclusión, hay lista de inclusión.
 *
 * `test/compararConsultas.test.js` comprueba esas dos cosas sin tocar ninguna
 * base, así que el CI las vigila en cada cambio.
 *
 * ── Lo que hace falta para correrlo ──────────────────────────────────────
 *
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY   el lado de Postgres, por PostgREST
 *   MYSQL_* (o MYSQL_DATOS_*)             el lado de MySQL
 *
 * Va por PostgREST y no por `PG_URL` a propósito: lo que se compara no es
 * Postgres contra MySQL, es **PostgREST contra el adaptador**. Las diferencias
 * que importan son las de la capa que traduce, no las del motor.
 *
 * ── Por qué el orden se fuerza ───────────────────────────────────────────
 *
 * Sin `ORDER BY`, ninguno de los dos motores promete un orden, así que
 * comparar fila a fila daría diferencias falsas en cuanto hubiera más de una.
 * Cada entrada del catálogo ordena; y, por si acaso, antes de comparar se
 * ordenan las dos listas por su contenido ya normalizado. Lo que sí se compara
 * EN ORDEN son las entradas marcadas `ordenado: true`, que existen justamente
 * para vigilar el orden de los NULL.
 */

const { normalizar, ordenarClaves } = require('./comparar-bases.js');

/* Los dos lados se cargan tarde, igual que en `comparar-bases.js`: así este
   archivo se puede requerir desde una prueba sin exigir ninguna variable. */
const lados = {
  get postgrest() { return require('../lib/supabase.js'); },
  get adaptador() { return require('../core/db/postgrest.js'); },
};

/* Las funciones que SÓLO LEEN. Lista de inclusión, no de exclusión: una
   función nueva no entra sola. `canjear_recompensa`, las dos sumas, las tres
   de espacio, `promocion_consumir` y `oauth_barrer` escriben, y
   `generar_recordatorios_inapp` también. */
const FUNCIONES_QUE_LEEN = [
  'aforo_zonas', 'aforo_zonas_resumen', 'aforo_zonas_serie', 'aforo_zonas_estancia',
  'find_pending_reminders',
];

/* ── El catálogo ─────────────────────────────────────────────────────────
 *
 * Cada entrada es una consulta REAL del código, recortada a lo que hace falta
 * para comparar. `correr(c)` recibe el cliente —el de verdad o el adaptador— y
 * devuelve el constructor sin esperar: quien espera es el comparador.
 *
 * Los ids van como parámetro (`--evento`) porque las consultas interesantes
 * son las de un evento con datos; sin él se usan las que no necesitan ninguno.
 */
function catalogo({ evento }) {
  const C = [];
  const add = (tramo, nombre, correr, opts = {}) => C.push({ tramo, nombre, correr, ...opts });

  /* Tramo 1 · lo básico */
  add(1, 'select de columnas + order + limit',
    c => c.from('eventos').select('id, titulo, estado').order('id').limit(20),
    { ordenado: true });

  add(1, 'maybeSingle que no encuentra nada',
    c => c.from('eventos').select('id').eq('id', '00000000-0000-4000-8000-000000000000').maybeSingle());

  /* Tramo 1 · EL ORDEN DE LOS NULL, que es donde los motores no coinciden */
  add(1, 'order ASC con NULL — los nulos al final',
    c => c.from('eventos').select('id, fecha_fin').order('fecha_fin').order('id').limit(40),
    { ordenado: true });

  add(1, 'order DESC con NULL — los nulos al principio',
    c => c.from('eventos').select('id, fecha_fin').order('fecha_fin', { ascending: false }).order('id').limit(40),
    { ordenado: true });

  add(1, 'order con nullsFirst explícito (routes/vacantes.js)',
    c => c.from('vacantes').select('id, destacada_hasta')
      .order('destacada_hasta', { ascending: false, nullsFirst: false }).order('id').limit(40),
    { ordenado: true });

  /* Tramo 2 · los filtros */
  add(2, 'is null / not is null',
    c => c.from('eventos').select('id').is('deleted_at', null).order('id').limit(40),
    { ordenado: true });

  add(2, 'neq — y las filas con NULL que deja fuera',
    c => c.from('tickets').select('id, estado').neq('estado', 'pagado').order('id').limit(40),
    { ordenado: true });

  add(2, 'ilike con acentos (el cotejo)',
    c => c.from('eventos').select('id, titulo').ilike('titulo', '%a%').order('id').limit(40),
    { ordenado: true });

  add(2, 'rango gte/lt',
    c => c.from('tickets').select('id, created_at')
      .gte('created_at', '2020-01-01').lt('created_at', '2100-01-01').order('id').limit(40),
    { ordenado: true });

  /* Tramo 4 · contar y paginar */
  add(4, 'count exact con head (sólo el número)',
    c => c.from('eventos').select('*', { count: 'exact', head: true }).is('deleted_at', null));

  add(4, 'count junto a range — el total NO lo recorta el rango',
    c => c.from('eventos').select('id', { count: 'exact' }).order('id').range(0, 4),
    { ordenado: true });

  /* Tramo 5 · los embebidos */
  add(5, 'EL GUARDIA — event_members con su rol (lib/acceso.js)',
    c => c.from('event_members')
      .select('user_id, custom_permissions, rol_detail:event_roles!rol_id(permissions)')
      .order('user_id').limit(40),
    { ordenado: true });

  add(5, 'embebido sin decir la clave',
    c => c.from('eventos').select('id, categoria:categorias(slug, nombre)').order('id').limit(40),
    { ordenado: true });

  add(5, 'embebido anidado (la puerta)',
    c => c.from('puerta_rechazos')
      .select('id, ticket:tickets!ticket_id(codigo, tipo:ticket_types!ticket_type_id(nombre))')
      .order('id').limit(20),
    { ordenado: true });

  /* Tramo 6 · la gramática del or */
  add(6, 'or de dos condiciones sueltas',
    c => c.from('tickets').select('id').or('estado.eq.pagado,estado.eq.emitido').order('id').limit(40),
    { ordenado: true });

  add(6, 'or anidado con and() — el cursor de clientes',
    c => c.from('tickets').select('id, created_at')
      .or('created_at.lt.2100-01-01,and(created_at.is.null,id.gt.0)').order('id').limit(40),
    { ordenado: true });

  add(6, 'or combinado con eq — EL PARÉNTESIS',
    c => c.from('eventos').select('id, estado').eq('estado', 'publicado')
      .or('titulo.ilike.%a%,titulo.ilike.%e%').order('id').limit(40),
    { ordenado: true });

  /* Las que piden un evento concreto */
  if (evento) {
    add(5, 'la lista de clientes SIN el inner (routes/clientes.js)',
      c => c.from('tickets')
        .select('id, codigo, estado, usuario:profiles!user_id(id, nombre, email), tipo:ticket_types!ticket_type_id(id, nombre, precio)')
        .eq('evento_id', evento).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 49),
      { ordenado: true });

    add('5b', 'la lista de clientes CON el inner y filtro embebido',
      c => c.from('tickets')
        .select('id, codigo, tipo:ticket_types!ticket_type_id!inner(id, nombre, precio)', { count: 'exact' })
        .eq('evento_id', evento).gt('tipo.precio', 0).order('id').range(0, 49),
      { ordenado: true });

    add(7, 'aforo_zonas', c => c.rpc('aforo_zonas', { p_evento: evento }), { rpc: 'aforo_zonas' });
    add(7, 'aforo_zonas_resumen', c => c.rpc('aforo_zonas_resumen', { p_evento: evento }), { rpc: 'aforo_zonas_resumen' });
    add(7, 'aforo_zonas_estancia', c => c.rpc('aforo_zonas_estancia', { p_evento: evento }), { rpc: 'aforo_zonas_estancia' });
    add(7, 'aforo_zonas_serie', c => c.rpc('aforo_zonas_serie', { p_evento: evento, p_minutos: 15 }), { rpc: 'aforo_zonas_serie' });
  }

  add(7, 'find_pending_reminders',
    c => c.rpc('find_pending_reminders', { p_limit: 50 }), { rpc: 'find_pending_reminders' });

  return C;
}

/* ── Normalizar una respuesta entera ─────────────────────────────────────
 *
 * `normalizar` de `comparar-bases.js` arregla un VALOR. Aquí hay que bajar por
 * los embebidos: un `rol_detail` es un objeto con sus propias columnas, y una
 * lista de hijos, una lista de objetos. Sin recorrerlos, dos respuestas que
 * difieren justo ahí saldrían iguales — y «justo ahí» es el guardia de los
 * permisos.
 */
function normalizarFila(fila) {
  if (fila === null || fila === undefined) return null;
  if (Array.isArray(fila)) return fila.map(normalizarFila);
  if (typeof fila !== 'object' || fila instanceof Date) return normalizar(fila);

  const salida = {};
  for (const k of Object.keys(fila).sort()) {
    const v = fila[k];
    salida[k] = (v !== null && typeof v === 'object' && !(v instanceof Date))
      ? normalizarFila(v)
      : normalizar(v);
  }
  return salida;
}

function normalizarRespuesta(r) {
  return {
    data : normalizarFila(r?.data ?? null),
    count: r?.count ?? null,
    /* El texto del error NO se compara: los dos motores lo redactan distinto y
       compararlo daría diferencias que no son de datos. Lo que sí importa es
       si HUBO error en un lado y en el otro no. */
    fallo: Boolean(r?.error),
  };
}

/* Para comparar sin que el orden mande, cuando la consulta no lo fija. */
const ordenadas = (filas) => (Array.isArray(filas)
  ? [...filas].map(f => JSON.stringify(ordenarClaves(f))).sort()
  : filas);

/* ── La comparación ──────────────────────────────────────────────────────*/

function comparar(a, b, { ordenado }) {
  if (a.fallo !== b.fallo) {
    return `uno de los dos dio error y el otro no (postgrest=${a.fallo}, adaptador=${b.fallo})`;
  }
  if (a.count !== b.count) return `el conteo difiere: postgrest=${a.count}, adaptador=${b.count}`;

  const izq = ordenado ? a.data : ordenadas(a.data);
  const der = ordenado ? b.data : ordenadas(b.data);

  const sa = JSON.stringify(izq);
  const sb = JSON.stringify(der);
  if (sa === sb) return null;

  if (Array.isArray(a.data) && Array.isArray(b.data) && a.data.length !== b.data.length) {
    return `vienen distintas filas: postgrest=${a.data.length}, adaptador=${b.data.length}`;
  }
  return 'el contenido difiere';
}

/* La primera fila que no coincide, para `--detalle`. */
function primeraDiferencia(a, b) {
  const A = Array.isArray(a.data) ? a.data : [a.data];
  const B = Array.isArray(b.data) ? b.data : [b.data];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = JSON.stringify(ordenarClaves(A[i] ?? null));
    const y = JSON.stringify(ordenarClaves(B[i] ?? null));
    if (x !== y) return { i, postgrest: x, adaptador: y };
  }
  return null;
}

/* ── La puerta de seguridad ──────────────────────────────────────────────*/

function esDeSoloLectura(entrada, adaptador) {
  if (entrada.rpc) {
    return FUNCIONES_QUE_LEEN.includes(entrada.rpc)
      ? null
      : `la función \`${entrada.rpc}()\` no está en la lista de las que sólo leen`;
  }
  const plan = entrada.correr(adaptador)._plan();
  return plan.accion === 'select'
    ? null
    : `la consulta es un \`${plan.accion}\`, y este script SÓLO LEE`;
}

/* ── main ────────────────────────────────────────────────────────────────*/

async function main() {
  const args = process.argv.slice(2);
  const detalle = args.includes('--detalle');
  const evento = (args.find(a => a.startsWith('--evento=')) || '').split('=')[1] || process.env.EVENTO_PRUEBA || null;
  const filtros = args.filter(a => !a.startsWith('--'));

  const todas = catalogo({ evento });
  const entradas = filtros.length
    ? todas.filter(e => filtros.some(f => `${e.tramo} ${e.nombre}`.toLowerCase().includes(f.toLowerCase())))
    : todas;

  if (!entradas.length) {
    console.error('Ninguna consulta casa con eso. Las hay de los tramos 1, 2, 4, 5, 5b, 6 y 7.');
    process.exit(2);
  }
  if (!evento) {
    console.log('· Sin `--evento=<uuid>`: se saltan las consultas que necesitan un evento con datos.\n');
  }

  const { postgrest, adaptador } = lados;

  /* La puerta, ANTES de tocar nada. */
  for (const e of entradas) {
    const pega = esDeSoloLectura(e, adaptador);
    if (pega) {
      console.error(`✗ «${e.nombre}»: ${pega}`);
      console.error('  Este script sólo lee. Arregla el catálogo; no lo saltes.');
      process.exit(2);
    }
  }

  let diferencias = 0;
  for (const e of entradas) {
    let a, b;
    try {
      a = normalizarRespuesta(await e.correr(postgrest));
      b = normalizarRespuesta(await e.correr(adaptador));
    } catch (err) {
      console.log(`✗ [${e.tramo}] ${e.nombre}\n    reventó: ${err.message.split('\n')[0]}`);
      diferencias++;
      continue;
    }

    const pega = comparar(a, b, { ordenado: Boolean(e.ordenado) });
    if (!pega) { console.log(`✓ [${e.tramo}] ${e.nombre}`); continue; }

    diferencias++;
    console.log(`✗ [${e.tramo}] ${e.nombre}\n    ${pega}`);
    if (detalle) {
      const d = primeraDiferencia(a, b);
      if (d) {
        console.log(`    fila ${d.i}:`);
        console.log(`      postgrest: ${d.postgrest}`);
        console.log(`      adaptador: ${d.adaptador}`);
      }
    }
  }

  console.log(`\n${entradas.length - diferencias}/${entradas.length} iguales.`);
  if (diferencias) {
    console.log('\nNO se corta con diferencias abiertas. Cada una es una consulta que el día');
    console.log('del evento devolvería otra cosa — y ninguna de ellas daría error.');
    process.exit(1);
  }
  console.log('El adaptador responde lo mismo que PostgREST en todo el catálogo.');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(2); })
    .finally(() => require('../core/db/mysql.js').cerrar().catch(() => {}));
}

module.exports = {
  catalogo, normalizarFila, normalizarRespuesta, comparar, ordenadas,
  esDeSoloLectura, primeraDiferencia, FUNCIONES_QUE_LEEN,
};
