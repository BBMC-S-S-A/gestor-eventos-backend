const test = require('node:test');
const assert = require('node:assert');
const { venceEl, vigenciaPorDuracion, textoDuracion } = require('../lib/vigenciaDuracion.js');

const TZ = 'America/Bogota'; // UTC-5, sin horario de verano

test('las horas son horas exactas desde el primer ingreso', () => {
  assert.equal(venceEl({ vigencia_cantidad: 4, vigencia_unidad: 'horas' }, '2026-09-19T14:00:00Z', TZ), '2026-09-19T18:00:00.000Z');
});

test('«2 días» vence a la medianoche del día siguiente al de entrada, en la hora del evento', () => {
  // Entra el 19 a las 4 pm de Bogotá (21:00Z) → vence el 21 a las 00:00 de Bogotá (05:00Z).
  assert.equal(venceEl({ vigencia_cantidad: 2, vigencia_unidad: 'dias' }, '2026-09-19T21:00:00Z', TZ), '2026-09-21T05:00:00.000Z');
  // Entra a las 11 pm de Bogotá del 19 (04:00Z del 20): sigue siendo el día 19 allí.
  assert.equal(venceEl({ vigencia_cantidad: 1, vigencia_unidad: 'dias' }, '2026-09-20T04:00:00Z', TZ), '2026-09-20T05:00:00.000Z');
});

test('una semana son siete días de calendario', () => {
  assert.equal(venceEl({ vigencia_cantidad: 1, vigencia_unidad: 'semanas' }, '2026-09-19T15:00:00Z', TZ), '2026-09-26T05:00:00.000Z');
});

test('sin primer ingreso o sin duración no corre nada', () => {
  assert.equal(venceEl({ vigencia_cantidad: 2, vigencia_unidad: 'dias' }, null, TZ), null);
  assert.equal(venceEl({}, '2026-09-19T15:00:00Z', TZ), null);
  assert.equal(vigenciaPorDuracion({}, null, TZ).vigente, true);
});

test('vencida dice por qué', () => {
  const r = vigenciaPorDuracion({ vigencia_cantidad: 4, vigencia_unidad: 'horas' }, '2026-09-19T10:00:00Z', TZ, Date.parse('2026-09-19T15:00:00Z'));
  assert.equal(r.vigente, false);
  assert.match(r.motivo, /4 horas/);
  assert.equal(textoDuracion({ vigencia_cantidad: 1, vigencia_unidad: 'dias' }), '1 día');
});
