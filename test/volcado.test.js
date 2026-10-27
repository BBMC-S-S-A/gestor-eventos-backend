'use strict';

/* El volcado a `.sql`: la parte que se prueba sin Supabase y sin MySQL.
 *
 * `scripts/lib/volcado.js` no habla con nada — filas dentro, texto fuera —, y
 * eso es a propósito: lo que de verdad puede estar mal no es ninguna conexión.
 *
 * Son tres cosas, y las tres fallan en silencio:
 *
 *   · **El escapado.** Un apóstrofo parte la sentencia. Eso al menos se ve.
 *     Lo que no se ve es una barra invertida comiéndose el carácter
 *     siguiente, o un JSON con comillas dentro que entra medio truncado.
 *
 *   · **El orden dentro de una tabla.** Tres tablas se apuntan a sí mismas.
 *     Si una hija sale antes que su padre, el cargue muere con ERROR 1452 a
 *     mitad de archivo — con medio cargue hecho, que es lo peor de los dos
 *     mundos.
 *
 *   · **El troceo.** Un archivo cortado dentro de un INSERT no se puede subir,
 *     y además no lo parece: se ve como SQL normal hasta la última línea.
 *
 * Correr: npm test */

const test = require('node:test');
const assert = require('node:assert');

const { literal, sentenciaInsert, ordenarPorPadre, Troceador } = require('../scripts/lib/volcado.js');

/* ── El escapado ───────────────────────────────────────────────────────── */

test('un apóstrofo no parte la sentencia', () => {
  assert.equal(literal("O'Hara"), "'O\\'Hara'");
});

test('una barra invertida se escapa, que es el que no se ve', () => {
  /* `'C:\'` sin escapar deja la comilla de cierre comida por la barra, y lo
     que sigue —la coma, el paréntesis, la fila entera— pasa a ser parte del
     texto. La sentencia sigue pareciendo válida un buen rato. */
  assert.equal(literal('C:\\temp'), "'C:\\\\temp'");
});

test('null es NULL, no la cadena «null»', () => {
  /* La diferencia entre «no contestó» y «contestó la palabra null». En una
     columna de fecha la segunda ni siquiera entra; en una de texto entra y se
     queda para siempre. */
  assert.equal(literal(null), 'NULL');
  assert.equal(literal(undefined), 'NULL');
});

test('los objetos y los arrays van como JSON, escapados', () => {
  /* Las columnas JSON reciben texto. Si el objeto trae comillas dentro —y
     `page_json` las trae— el escapado tiene que seguir valiendo. */
  assert.equal(literal({ a: "con 'comilla'" }), "'{\\\"a\\\":\\\"con \\'comilla\\'\\\"}'");
  assert.equal(literal(['vip', 'general']), "'[\\\"vip\\\",\\\"general\\\"]'");
});

test('los booleanos no se entrecomillan', () => {
  /* En una columna TINYINT(1), `'false'` es una cadena no vacía y entra como
     1. O sea: lo apagado se vuelve encendido, en silencio. */
  assert.equal(literal(true), 'true');
  assert.equal(literal(false), 'false');
});

test('un número no se entrecomilla y no pierde precisión', () => {
  assert.equal(literal(0), '0');
  assert.equal(literal(-1), '-1');
  assert.equal(literal(12345.67), '12345.67');
});

/* ── El INSERT ─────────────────────────────────────────────────────────── */

