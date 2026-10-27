'use strict';

/* El adaptador de PostgREST contra un MySQL de verdad.
 *
 * `postgrest.compila.test.js` fija el SQL que se genera. Esto comprueba que ese
 * SQL hace lo que se cree — que es otra cosa, y es la que no se puede deducir
 * leyendo el código.
 *
 * ── Por qué está detrás de una bandera ───────────────────────────────────
 *
 * El CI no tiene MySQL. Una prueba que lo necesite y no lo encuentre falla
 * todos los días, y una prueba que falla todos los días acaba borrada. Corre
 * sólo si se pide:
 *
 *     MYSQL_PRUEBAS=1 npm test
 *
 * Levanta su propia base (`gestek_pruebas_postgrest`), la llena, comprueba y la
 * borra. No toca ninguna base del proyecto.
 *
 * ── El orden de los NULL, medido contra los dos motores ──────────────────
 *
 * El 27 de octubre de 2026, con una tabla de tres filas —una con la fecha a
 * NULL— y ordenando por esa fecha:
 *
 *   |                        | ASC     | DESC    |
 *   |------------------------|---------|---------|
 *   | Postgres 17.6 (Supabase, producción) | `1,3,2` | `2,3,1` |
 *   | MySQL 8.0.46 a pelo    | `2,1,3` | `3,1,2` |
 *   | MySQL con el adaptador | `1,3,2` | `2,3,1` |
 *
 * O sea que a pelo sale distinto EN LOS DOS SENTIDOS, y sale ordenado: la lista
 * no viene vacía ni da error, viene con los sin-fecha donde no van. Eso no se
 * reporta como fallo, se reporta como «se ve raro», si es que se reporta.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const SALTAR = process.env.MYSQL_PRUEBAS !== '1';
const BASE = 'gestek_pruebas_postgrest';

let mysql2, conexion, pg;

/* La base de pruebas se habla directa con mysql2, sin pasar por `core/db`: lo
   que se prueba es el adaptador, no la configuración del proyecto, y atarlo a
   las variables MYSQL_* de alguien haría que fallara por el motivo equivocado. */
