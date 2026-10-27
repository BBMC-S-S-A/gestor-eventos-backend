-- 0139 · Fijar el `search_path` de las diez funciones que no lo tenían
--
-- Lo que queda del endurecimiento que empezaron la 0030 y la 0137. El
-- analizador de Supabase marca diez funciones con `search_path` mutable;
-- medido contra producción el 27-oct, son exactamente éstas y ninguna más.
--
-- ── Por qué esto NO es tan grave como suena, y por qué igual se hace ─────
--
-- Conviene decirlo, porque el aviso del panel es el mismo para dos casos que
-- no se parecen en nada.
--
-- El `search_path` mutable es peligroso de verdad en una función
-- `SECURITY DEFINER`: ésa corre con los permisos de quien la creó, así que si
-- quien la llama puede colocar un esquema propio por delante de `public`,
-- consigue que el dueño ejecute SU tabla o SU función. Eso es escalada de
-- privilegios.
--
-- **Las 21 funciones `SECURITY DEFINER` de esta base ya tienen el
-- `search_path` puesto.** Comprobado una por una. Las diez de aquí son todas
-- `SECURITY INVOKER`: corren con los permisos de quien llama, así que lo peor
-- que consigue quien manipule su propio `search_path` es engañarse a sí mismo.
--
-- Entonces, ¿por qué tocarlas? Por esto:
--
--   1. **Dos de ellas leen tablas SIN calificar el esquema.** Las dos de la
--      0138, que son justo las que cuentan lo vendido:
--
--          update eventos      set aforo_vendido = ...
--          update ticket_types set vendidos      = ...
--
--      Hoy funcionan porque el `search_path` de quien las llama incluye
--      `public`. Eso es una suposición, no una garantía. Si algún día alguien
--      crea una tabla `eventos` en un esquema que vaya por delante, el
--      contador escribe en la tabla equivocada — y ya sabemos lo que cuesta
--      un contador de aforo que miente: la 0138 nació de eso.
--
--      Son las dos que más importan de la lista.
--
--   2. Cuatro son funciones de DISPARADOR, y un disparador corre con quien
--      hace el INSERT, no con quien lo escribió. El `search_path` de esa
--      sesión no lo controla nadie.
--
--   3. Y porque dejar diez avisos encendidos en el panel es la forma de que el
--      día que aparezca el aviso que SÍ importa, nadie lo vea.
--
-- ── Qué hace y qué no ───────────────────────────────────────────────────
--
-- `ALTER FUNCTION ... SET search_path` **no toca el cuerpo** de la función:
-- sólo le fija el entorno con el que corre. No hay riesgo de cambiar
-- comportamiento, y la vuelta atrás es un `RESET` (está al final).
--
-- Se comprobó el cuerpo de las diez antes de escribir esto: ninguna depende de
-- encontrar nada fuera de `public`, así que fijarlo ahí no rompe ninguna.
--
-- `public, pg_temp` y en ese orden, que es el que ya usan las otras 21.
-- `pg_temp` al final a propósito: delante, una tabla temporal podría tapar a
-- una de verdad.

-- ── Las dos que de verdad importan (0138) ───────────────────────────────
alter function public.sumar_aforo_vendido(uuid, integer) set search_path = public, pg_temp;
alter function public.sumar_vendidos_tipo(uuid, integer)  set search_path = public, pg_temp;

-- ── Las de disparador ───────────────────────────────────────────────────
alter function public.evento_legal_version()     set search_path = public, pg_temp;
alter function public.fn_equipo_desde_boleta()   set search_path = public, pg_temp;
alter function public.fn_ticket_type_crea_sync() set search_path = public, pg_temp;

-- ── Las auxiliares de `private` ─────────────────────────────────────────
-- Las tres son `IMMUTABLE` y sólo manejan jsonb con funciones del catálogo,
-- que siempre se resuelve primero. Se fijan por uniformidad.
alter function private.fn_mismo_conjunto(jsonb, jsonb) set search_path = public, pg_temp;
alter function private.fn_perms_iguales(jsonb, jsonb)  set search_path = public, pg_temp;
alter function private.fn_roles_semilla()              set search_path = public, pg_temp;

