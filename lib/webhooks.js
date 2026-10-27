/* GESTEK — Webhooks salientes. dispatch(ownerId, tipo, payload):
   busca webhooks activos del owner suscritos a `tipo`, firma el body con
   HMAC-SHA256 (header x-gestek-signature) y hace POST con 1 reintento.
   Registra cada entrega en webhook_deliveries. Best-effort: nunca lanza. */

const crypto = require('crypto');
const supabase = require('./supabase.js');

function firmar(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function entregar(webhook, tipo, payload) {
  const body = JSON.stringify({ tipo, data: payload, ts: Date.now() });
  const sig = firmar(webhook.secret, body);

  const { data: del } = await supabase.from('webhook_deliveries').insert({
    webhook_id: webhook.id, evento_tipo: tipo, payload, status: 'pending',
  }).select('id').single();

  let ok = false, code = null, intentos = 0;
  for (let intento = 1; intento <= 2 && !ok; intento++) {
    intentos = intento;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'GESTEK-Webhooks/1.0',
          'x-gestek-event': tipo,
          'x-gestek-signature': `sha256=${sig}`,
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      code = resp.status;
      ok = resp.ok;
    } catch (e) {
      code = null;
    }
    if (!ok && intento === 1) await new Promise(r => setTimeout(r, 1500));
  }

  if (del?.id) {
    await supabase.from('webhook_deliveries').update({
      status: ok ? 'ok' : 'failed', response_code: code, intentos,
    }).eq('id', del.id);
  }
}

/* ── Por qué el filtro por `tipo` se hace aquí y no en la base ────────────
 *
 * Antes era `.contains('eventos', [tipo])`, que PostgREST traduce al operador
 * `@>` de Postgres. En MySQL eso no existe: `webhooks.eventos` pasa de
 * `text[]` a `JSON` (ver NOTAS-ESQUEMA) y el equivalente se escribe
 * `JSON_CONTAINS(eventos, JSON_QUOTE(?))` o `? MEMBER OF (eventos)`.
 *
 * O sea que esa línea era una de las que el corte rompía — y rompía en
 * silencio: `.contains()` contra MySQL no devuelve un error, devuelve
 * **ningún webhook**. Nadie se entera de que dejaron de salir avisos hasta que
 * alguien de fuera pregunta por qué su integración se quedó muda.
 *
 * Se podía haber puesto una costura con las dos escrituras del filtro, una por
 * motor. No sale a cuenta: la lista que se filtra son los webhooks ACTIVOS DE
 * UNA CUENTA. Medido contra producción el 27-oct: **cero webhooks en toda la
 * base**, y por diseño son un puñado por organizador. Traerlos y mirar el
 * array en JavaScript cuesta lo mismo y vale para los dos motores.
 *
 * Lo que sí se pierde es el tope: PostgREST devuelve 1.000 filas por defecto,
 * así que si algún día una cuenta pasara de mil webhooks activos, los de más
 * allá no se mirarían. Con `@>` tampoco se mirarían —el tope es del transporte,
 * no del filtro—, así que no es una regresión; queda dicho por si alguna vez
 * ese número deja de ser absurdo. */
async function dispatch(ownerId, tipo, payload) {
  if (!ownerId || !tipo) return;
  try {
    const { data: activos } = await supabase
      .from('webhooks').select('*')
      .eq('owner_id', ownerId).eq('activo', true);

    /* `eventos` llega como array de JavaScript con los dos motores: Postgres
       lo entrega desde `text[]` y mysql2 parsea la columna `JSON` a un array
       de verdad. Comprobado contra MySQL 8.0.46. */
    const hooks = (activos || []).filter(w => (w.eventos || []).includes(tipo));

    for (const w of hooks || []) {
      /* no await en serie bloqueante: disparamos en paralelo best-effort */
      entregar(w, tipo, payload).catch(() => {});
    }
  } catch (e) {
    console.warn('[webhooks] dispatch error:', e.message);
  }
}

module.exports = { dispatch, firmar };