async function abrir() {
  mysql2 = require('mysql2/promise');
  const raiz = await mysql2.createConnection({
    host: process.env.MYSQL_PRUEBAS_HOST || '127.0.0.1',
    user: process.env.MYSQL_PRUEBAS_USER || 'root',
    password: process.env.MYSQL_PRUEBAS_PASS || '',
    socketPath: process.env.MYSQL_PRUEBAS_SOCKET || undefined,
    multipleStatements: true,
  });
  await raiz.query(`DROP DATABASE IF EXISTS \`${BASE}\`;
    CREATE DATABASE \`${BASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
  await raiz.end();

  conexion = await mysql2.createConnection({
    host: process.env.MYSQL_PRUEBAS_HOST || '127.0.0.1',
    user: process.env.MYSQL_PRUEBAS_USER || 'root',
    password: process.env.MYSQL_PRUEBAS_PASS || '',
    socketPath: process.env.MYSQL_PRUEBAS_SOCKET || undefined,
    database: BASE,
    multipleStatements: true,
  });

  await conexion.query(`
    CREATE TABLE eventos (
      id        VARCHAR(36) PRIMARY KEY,
      nombre    VARCHAR(120) NOT NULL,
      owner_id  VARCHAR(36),
      fecha     DATE NULL,
      aforo     INT NULL,
      zonas     JSON NULL,
      borrado_at DATETIME NULL
    ) COLLATE=utf8mb4_0900_as_ci;
  `);
    /* El cotejo de la tabla es el de las 91 tablas de datos, no el de la base:
       es el de la COLUMNA el que manda en una comparación, así que probar con
       otro mediría algo que no es lo que va a correr en producción. */
    for (const fila of [
      ['a', 'Primero',  'juan', '2026-01-01', 100,  null],
      ['b', 'Sin fecha','juan', null,         null, null],
      ['c', 'Tercero',  'juan', '2026-03-01', 50,   null],
      ['d', 'Borrado',  'ana',  '2026-02-01', 10,   '2026-02-02 10:00:00'],
      ['e', 'Bogota',   'ana',  '2026-04-01', 5,    null],
      ['f', 'Bogotá',   'ana',  '2026-05-01', 7,    null],
      ['g', 'BOGOTÁ',   'ana',  '2026-06-01', 9,    null],
    ]) await conexion.execute(
        'INSERT INTO eventos (id,nombre,owner_id,fecha,aforo,borrado_at) VALUES (?,?,?,?,?,?)', fila);

  /* El adaptador habla con `core/db`, así que se le pasa una base que cumple el
     mismo contrato (`consultar`) apuntando a la de pruebas. Es el seam: así no
     hace falta configurar MYSQL_* del proyecto para probar esto. */
  const base = {
    consultar: async (sql, params = []) => (await conexion.execute(sql, params))[0],
    /* Transacción de verdad, no una simulada: lo que el tramo 3 protege —leer
       antes de borrar, fijar las claves antes de actualizar— sólo vale si el
       COMMIT y el ROLLBACK son los de MySQL. */
    transaccion: async (fn) => {
      await conexion.beginTransaction();
      try {
        const r = await fn({ consultar: async (sql, params = []) => (await conexion.execute(sql, params))[0] });
        await conexion.commit();
        return r;
      } catch (e) { try { await conexion.rollback(); } catch { /* conexión muerta */ } throw e; }
    },
  };
  pg = require('../core/db/postgrest.js').crear({ base });
}

test('adaptador contra MySQL de verdad', { skip: SALTAR && 'pon MYSQL_PRUEBAS=1' }, async (t) => {
  await abrir();
  t.after(async () => {
    await conexion.query(`DROP DATABASE IF EXISTS \`${BASE}\``);
    await conexion.end();
  });

  await t.test('select con eq devuelve las filas y error null', async () => {
    const { data, error } = await pg.from('eventos').select('id, nombre').eq('owner_id', 'juan');
    assert.equal(error, null);
    assert.deepEqual(data.map(f => f.id).sort(), ['a', 'b', 'c']);
    /* Sólo las columnas pedidas: si viniera `fecha`, el `select` no estaría
       haciendo nada y nadie se enteraría hasta que una tabla ancha fuera lenta. */
    assert.deepEqual(Object.keys(data[0]).sort(), ['id', 'nombre']);
  });

  await t.test('eq con null trae las no borradas, no cero filas', async () => {
    const { data } = await pg.from('eventos').select('id').eq('borrado_at', null);
    assert.deepEqual(data.map(f => f.id).sort(), ['a', 'b', 'c', 'e', 'f', 'g']);
  });

  await t.test('ASC pone los NULL al final, como Postgres', async () => {
    const { data } = await pg.from('eventos').select('id').eq('owner_id', 'juan').order('fecha');
    assert.deepEqual(data.map(f => f.id), ['a', 'c', 'b'],
      'MySQL a pelo daría b,a,c — el NULL arriba. Medido contra Postgres: a,c,b.');
  });

  await t.test('DESC pone los NULL al principio, como Postgres', async () => {
    const { data } = await pg.from('eventos').select('id').eq('owner_id', 'juan')
      .order('fecha', { ascending: false });
    assert.deepEqual(data.map(f => f.id), ['b', 'c', 'a'],
      'MySQL a pelo daría c,a,b — el NULL abajo. Medido contra Postgres: b,c,a.');
  });

  await t.test('nullsFirst false con DESC deja los NULL al final', async () => {
    const { data } = await pg.from('eventos').select('id').eq('owner_id', 'juan')
      .order('fecha', { ascending: false, nullsFirst: false });
    assert.deepEqual(data.map(f => f.id), ['c', 'a', 'b']);
  });

  await t.test('limit corta', async () => {
    const { data } = await pg.from('eventos').select('id').order('id').limit(2);
    assert.equal(data.length, 2);
  });

  await t.test('single con una fila la devuelve', async () => {
    const { data, error } = await pg.from('eventos').select('nombre').eq('id', 'a').single();
    assert.equal(error, null);
    assert.equal(data.nombre, 'Primero');
  });

  await t.test('single con cero filas da PGRST116', async () => {
    const { data, error } = await pg.from('eventos').select('*').eq('id', 'noexiste').single();
    assert.equal(data, null);
    assert.equal(error.code, 'PGRST116');
  });

  await t.test('single con varias filas da PGRST116, no la primera', async () => {
    /* Es la comprobación que separa «hay una» de «hay varias y cojo cualquiera».
       Devolver la primera callando es como se acaba mostrando el dato de otro. */
    const { data, error } = await pg.from('eventos').select('*').eq('owner_id', 'juan').single();
    assert.equal(data, null);
    assert.equal(error.code, 'PGRST116');
  });

  await t.test('maybeSingle con cero filas da null SIN error', async () => {
    /* La diferencia entera entre los dos métodos, y hay 378 `maybeSingle` que
       dependen de ella: si esto devolviera error, 378 caminos que hoy tratan
       «no hay» como un caso normal empezarían a tratarlo como un fallo. */
    const { data, error } = await pg.from('eventos').select('*').eq('id', 'noexiste').maybeSingle();
    assert.equal(data, null);
    assert.equal(error, null);
  });

  await t.test('maybeSingle con varias SÍ da error', async () => {
    const { error } = await pg.from('eventos').select('*').eq('owner_id', 'juan').maybeSingle();
    assert.equal(error.code, 'PGRST116');
  });

  await t.test('un error de SQL vuelve como error, no lanzado', async () => {
    /* Es lo que hace supabase-js y lo que el código de alrededor espera. Lo que
       LANZA es lo no soportado, que es cosa distinta y salta antes de llegar
       a la base. */
    const { data, error } = await pg.from('tabla_que_no_existe').select('*');
    assert.equal(data, null);
    assert.ok(error, 'una tabla inexistente tiene que dar error, no lista vacía');
    assert.match(error.message, /tabla_que_no_existe/);
  });

  /* ── Tramo 2: el resto de filtros ──────────────────────────────────── */

  await t.test('in con valores, y la lista VACÍA sin reventar', async () => {
    /* `IN ()` es un error de sintaxis en MySQL, así que esto comprueba que el
       `1 = 0` sale de verdad y que MySQL lo traga. Es la diferencia entre
       «cero filas» y «la petición revienta» para los 18 usos que pasan una
       lista salida de un `.map()`. */
    const conValores = await pg.from('eventos').select('id').in('id', ['a', 'c']);
    assert.deepEqual(conValores.data.map(f => f.id).sort(), ['a', 'c']);

    const vacia = await pg.from('eventos').select('id').in('id', []);
    assert.equal(vacia.error, null, 'la lista vacía reventó en vez de dar cero filas');
    assert.deepEqual(vacia.data, []);
  });

  await t.test('not in con lista vacía deja pasar todas', async () => {
    const { data, error } = await pg.from('eventos').select('id').not('id', 'in', []);
    assert.equal(error, null);
    assert.equal(data.length, 7);
  });

  await t.test('is null y not is null se reparten las filas', async () => {
    const sinFecha = await pg.from('eventos').select('id').is('fecha', null);
    assert.deepEqual(sinFecha.data.map(f => f.id), ['b']);

    const conFecha = await pg.from('eventos').select('id').not('fecha', 'is', null);
    assert.equal(conFecha.data.length, 6);
  });

  await t.test('neq excluye también las filas con NULL, como Postgres', async () => {
    /* `col <> 'x'` con `col` a NULL da NULL, que no es verdadero: la fila no
       entra. Pasa igual en los dos motores, pero sorprende lo bastante como
       para dejarlo escrito: de 7 filas, una tiene el aforo a NULL y no sale
       ni en `= 100` ni en `<> 100`. */
    const { data } = await pg.from('eventos').select('id').neq('aforo', 100);
    assert.ok(!data.some(f => f.id === 'b'), 'la fila con aforo NULL no debe salir en un <>');
    assert.ok(!data.some(f => f.id === 'a'), 'la fila con aforo 100 tampoco');
    assert.equal(data.length, 5);
  });

  await t.test('los rangos', async () => {
    const { data } = await pg.from('eventos').select('id').gte('aforo', 9).lte('aforo', 100).order('aforo');
    assert.deepEqual(data.map(f => f.id), ['g', 'd', 'c', 'a']);
    /* El aforo de 'b' es NULL y no entra en ningún rango, ni por arriba ni por
       abajo. Pasa igual en los dos motores. */
    assert.ok(!data.some(f => f.id === 'b'));
  });

  await t.test('ilike casa como ILIKE de Postgres: ciego a mayúsculas, NO a acentos', async () => {
    /* La medida que justifica que `ilike` sea un `LIKE` pelado. Contra el
       Postgres 17.6 de producción, con estas mismas tres filas:
       '%bogotá%' → Bogotá, BOGOTÁ ;  '%bogota%' → Bogota. */
    const conTilde = await pg.from('eventos').select('nombre').ilike('nombre', '%bogotá%');
    assert.deepEqual(conTilde.data.map(f => f.nombre).sort(), ['BOGOTÁ', 'Bogotá'],
      'con el cotejo bueno, la tilde distingue pero la mayúscula no');

    const sinTilde = await pg.from('eventos').select('nombre').ilike('nombre', '%bogota%');
    assert.deepEqual(sinTilde.data.map(f => f.nombre), ['Bogota'],
      'si salieran las tres, el cotejo sería ciego a los acentos y la búsqueda devolvería de más');
  });

  await t.test('los comodines de ilike pasan tal cual', async () => {
    /* `%` y `_` son comodines en los dos motores, así que no se escapan. Un
       `_` casa un carácter cualquiera: «Bogota» y «Bogotá» pero no «BOGOTÁ»
       —esa sí, que el cotejo ignora mayúsculas—. */
    const { data } = await pg.from('eventos').select('nombre').ilike('nombre', 'Bogot_');
    assert.equal(data.length, 3);
  });

  await t.test('varios filtros se combinan de verdad contra la base', async () => {
    const { data } = await pg.from('eventos').select('id')
      .eq('owner_id', 'ana').is('borrado_at', null).gte('aforo', 7).order('id');
    assert.deepEqual(data.map(f => f.id), ['f', 'g']);
  });

  /* ── Tramo 3: las escrituras ───────────────────────────────────────── */

  await t.test('insert sin .select() devuelve data null, no una lista vacía', async () => {
    /* Es lo que hace supabase-js, y hay código que mira `if (data)`. Una lista
       vacía parecería lo mismo y no lo es. */
    const { data, error } = await pg.from('eventos').insert({ nombre: 'Nuevo', owner_id: 'juan' });
    assert.equal(error, null);
    assert.equal(data, null);
  });

  await t.test('insert GENERA la clave: el esquema MySQL no la pone', async () => {
    /* En Postgres las 73 columnas `id` tienen DEFAULT gen_random_uuid(); en el
       volcado de MySQL son CHAR(36) NOT NULL sin default. 81 de los 83 insert
       no pasan `id`. Sin esto, `ER_NO_DEFAULT_FOR_FIELD`. */
    const { data, error } = await pg.from('eventos')
      .insert({ nombre: 'Con clave', owner_id: 'juan' }).select('id, nombre').single();
    assert.equal(error, null);
    assert.match(data.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'tiene que ser un UUID v4, igual que gen_random_uuid() de Postgres');
    assert.equal(data.nombre, 'Con clave');
  });

  await t.test('insert con la clave puesta la respeta', async () => {
    const { data } = await pg.from('eventos')
      .insert({ id: 'mio-1', nombre: 'Mío', owner_id: 'juan' }).select('id').single();
    assert.equal(data.id, 'mio-1');
  });

  await t.test('insert de varias filas devuelve todas', async () => {
    const { data, error } = await pg.from('eventos').insert([
      { id: 'v1', nombre: 'Uno', owner_id: 'z' },
      { id: 'v2', nombre: 'Dos', owner_id: 'z' },
    ]).select('id');
    assert.equal(error, null);
    assert.deepEqual(data.map(f => f.id).sort(), ['v1', 'v2']);
  });

  await t.test('insert de filas con columnas distintas LANZA', async () => {
    /* PostgREST lo rechaza. Rellenar con NULL lo que falte es como se escriben
       filas a medias sin que nadie se entere. */
    await assert.rejects(
      async () => { await pg.from('eventos').insert([{ id: 'x1', nombre: 'A' }, { id: 'x2', aforo: 3 }]); },
      (e) => e.code === 'PGRST_NO_SOPORTADO');
  });

  await t.test('un array va a una columna JSON y vuelve como array', async () => {
    /* Medido: con `execute()` mysql2 3.24.2 ya lo guarda bien, pero con
       `query()` el mismo array revienta con ER_WRONG_VALUE_COUNT_ON_ROW. El
       adaptador lo convierte él para que dé igual cuál se use. */
    const { data, error } = await pg.from('eventos')
      .insert({ id: 'js-1', nombre: 'Con zonas', zonas: ['vip', 'general'] })
      .select('zonas').single();
    assert.equal(error, null);
    assert.ok(Array.isArray(data.zonas), 'tiene que volver como array de JavaScript');
    assert.deepEqual(data.zonas, ['vip', 'general']);
  });

  await t.test('update con .select() relee POR CLAVE, no por el filtro', async () => {
    /* El fallo que esto evita: actualizar la misma columna por la que se
       filtra. Releer con el filtro original daría CERO filas —ya ninguna casa—
       y el código de arriba creería que no se actualizó nada. */
    await pg.from('eventos').insert([
      { id: 'u1', nombre: 'A', owner_id: 'mover' },
      { id: 'u2', nombre: 'B', owner_id: 'mover' },
    ]);

    const { data, error } = await pg.from('eventos')
      .update({ owner_id: 'movido' }).eq('owner_id', 'mover').select('id, owner_id');

    assert.equal(error, null);
    assert.equal(data.length, 2, 'releyó con el filtro viejo y se quedó sin filas');
    assert.deepEqual(data.map(f => f.owner_id), ['movido', 'movido']);
  });

  await t.test('update que no casa con nada devuelve lista vacía, sin error', async () => {
    const { data, error } = await pg.from('eventos')
      .update({ nombre: 'X' }).eq('id', 'no-existe').select('id');
    assert.equal(error, null);
    assert.deepEqual(data, []);
  });

  await t.test('delete con .select() devuelve lo borrado, no una lista vacía', async () => {
    /* Después de un DELETE no queda nada que leer: hay que leerlo antes. */
    await pg.from('eventos').insert({ id: 'del-1', nombre: 'Se va', owner_id: 'q' });

    const { data, error } = await pg.from('eventos').delete().eq('id', 'del-1').select('id, nombre');
    assert.equal(error, null);
    assert.deepEqual(data, [{ id: 'del-1', nombre: 'Se va' }]);

    const queda = await pg.from('eventos').select('id').eq('id', 'del-1');
    assert.deepEqual(queda.data, [], 'tenía que haberse borrado de verdad');
  });

  await t.test('upsert inserta la primera vez y actualiza la segunda', async () => {
    const uno = await pg.from('eventos')
      .upsert({ id: 'up-1', nombre: 'Primera', owner_id: 'u' }, { onConflict: 'id' })
      .select('nombre').single();
    assert.equal(uno.data.nombre, 'Primera');

    const dos = await pg.from('eventos')
      .upsert({ id: 'up-1', nombre: 'Segunda', owner_id: 'u' }, { onConflict: 'id' })
      .select('nombre').single();
    assert.equal(dos.error, null);
    assert.equal(dos.data.nombre, 'Segunda', 'el upsert no actualizó: insertó otra fila o se quedó igual');

    const cuantas = await pg.from('eventos').select('id').eq('id', 'up-1');
    assert.equal(cuantas.data.length, 1);
  });

  await t.test('upsert con ignoreDuplicates LANZA', async () => {
    /* Sería `INSERT IGNORE`, que se traga TODOS los errores recuperables: un
       texto demasiado largo se corta y una fecha mala se vuelve ceros, en
       silencio. Cero usos hoy. */
    await assert.rejects(
      async () => { await pg.from('eventos').upsert({ id: 'q' }, { ignoreDuplicates: true }); },
      (e) => e.code === 'PGRST_NO_SOPORTADO');
  });

  await t.test('una escritura que falla deshace la transacción', async () => {
    /* El `nombre` es NOT NULL. La fila buena de la misma sentencia no puede
       quedarse dentro. */
    const antes = (await pg.from('eventos').select('id')).data.length;
    const { error } = await pg.from('eventos').insert([
      { id: 'tx-1', nombre: 'Buena' },
      { id: 'tx-2', nombre: null },
    ]).select('id');
    assert.ok(error, 'tenía que dar error');
    const despues = (await pg.from('eventos').select('id')).data.length;
    assert.equal(despues, antes, 'la fila buena se quedó dentro: no hubo rollback');
  });

  /* ── Tramo 4: contar y paginar ─────────────────────────────────────── */

  await t.test('el conteo NO respeta el range: devuelve el total', async () => {
    /* La prueba que justifica todo el tramo. `routes/eventos.js:142` pide
       `count` junto con `.range()` y pagina con ese número: si el conteo
       respetara el rango, la pantalla diría «2 de 2» en vez de «2 de 7» y
       sólo habría una página. No daría error — daría una lista a medias. */
    const { data, count, error } = await pg.from('eventos')
      .select('id', { count: 'exact' }).order('id').range(0, 1);

    assert.equal(error, null);
    assert.equal(data.length, 2, 'el range tiene que cortar a dos filas');
    assert.ok(count > 2, `el conteo devolvió ${count}: está respetando el range`);

    const todas = await pg.from('eventos').select('id');
    assert.equal(count, todas.data.length, 'el conteo tiene que ser el total de la tabla');
  });

  await t.test('el conteo SÍ respeta el filtro', async () => {
    const { data, count } = await pg.from('eventos')
      .select('id', { count: 'exact' }).eq('owner_id', 'juan').range(0, 0);
    assert.equal(data.length, 1);
    const juanes = await pg.from('eventos').select('id').eq('owner_id', 'juan');
    assert.equal(count, juanes.data.length);
  });

  await t.test('head: true cuenta sin traer filas', async () => {
    /* 44 de los 54 usos. `data` vuelve null, no una lista vacía: hay código
       que mira `if (data)`. */
    const { data, count, error } = await pg.from('eventos')
      .select('*', { count: 'exact', head: true }).eq('owner_id', 'juan');
    assert.equal(error, null);
    assert.equal(data, null, 'con head no se traen filas');
    assert.ok(count >= 1);
  });

  await t.test('range(0,9) y range(10,19) no comparten ninguna fila', () => {
    /* El borde inclusivo. Si `range` fuera exclusivo por arriba, la fila 9
       saldría en las dos páginas — y eso se ve como «este cliente aparece dos
       veces», no como un error. Se comprueba sobre el SQL porque la tabla de
       pruebas no tiene veinte filas. */
    const uno = pg.from('eventos').select('id').range(0, 9)._compilar().sql;
    const dos = pg.from('eventos').select('id').range(10, 19)._compilar().sql;
    assert.match(uno, /LIMIT 10 OFFSET 0$/);
    assert.match(dos, /LIMIT 10 OFFSET 10$/);
  });

  await t.test('range contra la base trae el trozo que toca', async () => {
    const todas = await pg.from('eventos').select('id').order('id');
    const trozo = await pg.from('eventos').select('id').order('id').range(1, 2);
    assert.deepEqual(trozo.data.map(f => f.id), todas.data.slice(1, 3).map(f => f.id));
  });

  await t.test('un count sin filas que contar devuelve 0, no null', async () => {
    const { data, count } = await pg.from('eventos')
      .select('id', { count: 'exact' }).eq('owner_id', 'nadie-con-este-nombre');
    assert.deepEqual(data, []);
    assert.equal(count, 0);
  });

  await t.test('un método no soportado LANZA aunque haya base detrás', async () => {
    await assert.rejects(
      async () => { await pg.from('eventos').select('*').or('a.eq.1,b.eq.2'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO');
  });
});
