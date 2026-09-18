'use strict';
/* Un evento de tres días son tres entradas con la misma boleta.
 *
 * El check-in marcaba `usado` y desde ese momento contestaba «esta boleta ya
 * fue usada» para siempre. En FESTECH (17 al 19 de septiembre) eso significaba
 * que el día 2 por la mañana la puerta rechazaba a todo el mundo con su QR
 * bueno en la mano.
 *
 * La regla queda por DÍA DEL RECINTO: repetir hoy sigue rechazando; mañana el
 * mismo QR abre otra vez.
 *
 * Correr: node --test test/tresDiasUnaBoleta.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RUTA = fs.readFileSync(path.join(__dirname, '..', 'routes', 'clientes.js'), 'utf8');

test('el día se calcula en la zona horaria del evento, no en la del servidor', () => {
  assert.match(RUTA, /function diaDelEvento\(cuando, timezone\)/);
  assert.match(RUTA, /timeZone: timezone \|\| 'America\/Bogota'/,
    'sin zona horaria, las once de la noche en Ibagué ya serían el día siguiente');
  assert.match(RUTA, /select\('id, owner_id, timezone'\)/,
    'la puerta no está leyendo la zona horaria del evento');
});

test('una entrada de otro día no bloquea, y una de hoy sí', () => {
  assert.match(RUTA, /const entroOtroDia = Boolean\(ticket\.checked_in_at\)/);
  assert.match(RUTA, /ticket\.estado === 'usado' && !entroOtroDia/,
    'el rechazo por «ya usada» no mira el día: un evento de varios días queda cerrado el día 2');
});

test('la cerradura sigue existiendo en el día nuevo', () => {
  /* Sin esto, dos puertas escaneando el mismo QR el día 2 lo dejarían pasar
     las dos: `.neq(estado, usado)` ya no sirve de cerrojo porque la boleta
     está usada desde el día 1. */
  const i = RUTA.indexOf('escritura = entroOtroDia');
  assert.ok(i > 0, 'ya no hay dos caminos de escritura: ¿se perdió la cerradura?');
  const bloque = RUTA.slice(i, i + 600);
  assert.match(bloque, /\.eq\('checked_in_at', ticket\.checked_in_at\)/,
    'el día nuevo escribe sin comparar contra lo que leyó: dos puertas a la vez entrarían las dos');
  assert.match(bloque, /\.neq\('estado', 'usado'\)/,
    'el primer día perdió su cerradura de siempre');
});

test('la puerta se entera de que es un día nuevo', () => {
  assert.match(RUTA, /nuevo_dia: entroOtroDia \|\| undefined/,
    'quien escanea no puede distinguir «entró otra vez» de «dejé pasar una repetida»');
});
