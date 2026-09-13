-- 0126 · Lo que incluye la credencial, y quién se lo entregó
--
-- Nace de una petición concreta: los stands tienen dos personas y hay que
-- darles refrigerio de la mañana, almuerzo y refrigerio de la tarde, dejando
-- constancia de a quién se le entregó cada cosa.
--
-- Lo que se construye aquí NO es eso. Es la frase de la que eso es un caso:
--
--   «una credencial da derecho a N usos de algo, dentro de una ventana de
--    tiempo, y cada uso queda registrado con quién lo entregó».
--
-- La misma frase, sin una línea de código más, cubre la camiseta y el kit de
-- bienvenida, el parqueadero, el guardarropa, la bebida incluida en la VIP, el
-- material del jurado, el taller con cupo, el vale de un patrocinador en su
-- stand y la comida del personal de logística. Cada una de ésas, resuelta por
-- separado, es una tabla nueva y una pantalla nueva.
--
-- ── Lo que NO hace falta inventar ──────────────────────────────────────
--
-- Las dos personas del stand ya existen. La 0118 hizo exactamente eso:
-- `ticket_puestos` es una persona dentro de una boleta, con su nombre, su
-- correo, su documento y SU PROPIO QR, que además rota si el puesto se
-- transfiere. Un tipo de boleta `es_expositor` con dos puestos en modo
-- `anfitrion` es el stand con sus dos acreditados, y el QR de cada uno ya se
-- emite y ya se verifica.
--
-- Por eso aquí no aparece ninguna tabla de «personas del stand». El titular de
-- un derecho es un puesto, o la boleta entera cuando el derecho es del grupo.

-- ── 1 · El derecho ─────────────────────────────────────────────────────
--
-- El catálogo: qué incluye una credencial en este evento.

