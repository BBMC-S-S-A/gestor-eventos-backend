'use strict';

/* Copiar a MySQL el perfil de quien se registró después del corte.
 *
 * ── El fallo ─────────────────────────────────────────────────────────────
 *
 * Medido el 20 de noviembre de 2026, con un usuario real:
 *
 *     Cannot add or update a child row: a foreign key constraint fails
 *     (gestek_datos.eventos, CONSTRAINT eventos_owner_id_fkey ...)
 *
 * Con la identidad en Supabase y los datos en MySQL, quien se registra nace
 * sólo en Supabase: su `profiles` la crea un disparador de Postgres
 * (`on_auth_user_created`), no el backend. MySQL no se entera, y su primer
 * evento muere contra la clave ajena. Cuatro personas en unas horas.
 *
 * ── Qué se prueba, y por qué eso ─────────────────────────────────────────
 *
 * Esto corre en el camino de autenticación, por donde pasa TODA petición con
 * sesión. Lo que puede salir mal no es que no copie —eso se ve enseguida—
 * sino las tres formas de hacer daño al arreglarlo:
 *
 *   1. que pese, añadiendo un viaje a la base por petición;
 *   2. que pise datos, copiando encima de un perfil ya bueno;
 *   3. que tumbe el login si la copia falla.
 *
 * Las tres se prueban abajo. `sincronizar()` recibe sus dependencias por
 * parámetro justamente para poder hacerlo sin Supabase y sin MySQL.
 *
 * Correr: npm test */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { sincronizar, COLUMNAS, _yaEstan } = require('../modules/perfiles/sincronizar.js');

/* Una base de mentiras que cuenta lo que le piden. */
function baseFalsa({ tiene = false, alInsertar = null } = {}) {
  const consultas = [];
  return {
    consultas,
    consultar: async (sql, params) => {
      consultas.push({ sql, params });
      if (/^SELECT/i.test(sql.trim())) return tiene ? [{ n: 1 }] : [];
      if (alInsertar) throw alInsertar;
      return { affectedRows: 1 };
    },
  };
}

const PERFIL = {
  id: 'u-1', email: 'ana@ejemplo.com', nombre: 'Ana', handle: null,
  avatar_url: null, telefono: '+57 300', ciudad: 'Ibagué', empresa: 'ACME',
  ocupacion: 'Directora', rol: 'organizador', puntos: 0, nivel: 'bronze',
  empresa_logo_url: null, bio: null,
  created_at: '2026-11-20 20:09:51.979552', updated_at: '2026-11-20 20:10:25.581635',
};

test.beforeEach(() => _yaEstan.clear());

/* ── Que haga el trabajo ───────────────────────────────────────────────── */

test('copia el perfil cuando no está en MySQL', async () => {
  const base = baseFalsa({ tiene: false });
  const r = await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL });
  assert.equal(r, 'copiado');

  const insert = base.consultas.find(c => /INSERT/i.test(c.sql));
  assert.ok(insert, 'no insertó nada');
  assert.match(insert.sql, /INSERT IGNORE INTO `profiles`/);
  assert.ok(insert.params.includes('ana@ejemplo.com'));
  /* La fecha de registro se conserva: sin esto, todo el mundo parecería
     haberse registrado el día de la copia. */
  assert.ok(insert.params.includes('2026-11-20 20:09:51.979552'));
});

/* ── Regla 1 · que no pese ─────────────────────────────────────────────── */

test('al segundo intento del mismo usuario NO vuelve a consultar', async () => {
  /* El fallo que esto evita: una pantalla que se refresca sola añadiría un
     viaje a la base por cada petición, que es el gasto que la memoria de
     tokens del middleware existe para quitar. */
  const base = baseFalsa({ tiene: true });
  await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL });
  const tras = base.consultas.length;

  for (let i = 0; i < 20; i++) {
    const r = await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL });
    assert.equal(r, 'ya-estaba');
  }
  assert.equal(base.consultas.length, tras,
    'volvió a consultar a un usuario que ya había comprobado');
});

test('tampoco lee del origen a quien ya está', async () => {
  let leidas = 0;
  const base = baseFalsa({ tiene: true });
  await sincronizar('u-1', { base, leerDeOrigen: async () => { leidas++; return PERFIL; } });
  assert.equal(leidas, 0, 'fue a Supabase por alguien que ya estaba en MySQL');
});

/* ── Regla 2 · que no pise datos ───────────────────────────────────────── */

test('si el perfil ya está en MySQL no escribe NADA', async () => {
  /* La fila de MySQL es la buena: es donde la aplicación escribe desde el
     corte, así que la de Supabase está congelada y más vieja. Copiarla
     encima borraría lo que la persona cambió después. */
  const base = baseFalsa({ tiene: true });
  const r = await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL });
  assert.equal(r, 'ya-estaba');
  assert.equal(base.consultas.filter(c => /INSERT|UPDATE/i.test(c.sql)).length, 0,
    'escribió encima de un perfil que ya existía');
});

test('usa INSERT IGNORE, no ON DUPLICATE KEY UPDATE', async () => {
  /* Contra la carrera: dos pestañas de la misma persona pueden llegar a la
     vez, las dos ver que no está y las dos insertar. Lo que se quiere
     entonces es no hacer nada, no sobreescribir. */
  const fuente = fs.readFileSync('modules/perfiles/sincronizar.js', 'utf8');
  const codigo = fuente.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(codigo, /INSERT IGNORE/);
  assert.ok(!/ON DUPLICATE KEY UPDATE/i.test(codigo),
    'un UPDATE aquí pisaría el perfil bueno cuando dos peticiones compiten');
});

