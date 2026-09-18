-- 0135 · Los rechazos de la puerta
--
-- El 18-sep entraron 1.555 personas y no se sabe cuántas veces la puerta dijo
-- «esta boleta ya fue usada». Ese aviso no se guardaba en ninguna parte: sólo
-- quedaba lo que SÍ entró. Sin él no se puede contestar si hubo gente
-- intentando entrar dos veces con la misma boleta, ni a qué hora, ni en qué
-- puerta pasó más.
--
-- ── Por qué una tabla aparte y no `ticket_movimientos` ──────────────────
--
-- `ticket_movimientos` es el vaivén de quien está DENTRO: el aforo y el
-- reingreso lo leen para contar quién hay y decidir si toca entrada o salida,
-- y varias de esas consultas no filtran por tipo. Un rechazo ahí sumaría o
-- restaría gente que nunca cruzó la puerta. Aquí no lo lee nadie más.
--
-- Nullable y sin claves obligatorias salvo el evento: el rechazo se anota
-- aunque falte el operador, y borrar una boleta no tiene por qué borrar la
-- constancia de que alguien intentó usarla.

create table if not exists public.puerta_rechazos (
  id          uuid primary key default gen_random_uuid(),
  evento_id   uuid not null references public.eventos(id) on delete cascade,
  ticket_id   uuid references public.tickets(id) on delete set null,
  motivo      text not null,               -- 'ya_usada_hoy' por ahora
  operador_id uuid references public.profiles(id) on delete set null,
  -- Cuándo había entrado de verdad: con eso se ve si el repetido fue al
  -- minuto (escaneo doble) o horas después (boleta prestada).
  entro_at    timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists puerta_rechazos_evento_idx
  on public.puerta_rechazos (evento_id, created_at desc);

-- Sólo el backend (service role) escribe y lee. Sin políticas = cerrada.
alter table public.puerta_rechazos enable row level security;
