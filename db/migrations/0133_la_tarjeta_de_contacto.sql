-- 0133 · Un QR que también sirve para presentarse
--
-- Lo que se pidió: que el mismo QR de la escarapela, escaneado por otro
-- asistente con la cámara del móvil, enseñe los datos de contacto de esa
-- persona. En un evento de networking es la diferencia entre «déjame tu
-- WhatsApp» dictado a mano y una tarjeta que se guarda en dos toques.
--
-- ── Por qué NO son las respuestas del registro ──────────────────────────
--
-- El formulario de FESTECH pide documento de identidad, fecha de nacimiento,
-- identidad de género, autorreconocimiento étnico, discapacidad y barrio. Un
-- QR que enseñara «los datos de la persona» convertiría cada escarapela
-- colgada del cuello en eso, a la vista de cualquiera que le haga una foto.
-- Son datos sensibles: la Ley 1581 de 2012 pide autorización específica para
-- tratarlos y prohíbe divulgarlos, y aquí no habría ni autorización ni forma
-- de retirarla.
--
-- Por eso la tarjeta es OTRA COSA, guardada aparte:
--
--   · sólo lo que la persona escribe para esto (empresa, cargo, teléfono…),
--   · apagada mientras no la encienda ella (`contacto_publico` en false),
--   · y se apaga igual de fácil, que es lo que convierte esto en una decisión
--     suya y no en una consecuencia de haberse registrado.
--
-- El correo del registro no se copia aquí: si quiere darlo, lo escribe. No es
-- lo mismo dárselo al organizador para recibir la boleta que dejarlo a la
-- vista de quien pase el móvil por la escarapela.

alter table public.tickets
  add column if not exists contacto_publico boolean not null default false,
  -- Sólo estas claves, y se validan en el servidor (`lib/tarjetaContacto.js`):
  -- empresa, cargo, email, telefono, whatsapp, web, linkedin, nota.
  add column if not exists contacto jsonb not null default '{}'::jsonb;

comment on column public.tickets.contacto_publico is
  'La persona aceptó que su tarjeta de contacto se vea al escanear su QR. Por defecto NO. Sin esto, /contacto/:codigo no devuelve ningún dato.';
comment on column public.tickets.contacto is
  'Lo que ella misma escribió para su tarjeta (empresa, cargo, teléfono…). NUNCA se llena con las respuestas del formulario de registro: ésas incluyen datos sensibles y tienen otra finalidad.';

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select count(*) filter (where contacto_publico) as comparten
--     from public.tickets where evento_id = '<evento>';
--   -- al aplicarla tiene que salir 0: nadie comparte nada hasta que lo encienda.
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   alter table public.tickets
--     drop column if exists contacto,
--     drop column if exists contacto_publico;
--
-- Se pierden las tarjetas que la gente hubiera escrito, nada más.
