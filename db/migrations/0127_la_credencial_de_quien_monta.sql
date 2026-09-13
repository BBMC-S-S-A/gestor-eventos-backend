-- 0127 · La credencial de quien monta, y los QR que ya se repartieron
--
-- Dos peticiones que resultaron ser la misma cosa: qué hace que una credencial
-- abra una puerta.
--
-- ── 1 · Quién entra al montaje ─────────────────────────────────────────
--
-- Antes del evento hay dos días de montaje: llegan cuadrillas a armar los
-- stands, y el recinto se llena de herramienta suelta. Hoy no hay forma de
-- distinguir a quien viene a trabajar de quien pasaba por ahí, y el riesgo no
-- es teórico: es un galpón abierto con taladros dentro.
--
-- La tentación es meterlos en el equipo del evento. No sirve: `event_members`
-- es gente con CUENTA y permisos del panel —está para operar GESTEK, no para
-- entrar al recinto—, y obligaría a pedirle correo y contraseña a sesenta
-- montajistas que no van a abrir el panel jamás.
--
-- Un montajista no es staff: es una persona acreditada con una credencial de
-- alcance limitado. Y esa forma ya existe desde la 0118 — `ticket_puestos` es
-- una persona con nombre, documento y QR propio. Lo que le falta a esa tabla
-- para servir aquí son tres cosas, y son las de esta migración:
--
--   · que la credencial CADUQUE (si no, el montajista del lunes entra gratis
--     el sábado, y la boleta del sábado abre el galpón el lunes);
--   · que alguien RESPONDA por esa persona (registrarse solo no es estar
--     autorizado — si lo fuera, el que se cuela se registra y ya está);
--   · que la puerta pueda COMPARARLA con la cédula (nombre, documento y foto,
--     porque la comprobación real no es «este QR vale» sino «este carné es de
--     esta cara»).
--
-- ── 2 · Los QR que ya se repartieron ───────────────────────────────────
--
-- Una boleta se puede reenviar: el correo se pierde, la persona pide que se lo
-- manden otra vez, y cada envío firma un token nuevo. Todos son del mismo
-- `tid`, así que en la puerta de la boleta todos valen — y así tiene que ser:
-- quien imprimió el primer correo entra con él.
--
-- Con los PUESTOS eso deja de cumplirse, y por una razón buena: al transferir
-- un puesto se rota su credencial, y la anterior tiene que morir o la reventa
-- es un cambio de nombre. Pero la comparación que lo consigue —el token
-- presentado contra el guardado— no distingue las dos cosas: mata también el
-- QR de un reenvío legítimo, y esa persona llega a la puerta con un correo del
-- sistema que ya no abre.
--
-- Lo que faltaba es distinguir REEMITIR de INVALIDAR. Con una generación, la
-- diferencia se vuelve explícita: reenviar firma otro token de la MISMA
-- generación y los dos valen; transferir sube la generación y todo lo anterior
-- muere de golpe. Sin tocar ningún QR ya emitido: los de hoy no llevan
-- generación, y «sin generación» es la generación 0, que es la que tienen
-- todos los puestos existentes.

-- ── 1 · Qué credencial es ésta y hasta cuándo vale ─────────────────────
--
-- Va en el tipo de boleta y no en el evento: en el mismo evento conviven la
-- credencial de montaje (lunes y martes), la de expositor (toda la semana) y
-- la del público (sólo el sábado).

alter table public.ticket_types
  -- Desde cuándo y hasta cuándo ABRE esta credencial. No confundir con
  -- `venta_hasta`, que es hasta cuándo se VENDE: una boleta se vende en
  -- septiembre para diciembre. Nulo es «sin límite», que es lo que hacen hoy
  -- todas las boletas y por eso nada cambia al aplicar esto.
  add column if not exists vigencia_desde timestamptz,
  add column if not exists vigencia_hasta timestamptz,

  -- Registrarse no es estar autorizado.
  --
  -- Con esto en `true`, el puesto nace sin credencial y no la tiene hasta que
  -- alguien del evento lo aprueba. Es lo único que impide que el control se
  -- convierta en autoservicio, que es como se cae este tipo de acreditación:
  -- se pide el registro, se cumple la letra, y quien quiere entrar se registra.
  add column if not exists requiere_autorizacion boolean not null default false,

  -- Un tipo que NO se vende pero SÍ se emite.
  --
  -- Hoy lo único que lo esconde del público es `activo`, y desactivarlo lo
  -- apaga entero: tampoco se puede emitir. Así que una credencial interna —la
  -- de montaje, la de prensa, la de proveedores— o sale a la venta en la
  -- landing o no existe. Las dos están mal.
  add column if not exists visible_publico boolean not null default true;

