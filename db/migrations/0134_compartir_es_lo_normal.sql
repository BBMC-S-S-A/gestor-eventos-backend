-- 0134 · Compartir el contacto es lo normal; lo que se marca es no hacerlo
--
-- La 0133 dejó la tarjeta de contacto APAGADA para todos, y cada persona tenía
-- que encenderla. Decisión de quien organiza (Juan, 17-sep): el networking del
-- evento funciona si la tarjeta está abierta desde el registro, y la
-- autorización va en los términos y condiciones que la persona acepta al
-- inscribirse. Lo que se le deja es la salida: marcar que no quiere que
-- aparezcan sus datos, y entonces su QR sólo sirve para entrar.
--
-- Así que la columna cambia de sentido, y se RENOMBRA para que el nombre diga
-- lo que guarda: `contacto_oculto`, falso por defecto. Un `contacto_publico`
-- que quisiera decir lo contrario de lo que dice es exactamente el tipo de
-- columna que alguien lee mal dentro de seis meses.
--
-- No expone nada por sí sola. Lo que se comparte lo decide el organizador en
-- `page_json.tarjeta_contacto.campos`, y mientras esa lista esté vacía la
-- tarjeta no enseña ningún dato de nadie (`lib/tarjetaContacto.js`). Eso es lo
-- que permite desplegar esto hoy y encenderlo cuando los términos del evento
-- lo digan.
--
-- Se puede aplicar sin miedo: al hacerlo, `contacto_publico` estaba en falso en
-- todas las filas (nadie había encendido nada), así que ninguna queda oculta
-- por error.

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'tickets' and column_name = 'contacto_publico')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'tickets' and column_name = 'contacto_oculto') then
    alter table public.tickets rename column contacto_publico to contacto_oculto;
    -- El sentido se invierte: lo que era «encendida» (true) pasa a «no oculta».
    update public.tickets set contacto_oculto = not contacto_oculto where contacto_oculto;
  end if;
end $$;

alter table public.tickets
  add column if not exists contacto_oculto boolean not null default false;
alter table public.tickets alter column contacto_oculto set default false;

comment on column public.tickets.contacto_oculto is
  'La persona pidió que NO aparezcan sus datos al escanear su QR. Por defecto false: comparte lo que el organizador eligió en page_json.tarjeta_contacto. Con true, su QR sólo sirve para entrar.';

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select count(*) filter (where contacto_oculto) as ocultos, count(*) as total
--     from public.tickets where evento_id = '<evento>';
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   alter table public.tickets rename column contacto_oculto to contacto_publico;
--   update public.tickets set contacto_publico = not contacto_publico;
