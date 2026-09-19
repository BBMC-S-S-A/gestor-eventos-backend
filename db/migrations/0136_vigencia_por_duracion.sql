-- 0136 · Vigencia por duración: «válida 4 horas», «2 días», «1 semana»
--
-- La 0127 dio a cada tipo de boleta una ventana FIJA (vigencia_desde/hasta),
-- igual para todos. Faltaba la otra, la de los pases: «un día, el que tú
-- elijas» en un evento de tres, o «cuatro horas» en una feria. Esa no tiene
-- fecha propia: corre desde que la persona entra por primera vez.
--
-- Cómo se cuenta vive en `lib/vigenciaDuracion.js`: horas exactas; días y
-- semanas de calendario en la hora del evento (vence a medianoche).

alter table public.ticket_types
  add column if not exists vigencia_cantidad integer,
  add column if not exists vigencia_unidad  text;

alter table public.ticket_types drop constraint if exists ticket_types_vigencia_unidad_chk;
alter table public.ticket_types add constraint ticket_types_vigencia_unidad_chk
  check (vigencia_unidad is null or vigencia_unidad in ('horas', 'dias', 'semanas'));
alter table public.ticket_types drop constraint if exists ticket_types_vigencia_cantidad_chk;
alter table public.ticket_types add constraint ticket_types_vigencia_cantidad_chk
  check (vigencia_cantidad is null or vigencia_cantidad > 0);

-- `checked_in_at` no sirve para esto: en un evento de varios días se reescribe
-- con cada entrada de un día nuevo (así funciona la puerta desde el 18-sep).
-- El primer ingreso se guarda aparte y no se vuelve a tocar.
alter table public.tickets add column if not exists primer_ingreso_at timestamptz;

-- Lo mejor que se sabe de quien ya entró: su entrada guardada. Para quien vino
-- dos días esto es el segundo, no el primero; sólo importa si a un tipo que ya
-- se usó se le pone duración después.
update public.tickets set primer_ingreso_at = checked_in_at
 where primer_ingreso_at is null and checked_in_at is not null;
