'use strict';

/* Los embebidos del adaptador (tramo 5): traer una tabla relacionada dentro.
 *
 * Son 66 en el código y es la parte cara del adaptador — y la que más daño
 * hace si se hace mal, porque el modo de fallo es el de siempre: no revienta,
 * devuelve otra cosa.
 *
 * ── Lo que de verdad se protege aquí ─────────────────────────────────────
 *
 * PostgREST devuelve el embebido como OBJETO cuando la clave ajena está en la
 * tabla de arriba (muchos-a-uno) y como LISTA cuando está en la de abajo
 * (uno-a-muchos). No es un detalle de forma:
 *
 *     // lib/acceso.js — el guardia de las 378 rutas
 *     .select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
 *     const lista = [...(m.rol_detail?.permissions || []), …];
 *
 * Si `rol_detail` volviera como lista, `?.permissions` daría `undefined`, el
 * `|| []` lo taparía, y todo el mundo perdería los permisos de su rol **sin un
 * solo error en ningún log**. La primera prueba de la parte de MySQL es
 * exactamente ésa, con la misma consulta.
 *
 * Las pruebas del parser corren siempre; las de la base, con MYSQL_PRUEBAS=1.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');

const pg = require('../core/db/postgrest.js');

const arbol = (sel) => pg.from('t').select(sel)._plan().arbol;
const lanza = (fn, trozo) => assert.throws(fn, (e) => {
  assert.equal(e.code, 'PGRST_NO_SOPORTADO', `no lanzó lo del adaptador: ${e.message}`);
  assert.match(e.message, trozo);
  return true;
});

/* ══ El parser, sin base ════════════════════════════════════════════════ */

test('las cuatro formas que hay en el código se leen bien', () => {
  /* Medidas sobre los 66 usos: con alias y sin decir la clave; con alias y
     clave; sin alias; y con `!inner` encima. */
  assert.deepEqual(arbol('*, categoria:categorias(slug, nombre)').embebidos[0],
    { alias: 'categoria', tabla: 'categorias', fk: null, inner: false,
      seleccion: { campos: ['`slug`', '`nombre`'], embebidos: [] } });

  const conClave = arbol('*, autor:profiles!autor_id(nombre)').embebidos[0];
  assert.equal(conClave.fk, 'autor_id');

  /* Sin alias, PostgREST usa el nombre de la tabla como nombre del campo. */
  const sinAlias = arbol('titulo, speakers!speaker_id(nombre)').embebidos[0];
  assert.equal(sinAlias.alias, 'speakers');
  assert.equal(sinAlias.tabla, 'speakers');

  const conInner = arbol('user_id, profile:profiles!user_id!inner(ciudad)').embebidos[0];
  assert.equal(conInner.inner, true);
  assert.equal(conInner.fk, 'user_id');
});

test('las comas de dentro del paréntesis no parten los campos del padre', () => {
  /* Un `split(',')` a secas partiría `categorias(slug, nombre)` por la mitad y
     el error saldría tres pasos más allá, como un nombre de columna raro. */
  const a = arbol('id, titulo, categoria:categorias(slug, nombre), estado');
  assert.deepEqual(a.campos, ['`id`', '`titulo`', '`estado`']);
  assert.equal(a.embebidos.length, 1);
  assert.deepEqual(a.embebidos[0].seleccion.campos, ['`slug`', '`nombre`']);
});

test('los embebidos anidados se leen hasta el fondo', () => {
  /* Hay tres en el código, como éste de la puerta. */
  const a = arbol('id, ticket:tickets!ticket_id(codigo, tipo:ticket_types!ticket_type_id(nombre))');
  const t = a.embebidos[0];
  assert.equal(t.alias, 'ticket');
  assert.deepEqual(t.seleccion.campos, ['`codigo`']);
  assert.equal(t.seleccion.embebidos[0].alias, 'tipo');
  assert.deepEqual(t.seleccion.embebidos[0].seleccion.campos, ['`nombre`']);
});

test('el `*` del padre convive con los embebidos', () => {
  const a = arbol('*, categoria:categorias(slug)');
  assert.deepEqual(a.campos, ['*']);
  assert.equal(a.embebidos.length, 1);
});

