const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'ficticia';
const supabase = require('../lib/supabase.js');
const { _paraPruebas } = require('../middleware/auth.js');

function tokenQueVence(segundos) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ exp: Math.floor(Date.now() / 1000) + segundos, r: Math.random() })}.x`;
}

test('un token válido se pregunta a Supabase una vez por minuto, no en cada petición', async () => {
  const original = supabase.auth.getUser;
  let llamadas = 0;
  supabase.auth.getUser = async () => { llamadas++; return { data: { user: { id: 'u1' } }, error: null }; };
  try {
    const t = tokenQueVence(3600);
    for (let i = 0; i < 5; i++) assert.equal((await _paraPruebas.porSupabase(t)).id, 'u1');
    assert.equal(llamadas, 1);
  } finally { supabase.auth.getUser = original; _paraPruebas.recordados.clear(); }
});

test('un token rechazado no se recuerda: se vuelve a preguntar', async () => {
  const original = supabase.auth.getUser;
  let llamadas = 0;
  supabase.auth.getUser = async () => { llamadas++; return { data: null, error: new Error('no') }; };
  try {
    const t = tokenQueVence(3600);
    assert.equal(await _paraPruebas.porSupabase(t), null);
    assert.equal(await _paraPruebas.porSupabase(t), null);
    assert.equal(llamadas, 2);
  } finally { supabase.auth.getUser = original; _paraPruebas.recordados.clear(); }
});

test('un token ya vencido no se recuerda', async () => {
  const original = supabase.auth.getUser;
  let llamadas = 0;
  supabase.auth.getUser = async () => { llamadas++; return { data: { user: { id: 'u1' } }, error: null }; };
  try {
    const t = tokenQueVence(-10);
    await _paraPruebas.porSupabase(t); await _paraPruebas.porSupabase(t);
    assert.equal(llamadas, 2);
  } finally { supabase.auth.getUser = original; _paraPruebas.recordados.clear(); }
});
