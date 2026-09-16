/* Cliente Supabase con service_role.
   Backend-only. Salta RLS porque el backend ya hace su propia autorización
   en cada handler (compara owner_id contra req.user.id). */
const { createClient } = require('@supabase/supabase-js');

const URL  = process.env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!URL || !KEY) {
  console.error('[supabase] Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env');
  process.exit(1);
}

/* Sin esto, un `await supabase.from(...)` que tropieza con una red que se
   degrada —no que se cae limpio, sino que se cuelga— se queda esperando para
   siempre: ninguna respuesta, ni error ni éxito, y quien hizo la petición ve
   la rueda de carga eternamente. `fetch` de Node no trae timeout por
   defecto, y `supabase-js` tampoco pone uno. Visto en producción: "crear
   torneo" (y potencialmente cualquier otra ruta) sin responder nunca, ni con
   un 500.

   20s porque hay consultas reales que tardan (reportes, exportar CSV) y un
   timeout corto las tiraría con el mismo síntoma que se quiere evitar. Lo que
   esto arregla no es la lentitud — es el cuelgue infinito: ahora, en el peor
   caso, hay un error a los 20s en vez de nunca. */
const CONSULTA_TIMEOUT_MS = 20_000;

const supabase = createClient(URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    fetch: (url, options = {}) => fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(CONSULTA_TIMEOUT_MS),
    }),
  },
});

module.exports = supabase;