-- ── El barrido de OAuth ─────────────────────────────────────────────────
alter function public.oauth_barrer() set search_path = public, pg_temp;

-- ── Y la décima, que es un caso aparte ──────────────────────────────────
--
-- `generar_recordatorios_inapp()` **está rota desde hace tiempo y nadie lo
-- había notado**: lee e inserta en `public.recordatorio_inapp_log`, y esa
-- tabla YA NO EXISTE. Medido el 27-oct: la función está, la tabla no. Llamarla
-- hoy termina en «relation does not exist».
--
-- Encaja con lo que ya está escrito en otros dos sitios: `005_al_dia.sql` la
-- clasifica entre las tablas que «nunca entró una fila», y el README dice que
-- el ciclo de `pg_cron` y su Edge Function «están muertos» y que los
-- recordatorios salen por `scripts/cron-recordatorios.js`.
--
-- Se le fija el `search_path` igual —cuesta cero y quita el aviso—, pero lo
-- que de verdad corresponde es borrarla. No se hace aquí porque borrar algo en
-- producción es una decisión de quien manda, no de una migración de
-- endurecimiento. Cuando se decida:
--
--     drop function if exists public.generar_recordatorios_inapp();
--
alter function public.generar_recordatorios_inapp() set search_path = public, pg_temp;


-- ── Comprobación ────────────────────────────────────────────────────────
--
-- Tiene que devolver CERO filas:
--
--   select n.nspname || '.' || p.proname as sin_search_path
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname in ('public','private')
--      and p.prokind = 'f'
--      and p.proconfig is null
--      and (n.nspname, p.proname) in (
--        ('public','generar_recordatorios_inapp'), ('private','fn_roles_semilla'),
--        ('public','evento_legal_version'), ('public','oauth_barrer'),
--        ('private','fn_perms_iguales'), ('public','fn_ticket_type_crea_sync'),
--        ('public','fn_equipo_desde_boleta'), ('private','fn_mismo_conjunto'),
--        ('public','sumar_aforo_vendido'), ('public','sumar_vendidos_tipo'));
--
-- Y en el panel de Supabase, el aviso «Function Search Path Mutable» baja de
-- 10 a 0. Las funciones de `pg_trgm` (`similarity`, `gtrgm_*`, …) no se tocan:
-- son de la extensión, no nuestras, y el analizador no las marca.
--
-- ── Vuelta atrás ────────────────────────────────────────────────────────
--
-- Sin pérdida y sin tocar ningún cuerpo:
--
--   alter function public.sumar_aforo_vendido(uuid, integer) reset search_path;
--   alter function public.sumar_vendidos_tipo(uuid, integer)  reset search_path;
--   alter function public.evento_legal_version()     reset search_path;
--   alter function public.fn_equipo_desde_boleta()   reset search_path;
--   alter function public.fn_ticket_type_crea_sync() reset search_path;
--   alter function private.fn_mismo_conjunto(jsonb, jsonb) reset search_path;
--   alter function private.fn_perms_iguales(jsonb, jsonb)  reset search_path;
--   alter function private.fn_roles_semilla()              reset search_path;
--   alter function public.oauth_barrer()                   reset search_path;
--   alter function public.generar_recordatorios_inapp()    reset search_path;
--
-- ── Y el lado MySQL ─────────────────────────────────────────────────────
--
-- Esta migración NO necesita archivo en `db/migraciones/`. MySQL no tiene
-- `search_path`: la conexión abre contra una base y ahí se queda. Y de las
-- diez funciones, las de disparador y las semillas ya se van al código en la
-- fase 6 (`modules/eventos/semillas.js`, `modules/contadores/`).
--
-- La prueba `test/elEsquemaMysqlNoSeQuedaAtras.test.js` sí la va a reclamar
-- —no sabe leer qué hace cada migración, sólo cuáles están reflejadas—, así
-- que queda declarada en la cabecera de `008_la_puerta_y_la_tarjeta.sql`, en
-- el apartado de lo que no se traduce y por qué.