test('un paréntesis descuadrado LANZA, y lo dice', () => {
  lanza(() => arbol('id, categoria:categorias(slug'), /descuadrados/);
});

test('un renombrado sin paréntesis LANZA', () => {
  /* `alias:columna` sin paréntesis. Cero usos; traducirlo a `columna AS alias`
     sería fácil y por eso mismo peligroso: nadie lo probaría nunca. */
  lanza(() => arbol('id, apodo:nombre'), /renombrado/);
});

test('los nombres raros LANZAN antes de llegar a la base', () => {
  lanza(() => arbol('id, x:tabla; DROP(a)'), /tabla; DROP/);
  lanza(() => arbol('id, mal alias:t(a)'), /mal alias/);
});

/* ══ Contra MySQL de verdad ═════════════════════════════════════════════ */

const SALTAR = process.env.MYSQL_PRUEBAS !== '1';
const BASE = 'gestek_pruebas_embebidos';
let conexion, db;

async function abrir() {
  const mysql = require('mysql2/promise');
  const cfg = {
    host: process.env.MYSQL_PRUEBAS_HOST || '127.0.0.1',
    user: process.env.MYSQL_PRUEBAS_USER || 'root',
    password: process.env.MYSQL_PRUEBAS_PASS || '',
    socketPath: process.env.MYSQL_PRUEBAS_SOCKET || undefined,
    multipleStatements: true,
  };
  const raiz = await mysql.createConnection(cfg);
  await raiz.query(`DROP DATABASE IF EXISTS \`${BASE}\`;
    CREATE DATABASE \`${BASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;`);
  await raiz.end();

  conexion = await mysql.createConnection({ ...cfg, database: BASE });

  /* El esquema imita el de verdad en lo que importa: las claves ajenas, que
     son de donde el adaptador saca si el embebido es objeto o lista. */
  await conexion.query(`
    CREATE TABLE event_roles (
      id   CHAR(36) NOT NULL PRIMARY KEY,
      nombre VARCHAR(50),
      permissions JSON
    ) COLLATE=utf8mb4_0900_as_ci;

    CREATE TABLE event_members (
      id        CHAR(36) NOT NULL PRIMARY KEY,
      evento_id CHAR(36),
      user_id   CHAR(36),
      status    VARCHAR(20),
      rol_id    CHAR(36) NULL,
      custom_permissions JSON,
      CONSTRAINT fk_miembro_rol FOREIGN KEY (rol_id) REFERENCES event_roles(id)
    ) COLLATE=utf8mb4_0900_as_ci;

    CREATE TABLE notas (
      id        CHAR(36) NOT NULL PRIMARY KEY,
      miembro_id CHAR(36),
      texto     VARCHAR(100),
      CONSTRAINT fk_nota_miembro FOREIGN KEY (miembro_id) REFERENCES event_members(id)
    ) COLLATE=utf8mb4_0900_as_ci;

    /* DOS claves ajenas a la misma tabla: quien la escribió y quien la firmó.
       Es el caso ambiguo, y existe en bases de verdad. Sirve para comprobar
       que el adaptador LANZA en vez de coger el primer camino que encuentra. */
    CREATE TABLE firmas (
      id         CHAR(36) NOT NULL PRIMARY KEY,
      texto      VARCHAR(100),
      autor_id   CHAR(36),
      revisor_id CHAR(36),
      CONSTRAINT fk_firma_autor   FOREIGN KEY (autor_id)   REFERENCES event_members(id),
      CONSTRAINT fk_firma_revisor FOREIGN KEY (revisor_id) REFERENCES event_members(id)
    ) COLLATE=utf8mb4_0900_as_ci;
  `);

  const q = (sql, p) => conexion.execute(sql, p);
  await q('INSERT INTO event_roles VALUES (?,?,?)', ['rol-1', 'Portero', JSON.stringify(['ver_puerta', 'marcar_ingreso'])]);
  await q('INSERT INTO event_roles VALUES (?,?,?)', ['rol-2', 'Caja', JSON.stringify(['cobrar'])]);
  await q('INSERT INTO event_members VALUES (?,?,?,?,?,?)',
    ['m-1', 'ev-1', 'u-1', 'active', 'rol-1', JSON.stringify(['exportar'])]);
  await q('INSERT INTO event_members VALUES (?,?,?,?,?,?)',
    ['m-2', 'ev-1', 'u-2', 'active', null, JSON.stringify([])]);
  await q('INSERT INTO notas VALUES (?,?,?)', ['n-1', 'm-1', 'primera']);
  await q('INSERT INTO notas VALUES (?,?,?)', ['n-2', 'm-1', 'segunda']);
  await q('INSERT INTO firmas VALUES (?,?,?,?)', ['f-1', 'acta', 'm-1', 'm-2']);

  const base = {
    consultar: async (sql, params = []) => (await conexion.execute(sql, params))[0],
    transaccion: async (fn) => fn({ consultar: base.consultar }),
  };
  db = pg.crear({ base });
}

