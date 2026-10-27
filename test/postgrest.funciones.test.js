'use strict';

/* Las funciones (`.rpc`) del adaptador — tramo 7.
 *
 * El backend llama 12 funciones de Postgres. En MySQL no hay ninguna: están
 * todas escritas en JavaScript, en sus módulos de dominio, y el adaptador es
 * sólo la centralita que dice cuál es cuál.
 *
 * ── La prueba que de verdad importa ──────────────────────────────────────
 *
 * La primera: recorre el código buscando `.rpc('…')` y comprueba que TODAS
 * están en la tabla. Si alguien añade una llamada nueva y se olvida de
 * implementarla, el adaptador lanzaría —bien— pero sólo el día que esa ruta se
 * usara, que puede ser el día del evento. Esto lo dice al escribirla.
 *
 * ── Lo que descubrió portarlas ───────────────────────────────────────────
 *
 * `generar_recordatorios_inapp` lleva rota desde que se escribió: inserta en
 * `notificaciones` una columna `link` que esa tabla no tiene, y
 * `recordatorio_inapp_log` ni siquiera existe (comprobado contra producción el
 * 27 de octubre de 2026). Nunca ha creado una fila. `modules/recordatorios` la
 * reescribió arreglada, así que al migrar esto EMPIEZA a funcionar. No es una
 * regresión, pero conviene saberlo antes de que aparezcan avisos que nadie
 * había visto nunca.
 *
 * Correr: MYSQL_PRUEBAS=1 npm test */

const BASE = 'gestek_pruebas_funciones';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';
/* Los módulos de dominio hablan con `bd('datos')`, que se configura por
   entorno. Se apunta a la base de pruebas ANTES de requerir nada. */
process.env.MYSQL_HOST     = process.env.MYSQL_PRUEBAS_HOST || '127.0.0.1';
process.env.MYSQL_USER     = process.env.MYSQL_PRUEBAS_USER || 'root';
process.env.MYSQL_PASSWORD = process.env.MYSQL_PRUEBAS_PASS || '';
process.env.MYSQL_DATABASE = BASE;
if (process.env.MYSQL_PRUEBAS_SOCKET) process.env.MYSQL_SOCKET = process.env.MYSQL_PRUEBAS_SOCKET;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pg = require('../core/db/postgrest.js');

const raiz = (...p) => path.join(__dirname, '..', ...p);

/* ══ Sin base ═══════════════════════════════════════════════════════════ */

test('TODAS las .rpc() del código están en la tabla', () => {
  /* El detector de deriva. Si entra una llamada nueva sin implementar, el
     adaptador lanzaría bien — pero sólo el día que esa ruta se usara. Esto lo
     dice al escribirla. */
  function archivos(dir) {
    const salida = [];
    for (const e of fs.readdirSync(raiz(dir), { withFileTypes: true })) {
      if (e.isDirectory()) salida.push(...archivos(path.join(dir, e.name)));
      else if (e.name.endsWith('.js')) salida.push(path.join(dir, e.name));
    }
    return salida;
  }

  const llamadas = new Set();
  for (const f of ['lib', 'routes', 'modules', 'core', 'middleware'].flatMap(archivos)) {
    const src = fs.readFileSync(raiz(f), 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*'([a-z_]+)'/g)) llamadas.add(m[1]);
  }

  assert.ok(llamadas.size >= 12, `sólo se encontraron ${llamadas.size} llamadas: ¿cambió la forma?`);

  const faltan = [...llamadas].filter(n => !(n in pg._FUNCIONES)).sort();
  assert.deepEqual(faltan, [],
    'Estas funciones se llaman desde el código y el adaptador no sabe hacerlas. ' +
    'Contra MySQL lanzarían, que es lo correcto — pero el día que esa ruta se use.\n' +
    faltan.map(n => `  · ${n}()`).join('\n'));
});

test('también están las dos sumas, que no se llaman con .rpc literal', () => {
  /* `lib/contadores.js` arma el nombre desde una tabla, así que el detector de
     arriba no las ve. Van igual para que el adaptador esté completo aunque esa
     costura desaparezca. */
  assert.ok('sumar_aforo_vendido' in pg._FUNCIONES);
  assert.ok('sumar_vendidos_tipo' in pg._FUNCIONES);
});

