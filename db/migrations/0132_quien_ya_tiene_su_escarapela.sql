-- 0132 · Quién ya tiene su escarapela impresa
--
-- Nace de la puerta de FESTECH: tres mil boletas, dos personas imprimiendo y
-- ninguna forma de saber a quién ya se le imprimió. Lo que se veía desde el
-- mostrador era una lista igual de larga a las nueve de la mañana que a las
-- cinco de la tarde, y la única manera de no repetir una escarapela era que
-- alguien se acordara.
--
-- Se guarda en la BOLETA y no en el navegador de quien imprime, a propósito:
-- en la puerta hay varias estaciones, y lo que una imprimió tiene que verlo la
-- otra. Guardarlo en `localStorage` habría dado una respuesta distinta por
-- equipo, que es peor que no tener respuesta.
--
-- Dos columnas opcionales sobre una tabla que ya existe: no hay pérdida de
-- datos posible y la vuelta atrás es limpia.

alter table public.tickets
  add column if not exists escarapela_impresa_at  timestamptz,
  -- Quién la imprimió. Sirve para lo mismo que `operador_id` en las entregas:
  -- cuando alguien reclama que no le dieron la suya, se puede preguntar a la
  -- persona concreta en vez de a «la puerta».
  add column if not exists escarapela_impresa_por uuid;

comment on column public.tickets.escarapela_impresa_at is
  'Cuándo se imprimió la escarapela de esta boleta. NULL = todavía no. Lo escribe la pantalla de la etiquetadora.';
comment on column public.tickets.escarapela_impresa_por is
  'Quién la imprimió (auth.users.id). Sin clave foránea a propósito: un operador borrado no debe llevarse el registro de la impresión.';

-- La pregunta del día del evento es «a quién le falta», y con tres mil boletas
-- conviene que salga del índice y no de recorrer la tabla. Parcial: sólo
-- indexa las que faltan, que son las que se buscan, y se encoge sola a medida
-- que avanza la jornada.
create index if not exists tickets_sin_imprimir_idx
  on public.tickets (evento_id, created_at desc)
  where escarapela_impresa_at is null;

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select column_name from information_schema.columns
--    where table_name='tickets' and column_name like 'escarapela_%';
--   -- tienen que salir las dos.
--
--   select count(*) filter (where escarapela_impresa_at is null) as faltan,
--          count(*) filter (where escarapela_impresa_at is not null) as impresas
--     from public.tickets where evento_id = '<evento>';
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   drop index if exists public.tickets_sin_imprimir_idx;
--   alter table public.tickets
--     drop column if exists escarapela_impresa_por,
--     drop column if exists escarapela_impresa_at;
--
-- Se pierde el registro de qué se imprimió, nada más.
