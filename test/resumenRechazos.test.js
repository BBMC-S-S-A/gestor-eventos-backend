const test = require('node:test');
const assert = require('node:assert');
const { resumirRechazos } = require('../lib/resumenRechazos.js');

test('separa escaneos dobles de boletas que vuelven más tarde, y encuentra a quien insiste', () => {
  const t = (id) => ({ guest_nombre: `P${id}`, codigo: `C${id}`, tipo: { nombre: 'General' } });
  const r = resumirRechazos([
    { id: 1, ticket_id: 'a', motivo: 'ya_usada_hoy', created_at: '2026-09-19T14:01:00Z', entro_at: '2026-09-19T14:00:00Z', ticket: t('a') },
    { id: 2, ticket_id: 'b', motivo: 'ya_usada_hoy', created_at: '2026-09-19T18:00:00Z', entro_at: '2026-09-19T14:00:00Z', ticket: t('b') },
    { id: 3, ticket_id: 'b', motivo: 'ya_usada_hoy', created_at: '2026-09-19T19:00:00Z', entro_at: '2026-09-19T14:00:00Z', ticket: t('b') },
    { id: 4, ticket_id: 'c', motivo: 'vencida', created_at: '2026-09-19T15:30:00Z', entro_at: null, ticket: t('c') },
  ], 'America/Bogota');
  assert.equal(r.total, 4);
  assert.equal(r.dobles, 1);
  assert.equal(r.tardios, 2);
  assert.deepEqual(r.por_motivo, { ya_usada_hoy: 3, vencida: 1 });
  assert.equal(r.insistentes.length, 1);
  assert.equal(r.insistentes[0].nombre, 'Pb');
  assert.deepEqual(r.por_hora.map(h => h.hora), [9, 10, 13, 14]);
});