test('embebidos contra MySQL de verdad', { skip: SALTAR && 'pon MYSQL_PRUEBAS=1' }, async (t) => {
  await abrir();
  t.after(async () => {
    await conexion.query(`DROP DATABASE IF EXISTS \`${BASE}\``);
    await conexion.end();
  });

  await t.test('EL GUARDIA: rol_detail vuelve como OBJETO, no como lista', async () => {
    /* La consulta exacta de `lib/acceso.js`, y la línea exacta que la usa. Si
       esto se rompiera, los 378 puntos de control del backend empezarían a ver
       a todo el mundo sin los permisos de su rol — sin un error en ningún log. */
    const { data: m, error } = await db.from('event_members')
      .select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
      .eq('evento_id', 'ev-1').eq('user_id', 'u-1').eq('status', 'active')
      .maybeSingle();

    assert.equal(error, null);
    assert.ok(m, 'no encontró al miembro');
    assert.ok(!Array.isArray(m.rol_detail),
      'rol_detail vino como LISTA: `?.permissions` daría undefined y se perderían los permisos del rol');
    assert.deepEqual(m.rol_detail.permissions, ['ver_puerta', 'marcar_ingreso']);

    const lista = [...(m.rol_detail?.permissions || []), ...(m.custom_permissions || [])];
    assert.deepEqual(lista, ['ver_puerta', 'marcar_ingreso', 'exportar']);
  });

  await t.test('la columna de la clave NO se cuela en la respuesta', async () => {
    /* Hay que traer `rol_id` para ir a buscar el rol, pero PostgREST no lo
       devuelve si no lo pidieron. Devolverlo de más es una diferencia tonta
       que acaba enseñándose en una pantalla o guardándose en un caché. */
    const { data: m } = await db.from('event_members')
      .select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
      .eq('id', 'm-1').maybeSingle();
    assert.deepEqual(Object.keys(m).sort(), ['custom_permissions', 'rol_detail']);
  });

  await t.test('sin clave ajena, el embebido es null — no falta', async () => {
    /* `m-2` no tiene rol. El campo tiene que estar y valer null: si faltara,
       «no tiene rol» y «no se miró» serían indistinguibles. */
    const { data: m } = await db.from('event_members')
      .select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
      .eq('id', 'm-2').maybeSingle();
    assert.ok('rol_detail' in m, 'el campo del embebido ni siquiera está');
    assert.equal(m.rol_detail, null);
  });

  await t.test('uno-a-muchos vuelve como LISTA, y vacía si no hay', async () => {
    /* La clave ajena está en `notas`, no en `event_members`: al revés que el
       rol. La dirección sale del esquema, no del nombre. */
    const { data } = await db.from('event_members')
      .select('id, notas(texto)').eq('evento_id', 'ev-1').order('id');

    const m1 = data.find(f => f.id === 'm-1');
    assert.ok(Array.isArray(m1.notas), 'uno-a-muchos tiene que ser una lista');
    assert.deepEqual(m1.notas.map(n => n.texto).sort(), ['primera', 'segunda']);

    const m2 = data.find(f => f.id === 'm-2');
    assert.deepEqual(m2.notas, [], 'sin hijos tiene que ser lista vacía, no null');
  });

  await t.test('una consulta por embebido, no una por fila', async () => {
    /* Lo que separa esto de un N+1. Con dos miembros y un embebido tienen que
       ser DOS consultas de datos (padre + hijo), no tres. */
    const vistas = [];
    const base = {
      consultar: async (sql, params = []) => { vistas.push(sql); return (await conexion.execute(sql, params))[0]; },
    };
    const espiado = pg.crear({ base });
    await espiado.from('event_members').select('id, notas(texto)').eq('evento_id', 'ev-1');

    const deDatos = vistas.filter(s => !s.includes('information_schema'));
    assert.equal(deDatos.length, 2, `fueron ${deDatos.length} consultas: ${deDatos.join(' | ')}`);
  });

  await t.test('los anidados se rellenan hasta el fondo', async () => {
    const { data } = await db.from('notas')
      .select('texto, miembro:event_members!miembro_id(user_id, rol:event_roles!rol_id(nombre))')
      .eq('id', 'n-1').maybeSingle();
    assert.equal(data.miembro.user_id, 'u-1');
    assert.equal(data.miembro.rol.nombre, 'Portero');
    assert.ok(!('rol_id' in data.miembro), 'la clave del nieto se coló en el hijo');
  });

  await t.test('un embebido sin clave ajena entre las tablas LANZA', async () => {
    await assert.rejects(
      async () => { await db.from('event_roles').select('id, notas(texto)'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO' && /no hay clave ajena/.test(e.message));
  });

  /* ── Tramo 5b: !inner y filtrar por columna embebida ───────────────── */

  await t.test('!inner descarta las filas del padre que no tienen hijo', async () => {
    /* `m-2` no tiene rol. Con el embebido normal salen los dos; con `!inner`
       sale uno. */
    const normal = await db.from('event_members')
      .select('id, rol:event_roles!rol_id(nombre)').eq('evento_id', 'ev-1');
    assert.equal(normal.data.length, 2);

    const unido = await db.from('event_members')
      .select('id, rol:event_roles!rol_id!inner(nombre)').eq('evento_id', 'ev-1');
    assert.equal(unido.error, null);
    assert.deepEqual(unido.data.map(f => f.id), ['m-1']);
    assert.equal(unido.data[0].rol.nombre, 'Portero');
  });

  await t.test('EL CONTEO también ve el !inner', async () => {
    /* Si el JOIN se quedara fuera del conteo, la página vendría recortada pero
       el total seguiría siendo el de la tabla entera: «1 de 2» cuando de
       verdad hay 1. Un número creíble y equivocado, que es el peor. */
    const { data, count } = await db.from('event_members')
      .select('id, rol:event_roles!rol_id!inner(nombre)', { count: 'exact' })
      .eq('evento_id', 'ev-1');
    assert.equal(data.length, 1);
    assert.equal(count, 1, 'el conteo ignoró el !inner y devolvió el total sin filtrar');
  });

  await t.test('filtrar por una columna de la tabla embebida', async () => {
    /* El caso de `routes/clientes.js`: `.gt('tipo.precio', 0)`. */
    const caja = await db.from('event_members')
      .select('id, rol:event_roles!rol_id!inner(nombre)').eq('rol.nombre', 'Caja');
    assert.equal(caja.error, null);
    assert.deepEqual(caja.data, [], 'nadie tiene el rol Caja');

    const portero = await db.from('event_members')
      .select('id, rol:event_roles!rol_id!inner(nombre)').eq('rol.nombre', 'Portero');
    assert.deepEqual(portero.data.map(f => f.id), ['m-1']);
  });

  await t.test('sin !inner, filtrar por columna embebida sigue LANZANDO', async () => {
    /* PostgREST también lo exige: sin el `!inner` no hay nada que filtrar. */
    await assert.rejects(
      async () => { await db.from('event_members').select('id, rol:event_roles!rol_id(nombre)').eq('rol.nombre', 'Caja'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO' && /!inner/.test(e.message));
  });

  await t.test('con JOIN, una columna que existe en las DOS tablas no se confunde', async () => {
    /* `event_members` y `event_roles` tienen las dos un `id`. Sin cualificar,
       MySQL diría `ER_NON_UNIQ_ERROR` —ruidoso, se arregla—; pero con una
       columna que sólo existiera en una de las dos la resolvería CALLANDO,
       filtrando por la tabla equivocada. Por eso se cualifica todo. */
    const { data, error } = await db.from('event_members')
      .select('id, rol:event_roles!rol_id!inner(id, nombre)')
      .eq('id', 'm-1').maybeSingle();
    assert.equal(error, null, `se confundió de tabla: ${error?.message}`);
    assert.equal(data.id, 'm-1', 'devolvió el id del ROL en vez del miembro');
    assert.equal(data.rol.id, 'rol-1');
  });

  await t.test('el * del padre con JOIN no se trae las columnas del hijo', async () => {
    /* `SELECT *` con JOIN traería las dos tablas pegadas, y las columnas que se
       llamen igual se machacarían: `id` sería el del rol. PostgREST devuelve
       sólo las del padre y el embebido aparte. */
    const { data } = await db.from('event_members')
      .select('*, rol:event_roles!rol_id!inner(nombre)').eq('id', 'm-1').maybeSingle();
    assert.equal(data.id, 'm-1');
    assert.equal(data.user_id, 'u-1');
    assert.ok(!('permissions' in data), 'se colaron columnas del rol en el padre');
    assert.equal(data.rol.nombre, 'Portero');
  });

  await t.test('la forma de routes/clientes.js: dos embebidos, uno inner, con conteo y rango', async () => {
    /* La consulta más difícil del repo, en pequeño: un embebido normal que NO
       debe descartar filas, otro con `!inner` que sí, un filtro sobre la tabla
       embebida, conteo exacto y rango. */
    const { data, count, error } = await db.from('event_members')
      .select('id, user_id, notas(texto), rol:event_roles!rol_id!inner(nombre)', { count: 'exact' })
      .eq('evento_id', 'ev-1').gt('rol.nombre', 'A')
      .order('id').range(0, 9);

    assert.equal(error, null);
    assert.equal(count, 1);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'm-1');
    assert.equal(data[0].rol.nombre, 'Portero');
    assert.deepEqual(data[0].notas.map(n => n.texto).sort(), ['primera', 'segunda']);
  });

  await t.test('un !inner hacia uno-a-muchos LANZA', async () => {
    /* Multiplicaría las filas del padre —tres notas, tres copias del miembro—
       y entonces el LIMIT dejaría de contar filas del padre y el conteo
       mentiría. PostgREST lo resuelve con un lateral; aquí haría falta un
       EXISTS, que es otra cosa y nadie la ha pedido. */
    await assert.rejects(
      async () => { await db.from('event_members').select('id, notas!inner(texto)'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO' && /multiplicar/.test(e.message));
  });

  await t.test('con DOS caminos a la misma tabla y sin decir cuál, LANZA', async () => {
    /* `firmas` apunta a `event_members` por `autor_id` y por `revisor_id`.
       Coger el primero que aparezca sería devolver los datos de otra persona:
       el revisor donde se pedía el autor. PostgREST también da error aquí. */
    await assert.rejects(
      async () => { await db.from('firmas').select('texto, miembro:event_members(user_id)'); },
      (e) => e.code === 'PGRST_NO_SOPORTADO' && /caminos/.test(e.message));
  });

  await t.test('diciendo cuál, cada camino trae a quien toca', async () => {
    const { data } = await db.from('firmas')
      .select('texto, autor:event_members!autor_id(user_id), revisor:event_members!revisor_id(user_id)')
      .eq('id', 'f-1').maybeSingle();
    assert.equal(data.autor.user_id, 'u-1');
    assert.equal(data.revisor.user_id, 'u-2');
  });

  await t.test('el embebido convive con el orden, el límite y el conteo', async () => {
    const { data, count } = await db.from('event_members')
      .select('id, rol_detail:event_roles!rol_id(nombre)', { count: 'exact' })
      .eq('evento_id', 'ev-1').order('id').range(0, 0);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'm-1');
    assert.equal(data[0].rol_detail.nombre, 'Portero');
    assert.equal(count, 2, 'el conteo tiene que seguir siendo el total');
  });
});
