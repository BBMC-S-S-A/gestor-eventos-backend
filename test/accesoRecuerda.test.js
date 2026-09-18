process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';
const test = require('node:test');
const assert = require('node:assert');
const supabase = require('../lib/supabase.js');
const { assertPermiso, _memoria } = require('../lib/acceso.js');

function falso(filas, cuenta) {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => { cuenta.n++; return { data: filas[q.t], error: null }; } };
  return (t) => { q.t = t; return q; };
}

test('las comprobaciones de permiso repetidas no vuelven a la base en 30 s', async () => {
  const original = supabase.from;
  const cuenta = { n: 0 };
  supabase.from = falso({ eventos: { id: 'e1', owner_id: 'otro' }, event_members: { custom_permissions: ['ver'], rol_detail: null } }, cuenta);
  try {
    for (let i = 0; i < 5; i++) await assertPermiso('e1', 'u1', ['ver']);
    assert.equal(cuenta.n, 2);
    await assert.rejects(assertPermiso('e1', 'u1', ['borrar']), /No autorizado/);
  } finally { supabase.from = original; _memoria.clear(); }
});

test('quien no es miembro no se recuerda: al añadirlo, entra en el acto', async () => {
  const original = supabase.from;
  const cuenta = { n: 0 };
  const filas = { eventos: { id: 'e2', owner_id: 'otro' }, event_members: null };
  supabase.from = falso(filas, cuenta);
  try {
    await assert.rejects(assertPermiso('e2', 'u2', ['ver']), /No autorizado/);
    filas.event_members = { custom_permissions: ['ver'] };
    assert.equal((await assertPermiso('e2', 'u2', ['ver'])).id, 'e2');
  } finally { supabase.from = original; _memoria.clear(); }
});
