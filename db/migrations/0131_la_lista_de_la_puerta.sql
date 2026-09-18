-- 0131 · Que la lista de la puerta no ordene tres mil filas a mano
--
-- Medido el día del evento (FESTECH IBAGUÉ, 17-sep): 3.129 boletas y la
-- pantalla de la puerta pidiendo la lista entera para poder imprimir una
-- escarapela. `tickets` tenía índice por `evento_id`, pero ninguno que sirviera
-- para ORDENAR: cada página se traía las filas del evento y las ordenaba por
-- `created_at` en memoria. Y la búsqueda por nombre es un `ilike '%…%'`, que
-- sin índice de trigramas es un recorrido completo por cada tecla.
--
-- Lo que se ve desde la puerta cuando esto falta: la lista tarda, y quien se
-- acaba de registrar no aparece hasta que toda la lista vuelve a cargar.
--
-- Son dos índices. No cambian ninguna columna ni ningún dato, se pueden crear
-- y borrar en caliente, y hacen que el orden por fecha y la búsqueda salgan
-- del índice.

-- ── 1 · El orden de la lista ────────────────────────────────────────────
--
-- Exactamente el de la consulta: `evento_id` fijo, y después `created_at desc,
-- id desc` — el `id` entró como desempate para que dos boletas del mismo
-- instante no salgan en distinto orden en cada consulta, que es lo que hacía
-- que una persona apareciera en dos páginas y otra en ninguna.

create index if not exists tickets_evento_creado_idx
  on public.tickets (evento_id, created_at desc, id desc);

-- ── 2 · Buscar por nombre o correo ──────────────────────────────────────
--
-- `pg_trgm` parte el texto en trozos de tres letras, y con un índice GIN sobre
-- ellos un `%pérez%` deja de recorrer la tabla. Es lo que hace que buscar a
-- alguien con la fila delante sea instantáneo en vez de depender de cuánta
-- gente haya registrada.
--
-- Uno POR COLUMNA, y no uno sobre las tres concatenadas: la búsqueda
-- (`lib/tramoDeLista.js`) compara columna por columna —`guest_nombre.ilike.%…%`
-- o `guest_email.ilike.%…%`— porque exige que todas las palabras caigan en el
-- mismo campo. Un índice sobre la concatenación no lo usaría ninguna de esas
-- comparaciones, y el recorrido completo seguiría exactamente igual.

create extension if not exists pg_trgm;

create index if not exists tickets_nombre_trgm_idx
  on public.tickets using gin (guest_nombre gin_trgm_ops);

create index if not exists tickets_email_trgm_idx
  on public.tickets using gin (guest_email gin_trgm_ops);

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   explain analyze
--   select id from public.tickets
--    where evento_id = '<evento>'
--    order by created_at desc, id desc limit 200;
--   -- tiene que decir «Index Scan using tickets_evento_creado_idx», no «Sort».
--
--   select indexname from pg_indexes
--    where tablename='tickets'
--      and indexname in ('tickets_evento_creado_idx','tickets_nombre_trgm_idx','tickets_email_trgm_idx');
--   -- tienen que salir los tres.
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   drop index if exists public.tickets_email_trgm_idx;
--   drop index if exists public.tickets_nombre_trgm_idx;
--   drop index if exists public.tickets_evento_creado_idx;
--
-- Sin riesgo: sólo son índices.