create table if not exists public.derechos (
  id          uuid primary key default gen_random_uuid(),
  evento_id   uuid not null references public.eventos(id) on delete cascade,

  nombre      text not null,          -- «Almuerzo», «Kit de bienvenida»
  descripcion text,

  -- De quién es el derecho. La pregunta que hay que hacerle a quien organiza
  -- ANTES de configurarlo, porque decide quién se queda sin comer:
  --
  --   persona  cada acreditado tiene el suyo. Dos personas en el stand, dos
  --            almuerzos, y el segundo no se lo puede comer el primero.
  --   grupo    son N del stand y los usa quien esté en la caseta a esa hora.
  --
  -- Las dos son legítimas y ninguna sirve como valor único: el almuerzo suele
  -- ser por persona, y las dos botellas de agua de la mesa, del grupo.
  titular     text not null default 'persona'
              check (titular in ('persona', 'grupo')),

  -- Cada cuánto se renueva.
  --
  --   ventana  uno (o `usos`) por cada franja: el almuerzo de cada día.
  --   total    `usos` en todo el evento: la camiseta, el kit.
  cadencia    text not null default 'ventana'
              check (cadencia in ('ventana', 'total')),

  -- Cuántos por titular y por ventana. Casi siempre 1; es 3 en «tres bebidas
  -- incluidas». Ver la nota sobre `uso_num`: este número lo hace cumplir el
  -- motor, no la aplicación.
  usos        int not null default 1 check (usos > 0),

  -- A qué boletas aplica. Vacío es «a todas las del evento», que es lo que se
  -- quiere cuando el almuerzo va incluido para todo el mundo. Con ids dentro,
  -- sólo esos tipos.
  aplica_tipos jsonb not null default '[]'::jsonb,

  activo      boolean not null default true,
  orden       int not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists derechos_evento_idx
  on public.derechos (evento_id, activo, orden);

-- ── 2 · La ventana ─────────────────────────────────────────────────────
--
-- «Almuerzo día 1, de 12:00 a 15:00». Filas y no columnas: un evento de tres
-- días son nueve ventanas y no un rediseño del esquema.
--
-- Y no se derivan de la agenda, a propósito. La agenda dice cuándo está
-- programado el almuerzo; la ventana dice hasta cuándo se puede entregar, que
-- en la práctica es más ancho y lo decide quien sirve la comida.

create table if not exists public.derecho_ventanas (
  id          uuid primary key default gen_random_uuid(),
  derecho_id  uuid not null references public.derechos(id) on delete cascade,
  evento_id   uuid not null references public.eventos(id) on delete cascade,

  nombre      text not null,          -- «Almuerzo día 1»
  inicio      timestamptz,
  fin         timestamptz,

  -- Lo que la cocina necesita saber: cuántas raciones hay. `null` es sin tope.
  -- No lo hace cumplir un índice —es un recuento, no una unicidad— y por eso
  -- pasarse de cupo advierte pero no bloquea: quedarse con comida en la mano y
  -- una persona delante sin poder entregarla es peor que servir 201 de 200.
  cupo        int check (cupo is null or cupo >= 0),

  orden       int not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists derecho_ventanas_derecho_idx
  on public.derecho_ventanas (derecho_id, orden);
create index if not exists derecho_ventanas_evento_idx
  on public.derecho_ventanas (evento_id, inicio);

-- ── 3 · El consumo ─────────────────────────────────────────────────────
--
-- La fila que se escribe al entregar. Es el registro de un HECHO, y por eso no
-- va en `tareas`: el tablero del equipo es pendiente/hecho y asignado a
-- alguien, no un log de cuatrocientas entregas que además no sabría responder
-- «¿esta persona ya almorzó?» sin recorrerlo entero.

create table if not exists public.derecho_consumos (
  id          uuid primary key default gen_random_uuid(),
  evento_id   uuid not null references public.eventos(id) on delete cascade,
  derecho_id  uuid not null references public.derechos(id) on delete cascade,

  -- `null` cuando la cadencia es 'total' (la camiseta no tiene franja).
  ventana_id  uuid references public.derecho_ventanas(id) on delete cascade,

  -- Quién lo recibió. Siempre hay boleta; el puesto está cuando el derecho es
  -- por persona, que es la mayoría. Dos columnas y no una polimórfica porque
  -- las dos son claves foráneas de verdad: el día que una boleta se anule,
  -- queremos que sus consumos se vayan con ella.
  ticket_id   uuid not null references public.tickets(id) on delete cascade,
  puesto_id   uuid references public.ticket_puestos(id) on delete cascade,

  -- Cuál de los `usos` es éste: 1, 2, 3. En un derecho de uno —casi todos—
  -- siempre vale 1. Está aquí para que el tope lo imponga el índice único y no
  -- un `if`: ver la sección 4, que es el motivo de toda esta migración.
  uso_num     int not null default 1 check (uso_num > 0),

  -- Quién lo entregó. Es la mitad de la petición original —«que se sepa a
  -- quién se le entregaron»— y la que se pierde si esto se resuelve con una
  -- casilla en una hoja de cálculo.
  operador_id uuid,

  -- La hora REAL de la entrega, que no es la hora en que llegó al servidor
  -- cuando la tableta estaba sin señal. Mismo criterio que
  -- `lib/horaDeEscaneo.js` en la puerta.
  entregado_at timestamptz not null default now(),

  -- `qr`     leyendo la credencial, que es como debe ser;
  -- `manual` buscando por nombre o documento, porque siempre llega quien
  --          perdió el teléfono y hay que entregarle igual;
  -- `cola`   escrito al vaciarse la cola sin conexión.
  --
  -- Se separan para que una auditoría pueda preguntar cuántas entregas se
  -- hicieron sin leer un QR, que es justo donde se cuela el error y el abuso.
  origen      text not null default 'qr'
              check (origen in ('qr', 'manual', 'cola')),

  nota        text,
  created_at  timestamptz not null default now()
);

create index if not exists derecho_consumos_evento_idx
  on public.derecho_consumos (evento_id, entregado_at desc);
create index if not exists derecho_consumos_ventana_idx
  on public.derecho_consumos (ventana_id, entregado_at desc);
-- «¿Esta persona ya comió?», que se pregunta una vez por escaneo con la fila
-- del almuerzo esperando.
create index if not exists derecho_consumos_titular_idx
  on public.derecho_consumos (derecho_id, coalesce(puesto_id, ticket_id));

-- ── 4 · Lo único que de verdad importa ─────────────────────────────────
--
-- El «uno por persona por ventana» va aquí, en el motor, y no en un `if` de la
-- aplicación. No es elegancia: es la misma lección de la 0117 con la doble
-- venta y de la 0125 con el aforo.
--
--   Un `if` LEE «¿ya almorzó?» y luego ESCRIBE «almorzó». Entre las dos cosas
--   cabe otra fila, y en la fila del almuerzo eso pasa de verdad: hay dos o
--   tres tabletas escaneando a la vez, y encima la cola sin conexión se vacía
--   sola cuando vuelve la red y reescribe entregas de hace veinte minutos.
--
-- Dos almuerzos a la misma persona no fallan ni saltan: sale un número
-- tranquilo y equivocado, y la comida se acaba antes de tiempo con gente
-- todavía en la fila.
--
-- Con `uso_num` dentro de la clave, el tope de un derecho de N usos también lo
-- impone el motor: la aplicación calcula el siguiente número y, si dos lo
-- calculan a la vez, el segundo choca contra el índice y reintenta. El derecho
-- de tres bebidas no puede servir cuatro aunque el código tenga un fallo.

create unique index if not exists derecho_consumo_unico_por_ventana
  on public.derecho_consumos (derecho_id, ventana_id, coalesce(puesto_id, ticket_id), uso_num)
  where ventana_id is not null;

create unique index if not exists derecho_consumo_unico_total
  on public.derecho_consumos (derecho_id, coalesce(puesto_id, ticket_id), uso_num)
  where ventana_id is null;

-- `coalesce(puesto_id, ticket_id)` es lo que hace que `titular` funcione sin
-- dos juegos de índices: en un derecho por persona el titular es el puesto, y
-- en uno de grupo el puesto va nulo y el titular pasa a ser la boleta entera.
-- Las dos formas caben en la misma regla.

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select tablename from pg_tables where schemaname='public'
--    and tablename in ('derechos','derecho_ventanas','derecho_consumos');
--
--   select indexname from pg_indexes where schemaname='public'
--    and tablename='derecho_consumos';
--   -- tienen que estar los dos 'derecho_consumo_unico_*'
--
--   -- Y que la regla es de verdad. Con un derecho y una ventana creados:
--   insert into public.derecho_consumos (evento_id, derecho_id, ventana_id, ticket_id, puesto_id)
--   values (:ev, :der, :ven, :tk, :puesto);
--   -- repetir la misma línea: la segunda tiene que salir con
--   -- «duplicate key value violates unique constraint». Si entra, el índice no
--   -- está y esta migración no sirve para nada.
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   drop table if exists public.derecho_consumos;
--   drop table if exists public.derecho_ventanas;
--   drop table if exists public.derechos;
--
-- Sin riesgo: tres tablas nuevas y ninguna columna tocada en lo que ya existe.
--
-- ── Y lo que hace falta DESPUÉS ────────────────────────────────────────
--
-- Esta migración no enciende nada por sí sola: sin código que cree derechos,
-- las tablas se quedan vacías y la plataforma sigue exactamente igual. Lo que
-- falta —el endpoint de entrega, el permiso `entregar`, la pantalla y el
-- reporte— está en `docs/DERECHOS.md`.
