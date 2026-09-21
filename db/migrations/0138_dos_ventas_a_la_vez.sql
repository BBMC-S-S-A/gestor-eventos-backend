-- 0138 · Dos ventas a la vez
--
-- ── El contador que se queda corto cuando el evento va bien ────────────
--
-- Los contadores del aforo se llevan leyendo y escribiendo desde Node:
--
--   select aforo_vendido from eventos where id = ...      -- lee 4.000
--   update eventos set aforo_vendido = 4.000 + 1          -- escribe 4.001
--
-- Entre esas dos líneas cabe otra venta. Las dos leen 4.000, las dos escriben
-- 4.001, y una de las dos personas deja de existir para el contador. No falla
-- nada, no hay error en ningún log: simplemente el número va quedándose atrás.
--
-- Y se queda atrás justo cuando importa. Con una venta cada diez minutos no
-- pasa nunca; con doscientas en una hora —la mañana de un festival— pasa todo
-- el rato. El contador miente más cuanto mejor va el evento, que es la peor
-- forma posible de mentir.
--
-- ── La prueba, de FESTECH IBAGUÉ ───────────────────────────────────────
--
-- El mismo patrón está en `ticket_types.vendidos`, y ahí se ve aislado porque
-- cada tipo de boleta tiene su propio ritmo de venta:
--
--   Registro Festech 2026     contador 4.263   real 4.424   -161
--   PijaoTech                 contador    35   real    35      0
--   PijaoHub DemoDay          contador    24   real    24      0
--   Mujeres en la ciencia     contador     2   real     2      0
--
-- Sólo se desfasa el de alto volumen. Los tres de poco tráfico están exactos.
-- Eso no es un camino de código que falte —esos fallarían igual con poca
-- carga—: es concurrencia, y es la firma de una carrera de lectura/escritura.
--
-- En `eventos.aforo_vendido` el mismo evento marcaba 4.273 con 4.485 boletas
-- emitidas: 212 personas que el reporte final no le contaba al organizador.
--
-- ── Lo que hace esta migración ─────────────────────────────────────────
--
--   1. Dos funciones que suman DENTRO de la base, en una sola sentencia. Un
--      `update ... set x = x + n` toma el cerrojo de la fila, así que dos
--      llamadas a la vez se ponen en fila solas y ninguna pisa a la otra. Es
--      la misma cuenta, hecha donde está el dato en vez de a dos viajes de
--      distancia.
--
--   2. Un recálculo, una vez, para cerrar el desfase que ya existe. No se
--      puede deducir cuánto se perdió, así que se cuenta desde las boletas,
--      que son la verdad: la fila existe o no existe.
--
-- ── Lo que NO hace, y por qué ──────────────────────────────────────────
--
-- No pone un disparador que mantenga el contador solo. Sería más robusto y es
-- la tentación evidente, pero cambia dónde se decide una regla de negocio
-- —qué estado ocupa aforo, cuánta gente entra con una boleta— y hoy eso vive
-- en `routes/clientes.js` y `lib/cuantasPersonas.js`, en un idioma que el
-- equipo lee. Partirlo entre Node y PL/pgSQL es cómo se acaba con dos reglas
-- que discrepan. Aquí se arregla la atomicidad y nada más.

begin;

-- ── 1. Sumar sin carreras ──────────────────────────────────────────────
--
-- `greatest(0, ...)` es el mismo suelo que ya ponía Node con `Math.max(0, …)`:
-- un contador negativo no significa nada y ensucia todo lo que lo lea.
-- Devuelven el valor nuevo por si quien llama quiere comprobarlo.

create or replace function public.sumar_aforo_vendido(p_evento uuid, p_delta int)
returns int
language sql
as $$
  update eventos
     set aforo_vendido = greatest(0, coalesce(aforo_vendido, 0) + p_delta)
   where id = p_evento
  returning aforo_vendido;
$$;

create or replace function public.sumar_vendidos_tipo(p_tipo uuid, p_delta int)
returns int
language sql
as $$
  update ticket_types
     set vendidos = greatest(0, coalesce(vendidos, 0) + p_delta)
   where id = p_tipo
  returning vendidos;
$$;

