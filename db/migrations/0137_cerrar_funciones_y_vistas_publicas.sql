-- 0137 · Cerrar lo que la llave pública podía tocar sin pasar por el backend
--
-- Hallado el 19-sep con el analizador de seguridad de Supabase, y comprobado
-- con la llave anónima que viaja en el propio frontend (la tiene cualquiera):
--
--   · `retener_espacio` / `liberar_espacio` (0117) y `promocion_consumir` son
--     SECURITY DEFINER y se podían llamar por /rest/v1/rpc sin sesión o con
--     cualquier sesión. Quien quisiera podía apartar todas las sillas de un
--     evento sin pagar, o gastar los usos de un código de descuento.
--     Sólo las llama el backend, con la llave de servicio.
--   · `zz_festech_sin_boleta` (vista de diagnóstico del 17-sep, SECURITY
--     DEFINER) y `zz_rollback_0126b_entregar` (respaldo de la 0126b) estaban
--     abiertas a anon: nombre, correo y código de boleta de ~3.600 personas.
--     El 19-sep se les quitó el acceso a mano antes de esta migración; aquí se
--     deja escrito y se borran, porque ya cumplieron su función.
--
-- El backend usa `service_role`, que sigue pudiendo todo.

revoke execute on function public.retener_espacio(uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.liberar_espacio(uuid, text) from public, anon, authenticated;
revoke execute on function public.promocion_consumir(uuid) from public, anon, authenticated;
grant execute on function public.retener_espacio(uuid, uuid, text, integer) to service_role;
grant execute on function public.liberar_espacio(uuid, text) to service_role;
grant execute on function public.promocion_consumir(uuid) to service_role;

-- `networking_expositores` y `torneo_equipos` tenían una política de lectura
-- `true` para todos: por /rest/v1 se leían correo, teléfono y NIT de cada
-- empresa aunque hubiera apagado `contacto_publico`, y el correo de contacto de
-- cada equipo. El backend ya filtra eso en sus rutas públicas; el navegador no
-- lee estas tablas directamente (comprobado en src/), así que se les quita la
-- lectura a los roles públicos y el backend sigue igual.
revoke select on public.networking_expositores from anon, authenticated;
revoke select on public.torneo_equipos from anon, authenticated;

-- Borrar los dos objetos temporales: PENDIENTE de que Juan lo confirme (es
-- irreversible y la tabla es el respaldo de la 0126b). Mientras tanto ya no
-- los puede leer nadie más que el backend.
-- drop view if exists public.zz_festech_sin_boleta;
-- drop table if exists public.zz_rollback_0126b_entregar;
