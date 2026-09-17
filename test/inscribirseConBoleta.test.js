'use strict';
/* Apuntarse a un sub-evento en modo 'evento' con la boleta en la mano.
 *
 * El modal no enseña el formulario del evento —ya se llenó al sacar la boleta
 * y le dice a la persona «no hace falta que escribas nada más»—, así que manda
 * `respuestas: {}`. El servidor validaba el formulario completo contra ese
 * objeto vacío: con un solo campo obligatorio («Fecha de nacimiento» en
 * FESTECH) nadie podía apuntarse.
 *
 * Correr: node --test test/inscribirseConBoleta.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sesiones.js'), 'utf8');
const inscribir = src.slice(src.indexOf("'/slug/:slug/sesiones/:sesionId/inscribir'"));
const cuerpo = inscribir.slice(0, inscribir.indexOf('\n});'));

test('en modo evento no se valida el formulario del evento al inscribirse', () => {
  const i = cuerpo.indexOf('validarFormulario(');
  assert.ok(i > 0, 'la inscripción ya no valida nada: ¿se perdió la validación del modo propio?');
  const antes = cuerpo.slice(0, i);
  assert.match(antes, /formulario_modo\s*!==\s*'evento'/,
    'validarFormulario corre también en modo evento, donde el modal no pide nada');
});
