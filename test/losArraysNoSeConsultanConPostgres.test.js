/* Las ocho columnas de array no se pueden consultar con operadores de Postgres.
 *
 * ── Qué se protege ───────────────────────────────────────────────────────
 *
 * Ocho columnas son `text[]` o `uuid[]` en Postgres y pasan a `JSON` en MySQL
 * (`db/migraciones/NOTAS-ESQUEMA.md`):
 *
 *     api_tokens.scopes          chat_channels.dm_users
 *     chat_channels.rol_ids      event_members.custom_permissions
 *     oauth_clients.redirect_uris  perfil_talento.habilidades
 *     ticket_types.zonas_acceso    webhooks.eventos
 *
 * Leerlas y escribirlas desde JavaScript no cambia —medido contra MySQL
 * 8.0.46: mysql2 parsea una columna JSON a un array de JS de verdad, así que
 * `.includes()`, el spread y `Array.isArray` siguen valiendo igual—. Lo que no
 * sobrevive es CONSULTARLAS con los operadores de array de Postgres:
 * `.contains()`, `.containedBy()` y `.overlaps()`, que PostgREST traduce a
 * `@>`, `<@` y `&&`.
 *
 * ── Por qué una prueba y no un comentario ────────────────────────────────
 *
 * Porque el modo de fallo es el peor de los de este proyecto: **no da error**.
 * Un `.contains()` contra MySQL no revienta — devuelve cero filas. O sea que
 * el día del corte los webhooks dejarían de salir, un canal de chat
 * restringido por rol se vería vacío, o un token parecería no tener permisos,
 * y nada en ningún log diría por qué.
 *
 * Había exactamente UNA en todo el código (`lib/webhooks.js`, el reparto de
 * webhooks) y ya no está: filtra en JavaScript, que vale para los dos motores.
 * Esto es para que no entre la segunda.
 *
 * ── Lo que esta prueba NO cubre ──────────────────────────────────────────
 *
 * La ESCRITURA. Con mysql2 hay que pasar `JSON.stringify(array)`; pasar el
 * array crudo revienta con `ER_PARSE_ERROR` — ruidoso, que es la forma buena
 * de fallar, y por eso no hace falta vigilarlo desde aquí. Hoy no hay ningún
 * camino que escriba estas columnas en MySQL; cuando lo haya, la regla está
 * escrita en NOTAS-ESQUEMA.
 *
 * Correr: npm test */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = (...p) => path.join(__dirname, '..', ...p);

/* Las ocho, por el nombre de la columna. */
const COLUMNAS = [
  'scopes', 'dm_users', 'rol_ids', 'custom_permissions',
  'redirect_uris', 'habilidades', 'zonas_acceso', 'eventos',
];

/* Los tres operadores de array de PostgREST, y las dos formas de escribirlos:
   el método (`.contains(`) y el código corto dentro de `.filter()` o `.or()`. */
const METODOS = /\.(contains|containedBy|overlaps)\s*\(\s*['"]([a-z_]+)['"]/g;
const CORTOS  = /['"]?([a-z_]+)['"]?\.(cs|cd|ov)\./g;

function archivos(dir) {
  const salida = [];
  for (const e of fs.readdirSync(raiz(dir), { withFileTypes: true })) {
    if (e.isDirectory()) salida.push(...archivos(path.join(dir, e.name)));
    else if (e.name.endsWith('.js')) salida.push(path.join(dir, e.name));
  }
  return salida;
}

const TODOS = () => ['lib', 'routes', 'modules', 'core', 'middleware'].flatMap(archivos);

/* Sin comentarios: este archivo y `lib/webhooks.js` CITAN `.contains()` al
   explicar por qué no se usa, y buscarlo en el texto entero lo encontraría
   dentro de su propia explicación. Es la trampa que `elLintExiste` documenta y
   que ya hizo fallar pruebas en este repo. */
const codigo = (f) => fs.readFileSync(raiz(f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('ninguna de las ocho columnas se consulta con un operador de array', () => {
  const hallazgos = [];

  for (const f of TODOS()) {
    const src = codigo(f);
    for (const m of src.matchAll(METODOS)) {
      if (COLUMNAS.includes(m[2])) hallazgos.push(`${f}: .${m[1]}('${m[2]}', …)`);
    }
    for (const m of src.matchAll(CORTOS)) {
      if (COLUMNAS.includes(m[1])) hallazgos.push(`${f}: ${m[1]}.${m[2]}.…`);
    }
  }

  assert.deepEqual(hallazgos, [],
    'Estas consultas usan operadores de array de Postgres sobre columnas que en MySQL ' +
    'son JSON. No fallan al migrar: devuelven CERO filas, en silencio.\n' +
    'Se arregla filtrando en JavaScript (la columna llega como array con los dos ' +
    'motores) o, si el volumen lo pidiera, con una costura que escriba ' +
    'JSON_CONTAINS / MEMBER OF para MySQL.\n' +
    hallazgos.map(h => `  · ${h}`).join('\n'));
});

test('el reparto de webhooks filtra en JavaScript', () => {
  /* Era la única que había. Si vuelve al operador, el día del corte los avisos
     dejan de salir sin que nada lo diga. */
  const src = codigo('lib/webhooks.js');
  assert.doesNotMatch(src, /\.contains\s*\(/,
    'volvió el operador de Postgres: contra MySQL devolvería cero webhooks, en silencio');
  assert.match(src, /\.filter\(w => \(w\.eventos \|\| \[\]\)\.includes\(tipo\)\)/,
    'el filtro en JavaScript es lo que hace que esto valga para los dos motores');
});

test('las ocho columnas siguen siendo las ocho', () => {
  /* Si el volcado cambia y aparece una novena, esta prueba se queda corta sin
     avisar. Se ata al documento que las enumera. */
  const notas = fs.readFileSync(raiz('db', 'migraciones', 'NOTAS-ESQUEMA.md'), 'utf8');
  const inicio = notas.indexOf('## Los ocho arreglos');
  assert.ok(inicio > 0, 'NOTAS-ESQUEMA ya no tiene el apartado «Los ocho arreglos»');

  /* Acotada al apartado, no hasta el final del archivo: más abajo hay otra
     tabla con la misma forma —la de los disparadores— y sin este corte se
     colaban sus once filas. Lo cazó esta misma prueba al escribirla. */
  const fin = notas.indexOf('\n## ', inicio + 1);
  const tabla = notas.slice(inicio, fin === -1 ? undefined : fin);
  const declaradas = [...tabla.matchAll(/^\| `[a-z_]+` \| `([a-z_]+)` \|/gm)].map(m => m[1]);

  assert.equal(declaradas.length, 8, 'NOTAS-ESQUEMA ya no lista ocho columnas de array');
  assert.deepEqual([...declaradas].sort(), [...COLUMNAS].sort(),
    'la lista de esta prueba y la de NOTAS-ESQUEMA se separaron');
});
