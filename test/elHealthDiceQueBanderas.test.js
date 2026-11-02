'use strict';

/* `/health` dice qué banderas está leyendo, y hace cuánto arrancó.
 *
 * ── Para qué ─────────────────────────────────────────────────────────────
 *
 * Las tres banderas se encienden poniendo una variable en el panel del cPanel
 * y reiniciando. Passenger las lee **al reiniciar, no al guardarlas**, y ahí
 * está la trampa: un reinicio que no ocurrió se ve exactamente igual que uno
 * que sí, porque la aplicación responde en los dos casos.
 *
 * La única señal que había era una línea en el log del arranque:
 *
 *     [datos] DATOS_PROPIOS encendido: las consultas van a MySQL
 *
 * Y en Application Manager —el Passenger nuevo, que es lo que trae este
 * cPanel— los logs no siempre están a mano. Así que quien encendía la bandera
 * se quedaba sin forma de confirmar que había surtido efecto, y la forma de
 * salir de dudas era probar una ruta y adivinar de dónde venían los datos.
 *
 * `uptime_s` responde «¿reinició?» y `banderas` responde «¿qué está leyendo?».
 *
 * ── Por qué es seguro que sea público ────────────────────────────────────
 *
 * Son dos booleanos y un número. No dicen nada de ninguna persona ni de
 * ninguna credencial, y la ruta ya era pública — trae el commit desplegado
 * desde antes. Lo que se gana es que la comprobación del corte se pueda hacer
 * desde un navegador, sin entrar al panel.
 *
 * Correr: npm test */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const FUENTE = fs.readFileSync('index.js', 'utf8');

test('/health informa de las tres banderas', () => {
  const codigo = FUENTE.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const b of ['AUTH_PROPIA', 'ARCHIVOS_PROPIOS', 'DATOS_PROPIOS']) {
    assert.match(codigo, new RegExp(`banderas[\\s\\S]{0,260}${b}`),
      `/health dejó de informar de ${b}`);
  }
});

test('/health dice hace cuánto arrancó', () => {
  /* Un número chiquito es la prueba de que el reinicio ocurrió. Sin esto no
     hay forma de distinguir «reinició y la variable no estaba» de «no
     reinició», y son dos arreglos distintos. */
  const codigo = FUENTE.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(codigo, /uptime_s\s*:\s*Math\.round\(process\.uptime\(\)\)/);
});

test('las banderas salen del config, no de process.env a mano', () => {
  /* `core/config` es quien decide qué cuenta como encendida —sólo `true` y
     `1`—. Si `/health` leyera `process.env` por su cuenta, podría decir que
     una bandera está encendida mientras la aplicación la ve apagada, que es
     justo la confusión que esto viene a quitar. */
  const bloque = FUENTE.slice(FUENTE.indexOf('banderas:'), FUENTE.indexOf('banderas:') + 300);
  assert.ok(!/process\.env/.test(bloque),
    '/health lee las banderas de process.env en vez de core/config');
  assert.match(bloque, /configPropia\./,
    'las banderas tienen que venir de core/config, que es quien las interpreta');
});

test('no se cuela nada secreto en la respuesta', () => {
  /* `/health` es público. Añadir aquí un dato de configuración es fácil y se
     publica sin que nadie lo revise. */
  const inicio = FUENTE.indexOf("app.get('/health'");
  const bloque = FUENTE.slice(inicio, FUENTE.indexOf('res.json(cuerpo)', inicio));
  const prohibidas = /SECRET|PASSWORD|_KEY|TOKEN|SERVICE_KEY|MYSQL_USER|MYSQL_HOST|SUPABASE_URL/;
  const sinComentarios = bloque.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!prohibidas.test(sinComentarios),
    'se está publicando algo que parece una credencial en una ruta pública');
});