test('una función que no existe LANZA, no devuelve error', () => {
  /* Pedir una función que no está es un fallo de cableado, no un caso de
     negocio. Taparlo como `{ error }` lo dejaría pasando por una rama de «no
     se pudo» que nadie mira. */
  /* Síncrono, no una promesa rechazada: una promesa que nadie espera se
     pierde sin ruido, y esto tiene que saltar en la línea que lo escribió. */
  assert.throws(() => pg.rpc('no_existe', {}), (e) => e.code === 'PGRST_NO_SOPORTADO');
});

test('los minutos de una retención se recortan a entre 1 y 30', () => {
  /* Los topes del original (`greatest(1, least(p_minutos, 30))`). Sin el tope
     de arriba, cualquiera podría apartar una silla un año. */
  const m = require('../modules/espacios/index.js')._minutosValidos;
  assert.equal(m(10), 10);
  assert.equal(m(0), 1);
  assert.equal(m(-5), 1);
  assert.equal(m(999), 30);
  assert.equal(m(undefined), 10, 'sin decir nada, los diez del original');
  assert.equal(m('abc'), 10);
});

/* ══ Contra MySQL ═══════════════════════════════════════════════════════ */

const SALTAR = process.env.MYSQL_PRUEBAS !== '1';
let conexion, espacios, promociones, oauth, mysqlPool;

async function abrir() {
  const mysql = require('mysql2/promise');
  const cfg = {
    host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    socketPath: process.env.MYSQL_SOCKET || undefined,
    multipleStatements: true,
  };
  const raizCx = await mysql.createConnection(cfg);
  await raizCx.query(`DROP DATABASE IF EXISTS \`${BASE}\`;
    CREATE DATABASE \`${BASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;`);
  await raizCx.end();

  conexion = await mysql.createConnection({ ...cfg, database: BASE });

  /* El esquema copia lo que importa del volcado: la columna generada y el
     índice único que reproducen el índice parcial de Postgres. Sin eso, la
     prueba del espacio ocupado pasaría por el motivo equivocado. */
  await conexion.query(`
    CREATE TABLE espacios (
      id CHAR(36) NOT NULL PRIMARY KEY,
      evento_id CHAR(36) NOT NULL,
      modo VARCHAR(20) NOT NULL
    ) COLLATE=utf8mb4_0900_as_ci;

    CREATE TABLE espacio_reservas (
      id CHAR(36) NOT NULL PRIMARY KEY,
      espacio_id CHAR(36) NOT NULL,
      evento_id CHAR(36) NOT NULL,
      estado VARCHAR(255) NOT NULL,
      ticket_id CHAR(36) NULL,
      sesion_compra TEXT NULL,
      expira_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      espacio_activo CHAR(36) AS (IF(estado IN ('retenido','vendido'), espacio_id, NULL)) VIRTUAL,
      UNIQUE KEY espacio_reservas_una_viva (espacio_activo)
    ) COLLATE=utf8mb4_0900_as_ci;

    CREATE TABLE promociones (
      id CHAR(36) NOT NULL PRIMARY KEY,
      limite_usos INT NULL,
      usos INT NOT NULL DEFAULT 0
    ) COLLATE=utf8mb4_0900_as_ci;

    CREATE TABLE oauth_codes  (id CHAR(36) NOT NULL PRIMARY KEY, expira_at DATETIME(6) NOT NULL) COLLATE=utf8mb4_0900_as_ci;
    CREATE TABLE oauth_tokens (id CHAR(36) NOT NULL PRIMARY KEY, expira_at DATETIME(6) NOT NULL,
                               revocado TINYINT(1) NOT NULL DEFAULT 0) COLLATE=utf8mb4_0900_as_ci;

    INSERT INTO espacios VALUES ('esp-1','ev-1','vendible'), ('esp-2','ev-1','decorativo'), ('esp-3','ev-OTRO','vendible');
    INSERT INTO promociones (id, limite_usos, usos) VALUES ('pr-libre', NULL, 0), ('pr-ultimo', 3, 2), ('pr-lleno', 3, 3);
  `);

  espacios    = require('../modules/espacios/index.js');
  promociones = require('../modules/promociones/index.js');
  oauth       = require('../modules/oauth/index.js');
  mysqlPool   = require('../core/db/mysql.js');
}

