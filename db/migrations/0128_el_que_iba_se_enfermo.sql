-- 0128 · El que iba se enfermó, va el primo
--
-- ── El punto donde este control se cae ─────────────────────────────────
--
-- La 0127 dejó la acreditación del montaje en pie: cada persona con nombre,
-- documento y foto, y alguien del evento respondiendo por ella. Funciona el
-- primer día.
--
-- El segundo, a las seis de la mañana, en la puerta del galpón, pasa esto:
--
--   «El que iba se enfermó. Vino el primo.»
--
-- Y ahí el sistema no tiene nada que ofrecer. El primo no está acreditado, la
-- persona que sí lo está no va a venir, y quien organiza no llega hasta las
-- nueve. Las tres salidas posibles son:
--
--   · el primo no entra, y el stand no se monta;
--   · el primo entra CON EL QR DEL OTRO, que es exactamente lo que este
--     control existía para impedir;
--   · el guardia lo deja pasar de palabra, y no queda registro de nadie.
--
-- Las tres pasan de verdad, y la tercera es la que gana siempre. Un control que
-- no tiene respuesta para el caso normal se convierte en un trámite que la
-- gente rodea, y entonces deja de proteger nada — con el coste de haberlo
-- montado.
--
-- ── Qué se añade, y qué NO ─────────────────────────────────────────────
--
-- Nada de una excepción para saltarse la autorización. Lo que se añade es
-- quién más puede darla: **el responsable de la boleta**, que es quien tiene su
-- código —el expositor del stand— y que a su vez ya fue acreditado por el
-- evento.
--
-- La cadena no se rompe, se alarga un eslabón: el evento responde por el stand,
-- y el stand responde por su cuadrilla. Es lo que pasa en la realidad de todas
-- formas; la diferencia es que ahora queda escrito quién respondió.
--
-- Va apagado por defecto. Un evento que quiera que TODO lo apruebe la
-- organización lo deja como está y no cambia nada.
--
-- ── Y la credencial del que no vino ────────────────────────────────────
--
-- No hace falta nada nuevo: sustituir es transferir el puesto, que ya existe
-- desde la 0118. Sube la generación (0127), y con eso el QR del que se enfermó
-- deja de abrir en el momento en que se acredita al primo. Sin esa parte, la
-- sustitución sería sumar una persona en vez de cambiarla — dos credenciales
-- buenas para un puesto.

alter table public.ticket_types
  -- Quién puede autorizar a una persona de esta boleta.
  --
  --   evento       sólo la organización (lo de la 0127, y el valor por defecto)
  --   responsable  también quien tiene el código de la boleta
  --
  -- Un texto y no un booleano porque lo siguiente que van a pedir es un tercer
  -- caso —«el jefe de montaje, que no es ni el evento ni el stand»— y un
  -- booleano obliga a migrar para añadirlo.
  add column if not exists autoriza text not null default 'evento'
  check (autoriza in ('evento', 'responsable'));

comment on column public.ticket_types.autoriza is
  'Quién puede autorizar a las personas de esta boleta: sólo el evento, o también quien tiene el código de la boleta (para sustituciones en el momento). Ver 0128.';

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   select autoriza, count(*) from public.ticket_types group by 1;
--   -- tiene que salir 'evento' para todas: nadie gana un permiso al aplicar
--   -- esto.
--
-- ── Vuelta atrás ───────────────────────────────────────────────────────
--
--   alter table public.ticket_types drop column if exists autoriza;
--
-- Sin riesgo: una columna con valor por defecto, y el valor por defecto es el
-- comportamiento de la 0127.
