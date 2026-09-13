-- 0125 · El vaivén es de cada persona, no de la mesa
--
-- ── Lo que estaba roto ─────────────────────────────────────────────────
--
-- `ticket_movimientos` lleva el ir y venir de una boleta: entró, salió, volvió
-- a entrar. Sin `tipo` explícito, el reingreso ALTERNA según el último
-- movimiento de esa boleta — y eso, con una boleta de una persona, es
-- exactamente lo correcto.
--
-- Con una mesa de cuatro deja de serlo, y de la peor manera. Los cuatro
-- comparten boleta, así que el escáner alterna entre ellos:
--
--   persona 1 escanea → no hay nada → ENTRADA   (dentro: 1)
--   persona 2 escanea → la última fue entrada → SALIDA    (dentro: 0)
--   persona 3 escanea → la última fue salida  → ENTRADA   (dentro: 1)
--   persona 4 escanea → ENTRADA otra vez no: SALIDA       (dentro: 0)
--
-- Cuatro personas entrando al recinto y el aforo de la zona diciendo que no
-- hay nadie. No falla nada ni salta ningún error: el tablero enseña un número
-- tranquilo y equivocado, que es el peor modo de fallo para un dato que existe
-- para decidir si se cierra una puerta.
--
-- ── Qué cambia ─────────────────────────────────────────────────────────
--
-- El movimiento pasa a poder decir DE QUIÉN es. Con `puesto_id`, el vaivén se
-- lleva por persona: cada uno de los cuatro entra y sale por su cuenta, y el
-- aforo suma cuatro porque son cuatro filas de `cantidad` 1.
--
-- Es una columna opcional y nada la exige: una boleta de una persona —el 99 %
-- de las que se venden— sigue escribiendo exactamente las mismas filas que
-- antes, con `puesto_id` en null. El histórico anterior a esta migración
-- también se queda como está y se sigue leyendo igual.

alter table public.ticket_movimientos
  add column if not exists puesto_id uuid
  references public.ticket_puestos(id) on delete cascade;

-- La consulta del vaivén es «el último movimiento de ESTE puesto», y se hace
-- una vez por escaneo con gente esperando en la fila. Sin índice, cada escaneo
-- recorrería todos los movimientos del evento — que en un evento grande son
-- decenas de miles y crecen durante toda la noche.
create index if not exists ticket_movimientos_puesto_idx
  on public.ticket_movimientos (puesto_id, created_at desc)
  where puesto_id is not null;