/* ── Regla 3 · que no tumbe el login ───────────────────────────────────── */

test('si MySQL falla, no lanza', async () => {
  const base = baseFalsa({ tiene: false, alInsertar: new Error('ER_LOCK_WAIT_TIMEOUT') });
  const r = await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL });
  assert.equal(r, 'fallo', 'debería informar del fallo, no lanzarlo');
});

test('si el origen falla, no lanza', async () => {
  const base = baseFalsa({ tiene: false });
  const r = await sincronizar('u-1', {
    base, leerDeOrigen: async () => { throw new Error('red caída'); } });
  assert.equal(r, 'fallo');
});

test('un fallo NO se recuerda: la siguiente petición lo reintenta', async () => {
  /* Si un fallo pasajero dejara al usuario marcado como comprobado, su perfil
     no se copiaría nunca más en lo que viva el proceso — y volvería el fallo
     original, ahora sin explicación. */
  let intentos = 0;
  const base = {
    consultar: async (sql) => {
      if (/^SELECT/i.test(sql.trim())) { intentos++; return []; }
      if (intentos === 1) throw new Error('se cayó');
      return { affectedRows: 1 };
    },
  };
  assert.equal(await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL }), 'fallo');
  assert.equal(await sincronizar('u-1', { base, leerDeOrigen: async () => PERFIL }), 'copiado');
  assert.equal(intentos, 2, 'no reintentó tras el fallo');
});

test('quien no tiene perfil ni en el origen no se inventa', async () => {
  /* Sin correo ni nombre, la fila que saldría sería peor que ninguna. Y
     tampoco se recuerda, para volver a mirar en la siguiente petición. */
  const base = baseFalsa({ tiene: false });
  const r = await sincronizar('u-1', { base, leerDeOrigen: async () => null });
  assert.equal(r, 'sin-origen');
  assert.equal(base.consultas.filter(c => /INSERT/i.test(c.sql)).length, 0);
  assert.ok(!_yaEstan.has('u-1'), 'lo recordó, y así no se volvería a intentar nunca');
});

/* ── Lo que se copia ───────────────────────────────────────────────────── */

test('no copia los secretos de pagos de la persona', async () => {
  /* `profiles` guarda las credenciales de Mercado Pago, Wompi y Google de
     cada organizador. Aquí no hacen falta: lo que tapa el hueco es que la
     fila exista. Traerlas sería mover secretos sin motivo. */
  for (const c of ['mp_access_token', 'wompi_private_key', 'google_refresh_token',
                   'wompi_events_secret', 'mp_public_key']) {
    assert.ok(!COLUMNAS.includes(c), `${c} no debería copiarse`);
  }
});

test('sólo pide las columnas que va a copiar, no `*`', async () => {
  /* Con `*`, el día que Supabase gane una columna que MySQL no tiene, el
     INSERT entero fallaría por una columna que a nadie le importaba. */
  const fuente = fs.readFileSync('modules/perfiles/index.js', 'utf8');
  assert.match(fuente, /select\(COLUMNAS\.join/);
});

test('se salta las columnas que el origen no trajo', async () => {
  const base = baseFalsa({ tiene: false });
  await sincronizar('u-1', { base, leerDeOrigen: async () => ({ id: 'u-1', email: 'a@b.c' }) });
  const insert = base.consultas.find(c => /INSERT/i.test(c.sql));
  assert.equal(insert.params.length, 2, 'mandó columnas que el perfil no traía');
});

/* ── El cableado ───────────────────────────────────────────────────────── */

test('el middleware no espera a que termine la copia', () => {
  /* Copiar un perfil no es parte de responder la petición. Un `await` aquí
     metería el viaje a Supabase y a MySQL en el tiempo de respuesta de todo
     el mundo, para arreglar algo de una sola persona. */
  const fuente = fs.readFileSync('middleware/auth.js', 'utf8');
  const bloque = fuente.slice(fuente.indexOf('function asegurarPerfil'),
                              fuente.indexOf('async function verifySupabaseJWT'));
  assert.ok(!/await/.test(bloque.replace(/\/\*[\s\S]*?\*\//g, '')),
    'el middleware espera a la copia, y eso retrasa todas las peticiones');
  assert.match(bloque, /try\s*{/, 'ni cargar el módulo puede tumbar una petición');
});

test('sólo se hace por el camino de Supabase', () => {
  /* Quien entra con token nuestro ya tiene su cuenta en MySQL por
     definición: llamar ahí sería un viaje a la base para nada. */
  const fuente = fs.readFileSync('middleware/auth.js', 'utf8');
  const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, '');
  const trozo = sinComentarios.slice(sinComentarios.indexOf('const nuestro = porNosotros'),
                                     sinComentarios.indexOf('const suyo = await porSupabase'));
  assert.ok(!/asegurarPerfil/.test(trozo),
    'se llama también para los tokens propios, que no lo necesitan');
});

test('no hace nada si las dos banderas están del mismo lado', () => {
  /* Sin convivencia no hay hueco: con `DATOS_PROPIOS` apagada el perfil ya
     está donde se lee, y con `AUTH_PROPIA` encendida la cuenta se crea en
     MySQL al registrarse. */
  const { haceFalta } = require('../modules/perfiles');
  assert.equal(typeof haceFalta, 'function');
  const fuente = fs.readFileSync('modules/perfiles/index.js', 'utf8');
  assert.match(fuente, /config\.DATOS_PROPIOS\)\s*&&\s*!config\.AUTH_PROPIA/);
});
