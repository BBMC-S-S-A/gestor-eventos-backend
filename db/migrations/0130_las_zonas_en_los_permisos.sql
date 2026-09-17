-- 0130 · Las zonas en los permisos de los roles (nació como 0129: número repetido con la del NIT, renumerada sin cambiar el contenido)
--
-- Crear una zona pedía `editar_pagina_publica`, y colocarla en el plano
-- `editar_evento`. Para que logística dibujara el recinto había que darle la
-- landing y el evento enteros. `gestionar_zonas` abre `page_json` sólo por
-- `zonas` y `mapa` (`lib/quePuedeEditar.js`).
--
-- No crea tablas ni columnas: un permiso es una cadena dentro del jsonb del rol.
-- Lo que sí hay que hacer en la base es lo mismo que hizo la 0126 con
-- `entregar`: reescribir la semilla —un permiso nuevo en el catálogo no llega
-- solo a la función que siembra los roles de un evento nuevo— y añadirlo a los
-- roles que ya existen.
--
-- No depende de la 0125 ni de la 0126: sólo reescribe una función que existe
-- desde la 0124.

create or replace function private.fn_roles_semilla()
returns table (nombre text, descripcion text, permissions jsonb, orden integer)
language sql
immutable
as $$
  values
    ('Administrador',     'Puede todo dentro del evento, salvo transferirlo o borrarlo',
      '["editar_evento","publicar_evento","editar_pagina_publica","gestionar_imagenes",
        "gestionar_agenda","gestionar_torneo","gestionar_expositores","gestionar_accesos","gestionar_zonas",
        "invitar_staff","gestionar_roles","remover_miembros","gestionar_solicitudes",
        "gestionar_tareas","ver_documentos","gestionar_documentos","gestionar_vacantes",
        "gestionar_tickets","gestionar_descuentos",
        "ver_clientes","gestionar_clientes","checkin","entregar","vip_zone","borrar_boletas",
        "gestionar_acreditacion","gestionar_padron",
        "crear_canales","borrar_mensajes","publicar_anuncios",
        "ver_pagos","reembolsar","ver_analytics"]'::jsonb, 0),
    ('Editor',            'Edita información, agenda y página pública',
      '["editar_evento","editar_pagina_publica","gestionar_imagenes","gestionar_agenda","ver_documentos"]'::jsonb, 1),
    ('Coordinador',       'Coordina al staff y al evento completo',
      '["editar_evento","invitar_staff","gestionar_agenda","ver_clientes","ver_analytics",
        "crear_canales","gestionar_solicitudes","gestionar_tareas","ver_documentos"]'::jsonb, 2),
    ('Puerta',            'Controla el ingreso y escanea las entradas',
      '["checkin","ver_clientes"]'::jsonb, 3),
    -- Montaje y escenario. Se le añaden los dos que necesita de verdad y que
    -- antes obligaban a darle el evento entero: colgar los planos y el rider, y
    -- dejar listas las escarapelas del día.
    ('Staff · Logística', 'Montaje, técnica y escenario',
      '["crear_canales","checkin","ver_documentos","gestionar_documentos",
        "gestionar_acreditacion","gestionar_accesos","gestionar_zonas"]'::jsonb, 4),
    ('Atención',          'Atiende asistentes durante el evento',
      '["ver_clientes","gestionar_clientes","checkin","gestionar_solicitudes","gestionar_padron"]'::jsonb, 5),
    ('VIP host',          'Anfitrión de zona VIP',
      '["vip_zone","ver_clientes","checkin"]'::jsonb, 6),
    ('Coordinación de expositores', 'Gestiona los stands y las fichas de los expositores',
      '["gestionar_expositores","ver_clientes"]'::jsonb, 7),
    ('Programación',      'Arma el calendario: charlas, talleres y competencias',
      '["gestionar_agenda","gestionar_torneo"]'::jsonb, 8),
    ('Finanzas',          'Ve ingresos, facturación y reembolsos',
      '["ver_pagos","reembolsar","ver_clientes","ver_analytics"]'::jsonb, 9),
    ('Moderación',        'Modera el chat del evento',
      '["borrar_mensajes","crear_canales"]'::jsonb, 10)
$$;

-- A los roles que ya existen, sólo a quien YA podía editar zonas: quien tiene
-- `editar_pagina_publica` guardaba la zona y quien tiene `editar_evento`, el
-- plano. No se le da a nadie un poder que no tuviera. Se AÑADE, nunca se
-- reemplaza, y se puede correr dos veces.
--
-- A Staff · Logística de eventos ya creados NO se le añade: si alguien ajustó
-- ese rol, esa decisión es suya. Se concede a mano desde Equipo → Roles.

update public.event_roles r
   set permissions = coalesce(
         (select jsonb_agg(distinct p)
            from jsonb_array_elements_text(r.permissions || '["gestionar_zonas"]'::jsonb) p),
         r.permissions)
 where (r.permissions ? 'editar_pagina_publica' or r.permissions ? 'editar_evento')
   and not (r.permissions ? 'gestionar_zonas');

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select count(*) from public.event_roles
--    where (permissions ? 'editar_pagina_publica' or permissions ? 'editar_evento')
--      and not (permissions ? 'gestionar_zonas');
--   -- tiene que salir 0.
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   update public.event_roles set permissions = permissions - 'gestionar_zonas';
--   y volver a aplicar la función de la 0126.
