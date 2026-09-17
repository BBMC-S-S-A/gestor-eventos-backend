-- 0129 · El NIT de quien se sienta en la rueda
--
-- ── Qué se pidió y qué faltaba de verdad ────────────────────────────────
--
-- Lo pedido para la rueda de negocios: que una empresa se dé de alta como
-- comprador o como vendedor, con **nombre, NIT y sector**, y una descripción
-- que cambia según el papel —el producto si vende, el reto si compra—.
--
-- De esas cinco cosas, cuatro ya existen. Se comprobó contra la base real, no
-- contra el volcado de `db/esquema/`, que es otra cosa y puede ir por detrás:
--
--   · `nombre`      — está desde siempre.
--   · `rol`         — la puso la 0105. Nace en `comprador`.
--   · sector        — es `categoria_negocio`. No es una lectura libre: la
--                     `lib/heredarRespuestas.js` ya declara «sector» como su
--                     PRIMER sinónimo, y hay una prueba que lo afirma. La
--                     columna está vacía en las 6 filas de producción porque
--                     nadie la ha llenado todavía, no porque nada la escriba:
--                     la ficha pública ya tiene su campo, rotulado «Categoría».
--                     Lo que cambia con esto es el rótulo, no el almacén.
--   · descripción   — `descripcion` ya está. Que diga «del producto» o «del
--                     reto» es cosa del rótulo según `rol`, no de dos columnas.
--                     Dos columnas obligarían a decidir qué pasa cuando alguien
--                     cambia de papel, y la respuesta sería perder lo escrito.
--
-- Así que falta **una sola**: el NIT.
--
-- ── Por qué `text` y no un número ──────────────────────────────────────
--
-- Un NIT colombiano no es una cantidad: no se suma, y tiene dígito de
-- verificación, que a veces se escribe pegado con guion («900123456-7») y a
-- veces aparte. Guardarlo como número pierde el guion, pierde los ceros a la
-- izquierda de un documento extranjero, y obliga a decidir un formato el día
-- que llegue una empresa de fuera. Se guarda como lo escribió quien lo escribió.
--
-- ── Por qué se puede dejar vacío ────────────────────────────────────────
--
-- Nullable y sin default, a propósito. Hay 6 fichas en producción y ninguna
-- tiene NIT: ponerlo obligatorio ahora exigiría inventarles un valor, y un NIT
-- inventado en la ficha de una empresa es peor que un hueco — el hueco se ve,
-- el dato falso no. Si algún día una rueda concreta lo quiere obligatorio, eso
-- es una regla del evento, no de la tabla.
--
-- Y sin `unique`: la misma empresa puede tener ficha en dos eventos distintos,
-- que es lo normal. Si alguna vez hace falta impedir el duplicado, es único
-- por `(evento_id, nit)`, no por `nit` a secas — y hoy no hace falta.

alter table public.networking_expositores
  add column if not exists nit text;

comment on column public.networking_expositores.nit is
  'NIT o documento de la empresa, tal como lo escribió quien lo escribió (con o sin dígito de verificación). Opcional: hay fichas sin él y un NIT inventado es peor que un hueco.';

-- El sector ya vivía aquí, sin que la columna lo dijera. Se deja escrito para
-- que la próxima persona no vuelva a buscar una columna `sector` que no existe.
comment on column public.networking_expositores.categoria_negocio is
  'El SECTOR de la empresa (agro, software, turismo…). Se llama así por historia; `lib/heredarRespuestas.js` ya trata «sector» como su sinónimo principal. En el panel se rotula «Sector».';

-- ── Comprobación ─────────────────────────────────────────────────────────
--
--   select count(*) as filas, count(nit) as con_nit
--     from public.networking_expositores;
--
-- Debe dar las filas que haya y `con_nit = 0`: la columna nace vacía y no
-- toca ninguna ficha existente.
--
-- ── Rollback ─────────────────────────────────────────────────────────────
--
-- Reversible sin pérdida mientras nadie haya escrito un NIT. En cuanto se
-- empiece a llenar, este `drop` SÍ pierde datos —los NIT escritos— y entonces
-- deja de ser un rollback y pasa a ser un borrado.
--
--   alter table public.networking_expositores drop column if exists nit;
