'use strict';

/* El secreto que firma las boletas.
 *
 * `lib/qr.js` tenía escrito en el código un valor por defecto
 * —`gestek_qr_change_me_in_production`— que se usaba cuando `QR_JWT_SECRET` no
 * estaba puesta. Con eso, un despliegue que olvidara la variable firmaba las
 * entradas con una cadena que está en el repositorio: cualquiera que lo leyera
 * podía fabricar boletas válidas para cualquier evento, y en la puerta no hay
 * forma de notarlo porque el escáner sólo comprueba la firma.
 *
 * `config/env.js` ya paraba el arranque si faltaba, pero sólo cuando
 * `NODE_ENV === 'production'` — y ése es exactamente el dato que se olvida en
 * un cPanel con Passenger.
 *
 * Estas pruebas son las que impiden que vuelva a haber un secreto por defecto.
 * Van en subprocesos porque el módulo decide si está en producción al
 * cargarse, y eso no se puede cambiar a media prueba.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

/* Corre `codigo` en un Node aparte con el entorno dado. Devuelve
   `{ ok, salida }` — `ok:false` si el proceso terminó con error. */
function enOtroProceso(codigo, env) {
  try {
    const salida = execFileSync(process.execPath, ['-e', codigo], {
      cwd: RAIZ,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: undefined, QR_JWT_SECRET: undefined, ...env },
    });
    return { ok: true, salida };
  } catch (e) {
    return { ok: false, salida: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const FIRMA = `const q = require('./lib/qr.js');
  process.stdout.write(JSON.stringify({
    revision: q.revisarSecreto(),
    token: (() => { try { return q.signTicketQR({ ticket_id: 't', evento_id: 'e', codigo: 'C' }); }
                    catch (e) { return 'LANZO: ' + e.message; } })(),
  }));`;

function firmarCon(env) {
  const r = enOtroProceso(FIRMA, env);
  return { ...r, datos: r.ok ? JSON.parse(r.salida) : null };
}

test('en producción NO se firma sin un secreto de verdad', () => {
  const { datos } = firmarCon({ NODE_ENV: 'production' });
  assert.equal(datos.revision.ok, false);
  assert.match(datos.revision.motivo, /QR_JWT_SECRET no está configurada/);
  assert.match(datos.token, /^LANZO:/, 'firmó una boleta sin secreto configurado');
});

test('en producción el valor de ejemplo no cuenta como secreto', () => {
  /* Los cuatro marcadores de posición que andan por el repositorio: el que
     estaba escrito en lib/qr.js, el de config/env.js y los dos .env.example. */
  for (const ejemplo of [
    'gestek_qr_change_me_in_production',
    'DEV_ONLY_QR_SECRET_NOT_FOR_PRODUCTION',
    'cambia_esto_por_un_secreto_seguro_minimo_32_chars',
    'cambia-esto-por-un-secreto-largo',
  ]) {
    const { datos } = firmarCon({ NODE_ENV: 'production', QR_JWT_SECRET: ejemplo });
    assert.equal(datos.revision.ok, false, `aceptó el valor de ejemplo «${ejemplo}»`);
    assert.match(datos.revision.motivo, /valor de ejemplo/);
    assert.match(datos.token, /^LANZO:/);
  }
});

test('en producción un secreto corto tampoco vale', () => {
  const { datos } = firmarCon({ NODE_ENV: 'production', QR_JWT_SECRET: 'demasiado-corto' });
  assert.equal(datos.revision.ok, false);
  assert.match(datos.revision.motivo, /15 caracteres y hacen falta 32/);
});

test('en producción, con un secreto propio, firma y verifica', () => {
  const bueno = 'K'.repeat(40);
  const r = enOtroProceso(`const q = require('./lib/qr.js');
    const t = q.signTicketQR({ ticket_id: 't1', evento_id: 'e1', codigo: 'ABC12345' });
    process.stdout.write(JSON.stringify({ ok: q.revisarSecreto().ok, verifica: q.verifyTicketQR(t) }));`,
  { NODE_ENV: 'production', QR_JWT_SECRET: bueno });
  const datos = JSON.parse(r.salida);
  assert.equal(datos.ok, true);
  assert.equal(datos.verifica.ok, true);
  assert.equal(datos.verifica.ticket_id, 't1');
});

/* En desarrollo se sigue pudiendo trabajar sin configurar nada — pero con un
   secreto distinto en cada proceso, no con uno escrito en el repositorio. */
test('fuera de producción se firma con un secreto aleatorio, distinto en cada proceso', () => {
  const uno = firmarCon({});
  const otro = firmarCon({});
  assert.equal(uno.datos.revision.ok, true);
  assert.ok(!uno.datos.token.startsWith('LANZO:'), 'en desarrollo tiene que poder firmar');
  assert.notEqual(uno.datos.token, otro.datos.token,
    'dos procesos firmaron igual: el secreto de desarrollo no es aleatorio');
});

test('un token firmado con el secreto viejo del código ya no vale', () => {
  /* El escenario real: alguien que sacó el secreto del repositorio y se fabricó
     una entrada. Ahora no la valida ni en desarrollo ni en producción. */
  const falsa = require('jsonwebtoken').sign(
    { tid: 't1', eid: 'e1', c: 'ABC12345', v: 1 },
    'gestek_qr_change_me_in_production',
    { algorithm: 'HS256' },
  );

  const r = enOtroProceso(`const q = require('./lib/qr.js');
    process.stdout.write(JSON.stringify(q.verifyTicketQR(${JSON.stringify(falsa)})));`,
  { QR_JWT_SECRET: 'U'.repeat(40) });
  assert.equal(JSON.parse(r.salida).ok, false, 'la boleta falsificada pasó el control');
});

test('config/env.js corta el arranque en producción si el secreto no sirve', () => {
  const arranque = 'require(\'./config/env.js\'); process.stdout.write(\'ARRANCO\');';

  const malo = enOtroProceso(arranque, {
    NODE_ENV: 'production',
    QR_JWT_SECRET: 'gestek_qr_change_me_in_production',
    SUPABASE_URL: 'https://ejemplo.supabase.co',
    SUPABASE_SERVICE_KEY: 'clave',
  });
  assert.equal(malo.ok, false, 'el servidor arrancó con un secreto que no sirve');
  assert.match(malo.salida, /FATAL/);

  const bueno = enOtroProceso(arranque, {
    NODE_ENV: 'production',
    QR_JWT_SECRET: 'Z'.repeat(40),
    SUPABASE_URL: 'https://ejemplo.supabase.co',
    SUPABASE_SERVICE_KEY: 'clave',
  });
  assert.equal(bueno.ok, true, bueno.salida);
  assert.match(bueno.salida, /ARRANCO/);
});
