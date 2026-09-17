/* Entrar en una sala saca de la anterior.
 *
 * ── Qué se estaba rompiendo ──────────────────────────────────────────────
 *
 * El aforo de una zona sólo bajaba si alguien escaneaba AL SALIR, y la gente
 * no sale escaneando: se levanta y se va a la charla de al lado. El número de
 * la sala A subía toda la jornada y no bajaba nunca. Un aforo que sólo crece
 * no sirve para lo único que existe: decidir si se cierra una puerta.
 *
 * ── Qué se prueba aquí ──────────────────────────────────────────────────
 *
 * `salasOcupadas` es la decisión: de todo el ir y venir de una persona, en qué
 * salas consta que está AHORA. Es una función pura y se prueba de verdad, con
 * datos, no leyendo el archivo.
 *
 * Lo demás —escribir las filas— necesita base y se cubre en el arranque.
 */
'use strict';

/* `lib/salaUnica.js` arrastra el cliente de Supabase, que se muere al cargar
   si no encuentra sus variables. Aquí no se toca la base —lo que se prueba es
   una función pura— pero el `require` pasa igual por ahí. Mismo apaño que en
   `arranque.test.js` y compañía. */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert/strict');
const { salasOcupadas, claveDeZona } = require('../lib/salaUnica.js');

const mov = (zona_id, tipo, created_at, zona = null) => ({ zona_id, zona, tipo, created_at });

test('la última fila de cada sala es la que manda', () => {
  const dentro = salasOcupadas([
    mov('A', 'entrada', '2026-09-17T10:00:00Z'),
    mov('A', 'salida',  '2026-09-17T10:30:00Z'),
    mov('B', 'entrada', '2026-09-17T10:31:00Z'),
  ]);
  assert.deepEqual(dentro.map(claveDeZona), ['B'],
    'sigue contando una sala de la que ya salió');
});

test('el orden lo pone la fecha, no el orden en que lleguen las filas', () => {
  /* PostgREST puede devolverlas en cualquier orden, y una lista desordenada
     haría que la salida de las 10:30 pisara a la entrada de las 10:45 — con lo
     que la persona quedaría fuera de una sala en la que sí está. */
  const dentro = salasOcupadas([
    mov('A', 'salida',  '2026-09-17T10:30:00Z'),
    mov('A', 'entrada', '2026-09-17T10:45:00Z'),
    mov('A', 'entrada', '2026-09-17T10:00:00Z'),
  ]);
  assert.deepEqual(dentro.map(claveDeZona), ['A'],
    'el orden de llegada de las filas está decidiendo el aforo');
});

test('el recinto general no es una sala', () => {
  /* Las filas sin zona son la entrada AL EVENTO. Entrar a una sala no es salir
     del evento; es justo lo contrario, y contarlo como sala sacaría a la
     persona del recinto en cuanto pisara el primer salón. */
  const dentro = salasOcupadas([
    mov(null, 'entrada', '2026-09-17T09:00:00Z'),
    mov('A',  'entrada', '2026-09-17T10:00:00Z'),
  ]);
  assert.deepEqual(dentro.map(claveDeZona), ['A'],
    'el recinto general se está tratando como una sala más');
});

test('una sala vieja identificada sólo por su nombre también cuenta', () => {
  /* Los movimientos anteriores a la 0079 no tienen `zona_id`. Si no se
     reconocieran, una persona que entró antes de esa migración se quedaría
     dentro de esa sala para siempre. */
  const dentro = salasOcupadas([
    { zona_id: null, zona: 'Auditorio', tipo: 'entrada', created_at: '2026-09-17T09:00:00Z' },
  ]);
  assert.deepEqual(dentro.map(claveDeZona), ['Auditorio']);
});

test('sin movimientos no se deduce nada', () => {
  /* No inventar entradas es la mitad del asunto: escribir una salida de alguien
     que no consta dentro deja el aforo en negativo y eso no se arregla solo. */
  assert.deepEqual(salasOcupadas([]), []);
  assert.deepEqual(salasOcupadas([mov('A', 'salida', '2026-09-17T10:00:00Z')]), []);
});

test('estar en tres salas a la vez es posible en los datos, y hay que verlo', () => {
  /* El arreglo asume una sala por persona, pero el HISTÓRICO puede tener a
     alguien dentro de varias —así estaban las cosas antes de esto—. La función
     tiene que devolverlas todas para que se cierren todas; devolver sólo una
     dejaría las otras contando de más, que es el fallo original. */
  const dentro = salasOcupadas([
    mov('A', 'entrada', '2026-09-17T09:00:00Z'),
    mov('B', 'entrada', '2026-09-17T10:00:00Z'),
    mov('C', 'entrada', '2026-09-17T11:00:00Z'),
  ]);
  assert.deepEqual(dentro.map(claveDeZona).sort(), ['A', 'B', 'C']);
});