comment on function public.sumar_aforo_vendido(uuid, int) is
  'Suma atómica al aforo del evento. Ver 0138: leer y escribir desde Node perdía ventas simultáneas.';
comment on function public.sumar_vendidos_tipo(uuid, int) is
  'Suma atómica a las unidades vendidas de un tipo de boleta. Ver 0138.';

-- Sólo el backend. PostgREST publica como RPC toda función del esquema
-- `public`, así que sin esto cualquiera con la llave pública podría llamarlas
-- desde el navegador y mover el aforo de un evento ajeno. El backend entra con
-- `service_role`, que no pasa por aquí.
revoke execute on function public.sumar_aforo_vendido(uuid, int) from public, anon, authenticated;
revoke execute on function public.sumar_vendidos_tipo(uuid, int)  from public, anon, authenticated;
grant  execute on function public.sumar_aforo_vendido(uuid, int) to service_role;
grant  execute on function public.sumar_vendidos_tipo(uuid, int)  to service_role;

-- ── 2. Cerrar el desfase que ya existe ─────────────────────────────────
--
-- Los estados son los de `ESTADOS_QUE_OCUPAN` en `routes/clientes.js`:
-- 'emitido', 'pagado' y 'usado'. Una boleta reembolsada o anulada no ocupa
-- sitio, y por eso no cuenta aquí — igual que el código no la cuenta cuando
-- cambia de estado.

-- 2a. El aforo cuenta PERSONAS, no boletas. Una mesa de ringside es una boleta
--     y cuatro personas (ver `lib/cuantasPersonas.js`): sumar de uno en uno
--     dejaría al organizador creyendo que le quedan sitios que no existen.
--     `coalesce(e.capacidad, 1)` es la misma regla que aplica Node cuando la
--     boleta no tiene silla asignada, que es la inmensa mayoría.
with personas as (
  select t.evento_id,
         sum(coalesce(e.capacidad, 1))::int as n
    from tickets t
    left join espacio_reservas r on r.ticket_id = t.id and r.estado = 'vendido'
    left join espacios e         on e.id = r.espacio_id
   where t.estado in ('emitido', 'pagado', 'usado')
   group by t.evento_id
)
update eventos ev
   set aforo_vendido = p.n
  from personas p
 where p.evento_id = ev.id
   and coalesce(ev.aforo_vendido, 0) <> p.n;

-- 2b. Y los eventos cuyo contador quedó por encima de cero sin ninguna boleta
--     que lo sostenga: el `update` de arriba no los toca porque no salen en el
--     `group by`. Pasa cuando se borran boletas —que no es anularlas— y nadie
--     bajó el contador.
update eventos ev
   set aforo_vendido = 0
 where coalesce(ev.aforo_vendido, 0) <> 0
   and not exists (
     select 1 from tickets t
      where t.evento_id = ev.id
        and t.estado in ('emitido', 'pagado', 'usado')
   );

-- 2c. Las unidades vendidas de cada tipo. Aquí sí se cuentan BOLETAS: el cupo
--     de un tipo se agota por unidades («quedan 3 mesas») mientras el aforo
--     del recinto se llena por personas. Son dos cuentas distintas y
--     confundirlas rompe una de las dos.
with unidades as (
  select tt.id,
         (select count(*) from tickets t
           where t.ticket_type_id = tt.id
             and t.estado in ('emitido', 'pagado', 'usado'))::int as n
    from ticket_types tt
)
update ticket_types tt
   set vendidos = u.n
  from unidades u
 where u.id = tt.id
   and coalesce(tt.vendidos, 0) <> u.n;

commit;

-- ── Comprobar ──────────────────────────────────────────────────────────
--
-- Después de aplicarla, esto NO debe devolver ninguna fila:
--
--   select e.titulo, e.aforo_vendido,
--          (select count(*) from tickets t
--            where t.evento_id = e.id
--              and t.estado in ('emitido','pagado','usado')) as boletas
--     from eventos e
--    where e.aforo_vendido <> (select coalesce(sum(coalesce(es.capacidad,1)),0)
--                                from tickets t
--                                left join espacio_reservas r
--                                       on r.ticket_id = t.id and r.estado='vendido'
--                                left join espacios es on es.id = r.espacio_id
--                               where t.evento_id = e.id
--                                 and t.estado in ('emitido','pagado','usado'));