comment on column public.ticket_types.vigencia_desde is
  'Desde cuándo ABRE esta credencial (distinto de venta_hasta, que es hasta cuándo se vende). Nulo = sin límite.';

-- ── 2 · La persona acreditada ──────────────────────────────────────────

alter table public.ticket_puestos
  -- Para que la puerta pueda comparar con la cédula. El documento ya estaba
  -- (0118); faltaba con qué contrastar la cara y a quién llamar.
  add column if not exists foto_url text,
  add column if not exists telefono text,

  -- Quién responde por esta persona. Es la pregunta que se hace cuando algo
  -- desaparece, y sin estas dos columnas la respuesta es «no sabemos».
  --
  -- `autorizado_por` no es una clave foránea a propósito: quien acredita a su
  -- cuadrilla es muchas veces el expositor desde su enlace público, y ése no
  -- tiene cuenta. Se guarda quién dijo ser, igual que en
  -- `puesto_transferencias`.
  add column if not exists autorizado_at timestamptz,
  add column if not exists autorizado_por text,

  -- La generación de su credencial. Ver el apartado 2 de la cabecera.
  --
  -- Sube SÓLO al transferir. Reenviar el correo, reimprimir la escarapela o
  -- volver a firmar por lo que sea deja la generación quieta, y por eso los
  -- QR anteriores siguen abriendo.
  add column if not exists credencial_gen integer not null default 0;

comment on column public.ticket_puestos.credencial_gen is
  'Sube al transferir el puesto, y sólo entonces. Un QR abre si su generación es la actual; los QR sin generación (los de antes de la 0127) son la 0.';

-- El listado de «a quién falta autorizar» es la pantalla que se mira cada diez
-- minutos el día antes del montaje, con cien filas y creciendo.
create index if not exists ticket_puestos_por_autorizar_idx
  on public.ticket_puestos (evento_id, autorizado_at)
  where autorizado_at is null;

-- ── 3 · La puerta que abre a sus horas ─────────────────────────────────
--
-- No hay columna nueva: `zonas.reglas` es un jsonb y la 0098 dejó escrito, en
-- su propio comentario, que lo siguiente que iba a hacer falta era «un horario
-- («esta puerta abre a las 8»)». Esto es eso, y por eso no migra nada: es una
-- clave más dentro de un objeto que ya existe.
--
--   reglas.horario = { "desde": "2026-09-14T06:00:00Z", "hasta": "2026-09-15T22:00:00Z" }
--
-- Se documenta aquí para que la clave tenga un sitio donde estar escrita.

comment on column public.zonas.reglas is
  'Lo que una puerta comprueba al abrirse: tipos (ids de ticket_types admitidos), staff (ids de perfiles), horario ({desde, hasta} ISO). Vacío = sin restricción.';

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select column_name from information_schema.columns
--    where table_name='ticket_types'
--      and column_name in ('vigencia_desde','vigencia_hasta','requiere_autorizacion','visible_publico');
--
--   select column_name from information_schema.columns
--    where table_name='ticket_puestos'
--      and column_name in ('foto_url','telefono','autorizado_at','autorizado_por','credencial_gen');
--
--   -- Y que NADA de lo que ya existe cambió de comportamiento:
--   select count(*) from public.ticket_types
--    where requiere_autorizacion or not visible_publico
--      or vigencia_desde is not null or vigencia_hasta is not null;
--   -- tiene que salir 0: ninguna boleta de hoy caduca ni pide autorización.
--
--   select count(*) from public.ticket_puestos where credencial_gen <> 0;
--   -- tiene que salir 0: todos los QR ya emitidos son de la generación 0 y
--   -- siguen abriendo.
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   alter table public.ticket_puestos
--     drop column if exists foto_url, drop column if exists telefono,
--     drop column if exists autorizado_at, drop column if exists autorizado_por,
--     drop column if exists credencial_gen;
--   alter table public.ticket_types
--     drop column if exists vigencia_desde, drop column if exists vigencia_hasta,
--     drop column if exists requiere_autorizacion, drop column if exists visible_publico;
--
-- Sin riesgo: siete columnas con valor por defecto y ningún dato tocado. Todas
-- las boletas existentes siguen abriendo exactamente igual — no caducan, no
-- piden autorización, y sus puestos son de la generación 0.