test('las funciones contra MySQL de verdad', { skip: SALTAR && 'pon MYSQL_PRUEBAS=1' }, async (t) => {
  await abrir();
  t.after(async () => {
    await mysqlPool.cerrar();
    await conexion.query(`DROP DATABASE IF EXISTS \`${BASE}\``);
    await conexion.end();
  });

  /* ── Retener ──────────────────────────────────────────────────────── */

  await t.test('retener aparta el espacio y devuelve la reserva', async () => {
    const r = await espacios.retener('esp-1', 'ev-1', 'sesion-A', 10);
    assert.equal(r.espacio_id, 'esp-1');
    assert.equal(r.estado, 'retenido');
    assert.equal(r.sesion_compra, 'sesion-A');
    assert.match(r.id, /^[0-9a-f]{8}-/, 'el id se genera aquí: MySQL no lo pone');

    /* `expira_at` llega como TEXTO, no como Date: `core/db/mysql.js` usa
       `dateStrings: true` a propósito —con Date, mysql2 las crea en la zona
       del proceso y las horas de los eventos se desplazan al pasar por JSON—.
       La sesión va en UTC (`SET time_zone = '+00:00'`), así que se lee como
       UTC. Compararlo directamente con un Date daría una comparación de
       cadenas y pasaría o fallaría por el motivo equivocado. */
    const caduca = new Date(`${r.expira_at.replace(' ', 'T')}Z`);
    const dentroDe = (caduca - Date.now()) / 60000;
    assert.ok(dentroDe > 9 && dentroDe <= 10,
      `la retención caduca dentro de ${dentroDe.toFixed(1)} min, y se pidieron 10`);
  });

  await t.test('LA UNICIDAD: otra sesión no puede apartar el mismo espacio', async () => {
    /* La prueba que vale por todas. Quien decide no es JavaScript: es el
       índice único sobre la columna generada, igual que en Postgres decidía el
       índice parcial. Si esto fallara, se vendería dos veces la misma silla. */
    await assert.rejects(
      () => espacios.retener('esp-1', 'ev-1', 'sesion-B', 10),
      (e) => e.message === 'ESPACIO_OCUPADO');
  });

  await t.test('los tres errores de validación conservan su nombre', async () => {
    /* Las rutas los miran por el texto: cambiarlos rompería el mensaje que ve
       quien compra sin que ninguna prueba se enterara. */
    await assert.rejects(() => espacios.retener('no-existe', 'ev-1', 's', 10),
      (e) => e.message === 'ESPACIO_NO_EXISTE');
    await assert.rejects(() => espacios.retener('esp-2', 'ev-1', 's', 10),
      (e) => e.message === 'ESPACIO_NO_VENDIBLE');
    await assert.rejects(() => espacios.retener('esp-3', 'ev-1', 's', 10),
      (e) => e.message === 'ESPACIO_DE_OTRO_EVENTO');
  });

  /* ── Liberar ──────────────────────────────────────────────────────── */

  await t.test('liberar sólo suelta lo de SU sesión', async () => {
    /* Sin el `sesion_compra` en el WHERE, cualquiera que supiera el id del
       espacio podría soltar la reserva de otro y quitarle la silla. */
    assert.equal(await espacios.liberar('esp-1', 'sesion-AJENA'), false);
    assert.equal(await espacios.liberar('esp-1', 'sesion-A'), true);
    /* Y una vez libre, el espacio vuelve a poder apartarse. */
    const r = await espacios.retener('esp-1', 'ev-1', 'sesion-C', 10);
    assert.equal(r.estado, 'retenido');
  });

  /* ── Confirmar ────────────────────────────────────────────────────── */

  await t.test('confirmar ata la boleta y quita la caducidad', async () => {
    assert.equal(await espacios.confirmar('esp-1', 'sesion-C', 'tk-1'), true);
    const fila = await conexion.execute(
      'SELECT estado, ticket_id, expira_at FROM espacio_reservas WHERE espacio_id = ? AND estado = ?',
      ['esp-1', 'vendido']).then(([r]) => r[0]);
    assert.equal(fila.ticket_id, 'tk-1');
    assert.equal(fila.expira_at, null);
  });

  await t.test('no se puede confirmar una retención CADUCADA', async () => {
    /* El `expira_at > NOW()` es lo que impide cobrarle a alguien un espacio
       que ya se soltó y que puede haber cogido otro. Quitarlo no daría error:
       cobraría igual. */
    await conexion.execute(
      `INSERT INTO espacio_reservas (id, espacio_id, evento_id, estado, sesion_compra, expira_at)
       VALUES ('rv-vieja','esp-4','ev-1','retenido','sesion-D', NOW(6) - INTERVAL 1 MINUTE)`);
    assert.equal(await espacios.confirmar('esp-4', 'sesion-D', 'tk-2'), false);
  });

  await t.test('una retención caducada deja el espacio libre otra vez', async () => {
    /* El barrido va dentro de `retener`, no sólo en un cron: si el cron falla,
       las sillas se siguen liberando cuando alguien intenta tomarlas. */
    await conexion.execute('INSERT INTO espacios VALUES (?,?,?)', ['esp-5', 'ev-1', 'vendible']);
    await conexion.execute(
      `INSERT INTO espacio_reservas (id, espacio_id, evento_id, estado, sesion_compra, expira_at)
       VALUES ('rv-cad','esp-5','ev-1','retenido','sesion-E', NOW(6) - INTERVAL 1 MINUTE)`);
    const r = await espacios.retener('esp-5', 'ev-1', 'sesion-F', 10);
    assert.equal(r.sesion_compra, 'sesion-F');
  });

  /* ── Promociones ──────────────────────────────────────────────────── */

  await t.test('una promoción sin límite siempre se puede consumir', async () => {
    assert.equal(await promociones.consumir('pr-libre'), true);
    assert.equal(await promociones.consumir('pr-libre'), true);
  });

  await t.test('una promoción llena NO se consume, y no sube el contador', async () => {
    /* Es UNA sentencia a propósito: leer, comparar en JavaScript y luego
       escribir dejaría que dos personas usaran el último cupón a la vez. */
    assert.equal(await promociones.consumir('pr-ultimo'), true, 'quedaba uno');
    assert.equal(await promociones.consumir('pr-ultimo'), false, 'ya no quedaba');
    assert.equal(await promociones.consumir('pr-lleno'), false);

    const [filas] = await conexion.execute('SELECT usos FROM promociones WHERE id = ?', ['pr-lleno']);
    assert.equal(filas[0].usos, 3, 'una promoción llena no puede subir de usos');
  });

  await t.test('una promoción que no existe devuelve false, no revienta', async () => {
    assert.equal(await promociones.consumir('no-existe'), false);
  });

  /* ── OAuth ────────────────────────────────────────────────────────── */

  await t.test('barrer borra lo viejo y respeta lo vivo', async () => {
    await conexion.query(`
      INSERT INTO oauth_codes VALUES ('c-viejo', NOW(6) - INTERVAL 2 DAY), ('c-nuevo', NOW(6) + INTERVAL 1 HOUR);
      INSERT INTO oauth_tokens VALUES
        ('t-viejo-revocado', NOW(6) - INTERVAL 40 DAY, 1),
        ('t-viejo-vivo',     NOW(6) - INTERVAL 40 DAY, 0),
        ('t-nuevo-revocado', NOW(6) - INTERVAL 1 DAY,  1);`);

    const r = await oauth.barrer();
    assert.equal(r.codigos, 1);
    assert.equal(r.tokens, 1, 'sólo el caducado Y revocado');

    const [cod] = await conexion.execute('SELECT id FROM oauth_codes');
    assert.deepEqual(cod.map(f => f.id), ['c-nuevo']);
    const [tok] = await conexion.execute('SELECT id FROM oauth_tokens ORDER BY id');
    assert.deepEqual(tok.map(f => f.id), ['t-nuevo-revocado', 't-viejo-vivo'],
      'un token caducado pero NO revocado puede tener un refresco vivo colgando');
  });
});