test('varias filas van en una sola sentencia', () => {
  const sql = sentenciaInsert('t', ['id', 'n'], [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
  assert.equal(sql, 'INSERT INTO `t` (`id`, `n`) VALUES\n(\'a\', 1),\n(\'b\', 2);');
});

test('las columnas y la tabla van entrecomilladas', () => {
  /* Una columna que se llame como una palabra reservada —`order`, `key`,
     `status`— revienta sin esto, y sólo en la tabla que la tenga. */
  const sql = sentenciaInsert('order', ['key'], [{ key: 1 }]);
  assert.match(sql, /INSERT INTO `order` \(`key`\)/);
});

test('una columna que la fila no trae entra como NULL', () => {
  /* PostgREST no devuelve las columnas que no existen en esa fila. Sin esto
     serían `undefined`, que no es SQL válido. */
  const sql = sentenciaInsert('t', ['id', 'falta'], [{ id: 'a' }]);
  assert.equal(sql, 'INSERT INTO `t` (`id`, `falta`) VALUES\n(\'a\', NULL);');
});

test('sin filas no se escribe nada', () => {
  assert.equal(sentenciaInsert('t', ['id'], []), null);
});

/* ── El orden dentro de una tabla que se apunta a sí misma ─────────────── */

test('los padres salen antes que las hijas', () => {
  /* El caso de `espacios.parent_id`: una zona con sus stands dentro. */
  const filas = [{ id: 'hija', p: 'padre' }, { id: 'padre', p: null }];
  assert.deepEqual(ordenarPorPadre(filas, 'id', 'p').map(f => f.id), ['padre', 'hija']);
});

test('tres niveles también', () => {
  const filas = [{ id: 'nieta', p: 'hija' }, { id: 'hija', p: 'padre' }, { id: 'padre', p: null }];
  assert.deepEqual(ordenarPorPadre(filas, 'id', 'p').map(f => f.id), ['padre', 'hija', 'nieta']);
});

test('una fila cuyo padre no está en el lote NO se esconde', () => {
  /* Sale, y la clave ajena decide. Si el padre ya está en la base, entra bien;
     si no está, salta ERROR 1452 — que es justo lo que se quiere saber.
     Filtrarla aquí sería cargar datos rotos sin que nadie se entere. */
  const filas = [{ id: 'sola', p: 'un-padre-que-no-vino' }];
  assert.deepEqual(ordenarPorPadre(filas, 'id', 'p').map(f => f.id), ['sola']);
});

test('un ciclo no cuelga el proceso', () => {
  /* No debería existir, pero un bucle infinito en un script de carga es un
     proceso que se queda ahí sin decir nada. Se corta y salen las dos. */
  const filas = [{ id: 'a', p: 'b' }, { id: 'b', p: 'a' }];
  const r = ordenarPorPadre(filas, 'id', 'p');
  assert.equal(r.length, 2);
  assert.deepEqual(new Set(r.map(f => f.id)), new Set(['a', 'b']));
});

test('no se pierde ni se duplica ninguna fila', () => {
  /* Lo que de verdad importa de un reordenamiento: que sea una permutación.
     Una fila perdida aquí es una boleta que no existe en la base nueva. */
  const filas = [];
  for (let i = 0; i < 50; i++) filas.push({ id: `n${i}`, p: i > 0 ? `n${i - 1}` : null });
  const mezcladas = [...filas].reverse();
  const r = ordenarPorPadre(mezcladas, 'id', 'p');
  assert.equal(r.length, 50);
  assert.equal(new Set(r.map(f => f.id)).size, 50);
  assert.deepEqual(r.map(f => f.id), filas.map(f => f.id));
});

/* ── El troceo ─────────────────────────────────────────────────────────── */

test('corta entre sentencias, nunca dentro', () => {
  /* Un archivo que termina a mitad de un INSERT no se puede subir, y no lo
     parece: se lee como SQL normal hasta la última línea. */
  const trozos = [];
  const t = new Troceador({ limite: 30, escribir: (n, txt) => trozos.push(txt) });
  t.añadir('INSERT A;');
  t.añadir('INSERT B;');
  t.añadir('INSERT C;');
  t.añadir('INSERT D;');
  t.cerrar();
  assert.ok(trozos.length > 1, 'no troceó');
  for (const txt of trozos) {
    assert.equal((txt.match(/INSERT/g) || []).length, (txt.match(/;/g) || []).length,
      `un trozo quedó con un INSERT sin cerrar:\n${txt}`);
  }
  assert.equal(trozos.join('').match(/INSERT/g).length, 4, 'se perdió una sentencia');
});

test('una sentencia más grande que el límite sale entera igual', () => {
  /* Partirla sería escribir SQL roto. Más vale un trozo grande que un trozo
     inválido: el límite es una guía, no una promesa. */
  const trozos = [];
  const t = new Troceador({ limite: 10, escribir: (n, txt) => trozos.push(txt) });
  t.añadir('INSERT INTO larguisima VALUES (1);');
  t.cerrar();
  assert.equal(trozos.length, 1);
  assert.match(trozos[0], /INSERT INTO larguisima VALUES \(1\);/);
});

test('la cabecera se repite en TODOS los trozos', () => {
  /* Quien los sube no controla en qué orden los abre, y el segundo trozo sin
     la cabecera es un archivo que hace algo distinto del primero. */
  const trozos = [];
  const t = new Troceador({
    limite: 20, cabecera: () => '-- OJO\n', escribir: (n, txt) => trozos.push(txt) });
  t.añadir('INSERT A;'); t.añadir('INSERT B;'); t.añadir('INSERT C;');
  t.cerrar();
  assert.ok(trozos.length > 1);
  for (const txt of trozos) assert.match(txt, /^-- OJO\n/);
});

test('cerrar sin nada acumulado no escribe un archivo vacío', () => {
  /* Una tabla sin filas no debe dejar un `.sql` de cero bytes: quien lo sube
     se pregunta si falló algo. */
  const trozos = [];
  const t = new Troceador({ limite: 100, escribir: (n, txt) => trozos.push(txt) });
  t.cerrar();
  t.cerrar();
  assert.deepEqual(trozos, []);
});

test('los trozos se numeran desde 1 y en orden', () => {
  const vistos = [];
  const t = new Troceador({ limite: 12, escribir: (n) => vistos.push(n) });
  t.añadir('INSERT A;'); t.añadir('INSERT B;'); t.añadir('INSERT C;');
  t.cerrar();
  assert.deepEqual(vistos, [1, 2, 3]);
});
