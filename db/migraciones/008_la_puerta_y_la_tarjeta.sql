-- 008 · La puerta, la tarjeta y la vigencia — en MySQL
--
-- El espejo de las migraciones de Postgres que entraron DESPUÉS de la última
-- regeneración de `db/esquema/` (2026-09-15, hasta la `0128`):
--
--   0129  el NIT de quien se sienta en la rueda   (una columna)
--   0130  las zonas en los permisos               → NO va aquí, ver §7
--   0131  la lista de la puerta                   (un índice; dos sin traducir)
--   0132  quién ya tiene su escarapela            (dos columnas y un índice)
--   0133  la tarjeta de contacto                  (dos columnas)
--   0134  compartir es lo normal                  (renombra e invierte la 0133)
--   0135  los rechazos de la puerta               (una tabla nueva)
--   0136  vigencia por duración                   (tres columnas y dos reglas)
--   0137  cerrar funciones y vistas públicas      → NO va aquí, ver §7
--   0138  dos ventas a la vez                     → NO va aquí, ver §7
--   0139  el camino de búsqueda de las diez       → NO va aquí, ver §7
--
-- ── Por qué existe este archivo ────────────────────────────────────────
--
-- Lo mismo que ya contaron la 005 y la 007: `db/esquema/` se GENERA leyendo
-- Postgres, y hay que regenerarlo después de cada migración. Mientras eso no
-- se haga, quien cargue el volcado tal cual se lleva una base a la que le
-- falta lo de arriba.
--
-- Y el modo de fallo es el de siempre en este proyecto: no salta nada. El
-- panel de rechazos de la puerta sale vacío como si nadie hubiera intentado
-- entrar dos veces, la etiquetadora no sabe a quién ya se le imprimió, y un
-- pase de «4 horas» no caduca nunca.
--
-- Ya pasó con la tabla `zonas`: cuatro pantallas en blanco durante horas, sin
-- un solo error. `puerta_rechazos` es la misma forma del mismo problema.
--
-- Si cuando leas esto el volcado ya se regeneró con las diez dentro, esto no
-- hace nada: todo va con comprobación previa.
--
-- ── Orden ──────────────────────────────────────────────────────────────
--
-- Después de 007 y ANTES de los datos, como las anteriores: añade columnas y
-- una tabla a la que los datos van a entrar.
--
-- ── Lo que este archivo NO traduce, y por qué ──────────────────────────
--
-- Tres cosas, y ninguna es un olvido. Están en §7 con su razón.

SET FOREIGN_KEY_CHECKS = 0;

DROP PROCEDURE IF EXISTS gestek_add_col;
DROP PROCEDURE IF EXISTS gestek_add_idx;
DROP PROCEDURE IF EXISTS gestek_add_chk;
DROP PROCEDURE IF EXISTS gestek_add_fk;
DELIMITER //
CREATE PROCEDURE gestek_add_col(IN p_tabla VARCHAR(64), IN p_col VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = DATABASE() AND table_name = p_tabla AND column_name = p_col) THEN
    SET @s = CONCAT('ALTER TABLE `', p_tabla, '` ADD COLUMN `', p_col, '` ', p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //

CREATE PROCEDURE gestek_add_idx(IN p_tabla VARCHAR(64), IN p_idx VARCHAR(64), IN p_cols TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                  WHERE table_schema = DATABASE() AND table_name = p_tabla AND index_name = p_idx) THEN
    SET @s = CONCAT('CREATE INDEX `', p_idx, '` ON `', p_tabla, '` (', p_cols, ')');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //

-- Las reglas de la 0136 sí se traducen, a diferencia de lo que hizo el
-- generador del volcado —que no emite ninguna CHECK—. La diferencia es que
-- aquél traduce 829 columnas a ciegas y aquí son dos reglas que se pueden
-- leer: MySQL 8.0.16 en adelante las hace cumplir de verdad, cuestan cero y
-- son justo lo que impide que `vigencia_unidad` acabe con un valor que
-- `lib/vigenciaDuracion.js` no sabe interpretar — y ese fallo sería una
-- boleta que no caduca, no un error.
CREATE PROCEDURE gestek_add_chk(IN p_tabla VARCHAR(64), IN p_chk VARCHAR(64), IN p_expr TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE table_schema = DATABASE() AND table_name = p_tabla
                    AND constraint_name = p_chk AND constraint_type = 'CHECK') THEN
    SET @s = CONCAT('ALTER TABLE `', p_tabla, '` ADD CONSTRAINT `', p_chk, '` CHECK (', p_expr, ')');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //

-- Las claves foráneas también por procedimiento, y esto SÍ es un cambio
-- respecto a la 006 y la 007, que las añaden con un `ALTER TABLE` pelado.
--
-- Medido: correr este archivo dos veces con el `ALTER` pelado termina en
-- `ERROR 1826 · Duplicate foreign key constraint name`. Y volver a correrlo
-- es el caso normal, no el raro — es lo que hace quien no sabe si alguien ya
-- lo aplicó, que es justo la situación que este archivo existe para resolver.
--
-- Un archivo que promete «si ya está aplicado, esto no hace nada» tiene que
-- cumplirlo entero o no prometerlo. MySQL no admite
-- `ADD CONSTRAINT IF NOT EXISTS`, así que se pregunta antes.
CREATE PROCEDURE gestek_add_fk(IN p_tabla VARCHAR(64), IN p_fk VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE table_schema = DATABASE() AND table_name = p_tabla
                    AND constraint_name = p_fk AND constraint_type = 'FOREIGN KEY') THEN
    SET @s = CONCAT('ALTER TABLE `', p_tabla, '` ADD CONSTRAINT `', p_fk, '` FOREIGN KEY ', p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;


-- ── 1 · 0129 · El NIT de quien se sienta en la rueda ───────────────────
--
-- `text` y no un número: un NIT no se suma, lleva dígito de verificación que
-- a veces va pegado con guion, y un documento extranjero puede traer ceros a
-- la izquierda. Se guarda como lo escribió quien lo escribió.
--
-- Opcional y sin único: la misma empresa puede tener ficha en dos eventos.

CALL gestek_add_col('networking_expositores', 'nit', "TEXT NULL");


-- ── 2 · 0131 · La lista de la puerta ───────────────────────────────────
--
-- De los tres índices de la 0131, **sólo uno se traduce**.
--
-- El que sí: paginar la lista de asistentes de un evento. `id` al final
-- desempata cuando dos boletas se crearon en el mismo microsegundo — sin eso
-- la paginación repite o se salta filas.

CALL gestek_add_idx('tickets', 'tickets_evento_creado_idx', '`evento_id`, `created_at` DESC, `id` DESC');

-- Los que NO: `tickets_nombre_trgm_idx` y `tickets_email_trgm_idx`, que en
-- Postgres son índices GIN con `pg_trgm`.
--
-- **MySQL no tiene nada equivalente, y conviene decirlo en vez de poner algo
-- que se le parezca.** La búsqueda del panel es `ilike '%texto%'`
-- (`lib/agente.js:2511`, `routes/waitlist.js:61`): un comodín al PRINCIPIO.
-- Un índice B-tree no sirve para eso —se recorre entero igual— y un FULLTEXT
-- tampoco: busca palabras completas o prefijos, así que «ernnd» no
-- encontraría «Hernández», que es justo para lo que se usa en el mostrador
-- cuando alguien dicta mal su apellido.
--
-- Lo que lo hace tolerable, y por qué no se busca un sustituto ahora: esa
-- búsqueda **siempre va filtrada por `evento_id`**, y ese prefijo lo cubre el
-- índice de arriba. Así que el recorrido no es la tabla entera sino las
-- boletas de UN evento — en FESTECH, el más grande hasta hoy, 4.485 filas.
-- Eso en MySQL son milisegundos.
--
-- El día que un solo evento pase de unas decenas de miles de boletas, esto
-- vuelve a ser un problema, y entonces la salida es una columna normalizada
-- (sin tildes, en minúsculas) con FULLTEXT encima, no un índice más.


-- ── 3 · 0132 · Quién ya tiene su escarapela impresa ────────────────────
--
-- Nace de la puerta de FESTECH: tres mil boletas, dos personas imprimiendo y
-- ninguna forma de saber a quién ya se le imprimió. Va en la BOLETA y no en
-- el navegador de quien imprime, porque hay varias estaciones y lo que una
-- imprimió tiene que verlo la otra.

CALL gestek_add_col('tickets', 'escarapela_impresa_at',  "DATETIME(6) NULL");
-- Sin clave foránea a propósito, igual que en Postgres: un operador borrado
-- no debe llevarse por delante el registro de la impresión.
CALL gestek_add_col('tickets', 'escarapela_impresa_por', "CHAR(36) NULL");

-- En Postgres este índice es PARCIAL (`where escarapela_impresa_at is null`).
-- MySQL no los tiene, y éste es de los 24 que NO son únicos: se le tira la
-- condición y ya, que es la regla de `NOTAS-ESQUEMA.md`. El índice resultante
-- cubre lo mismo y algo más —también las ya impresas— y sólo cuesta espacio.
--
-- Lo que se pierde es que el de Postgres se encogía solo a medida que
-- avanzaba la jornada. Aquí no, y da igual: no cambia ninguna respuesta.
CALL gestek_add_idx('tickets', 'tickets_sin_imprimir_idx', '`evento_id`, `created_at` DESC');


-- ── 4 · 0133 + 0134 · La tarjeta de contacto ───────────────────────────
--
-- Las dos juntas, y **sólo el estado final**. La 0133 creó
-- `contacto_publico` (apagada para todos) y la 0134 la renombró a
-- `contacto_oculto` invirtiendo el sentido, porque se decidió que compartir
-- fuera lo normal y lo que se marca sea NO hacerlo.
--
-- Aquí no hay nada que renombrar ni que invertir: la columna no existe
-- todavía, así que se crea ya como quedó. Reproducir el vaivén sería copiar
-- una historia que esta base no vivió — y el `update` que invertía los
-- valores, corrido sobre filas que nacen en 0, no haría nada salvo dar la
-- impresión de que hizo algo.
--
-- No expone nada por sí sola: lo que se comparte lo decide el organizador en
-- `page_json.tarjeta_contacto.campos`, y mientras esa lista esté vacía la
-- tarjeta no enseña ningún dato de nadie (`lib/tarjetaContacto.js`).

CALL gestek_add_col('tickets', 'contacto_oculto', "TINYINT(1) NOT NULL DEFAULT 0");
-- Sólo las ocho claves que valida `lib/tarjetaContacto.js` (empresa, cargo,
-- email, telefono, whatsapp, web, linkedin, nota). NUNCA se llena con las
-- respuestas del formulario de registro: ésas traen documento, fecha de
-- nacimiento, etnia y discapacidad, y tienen otra finalidad y otra
-- autorización.
CALL gestek_add_col('tickets', 'contacto', "JSON NOT NULL DEFAULT (CAST('{}' AS JSON))");


-- ── 5 · 0135 · Los rechazos de la puerta ───────────────────────────────
--
-- **La parte grave de este archivo.** Es la única tabla NUEVA, y sin ella el
-- panel de rechazos sale vacío: no «da error», dice que nadie intentó entrar
-- dos veces. Es exactamente el fallo de la tabla `zonas`.
--
-- Tabla aparte y no `ticket_movimientos` a propósito: aquélla es el vaivén de
-- quien está DENTRO, y el aforo la lee sin filtrar por tipo. Un rechazo ahí
-- sumaría gente que nunca cruzó la puerta.

CREATE TABLE IF NOT EXISTS `puerta_rechazos` (
  -- Sin default: en Postgres es `gen_random_uuid()` y aquí el id lo pone la
  -- aplicación, como en las otras 72 tablas del volcado.
  `id`          CHAR(36) NOT NULL,
  `evento_id`   CHAR(36) NOT NULL,
  `ticket_id`   CHAR(36) NULL,
  `motivo`      TEXT NOT NULL,
  `operador_id` CHAR(36) NULL,
  -- Cuándo había entrado de verdad: con eso se ve si el repetido fue al
  -- minuto (escaneo doble) o horas después (boleta prestada).
  `entro_at`    DATETIME(6) NULL,
  `created_at`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CALL gestek_add_idx('puerta_rechazos', 'puerta_rechazos_evento_idx', '`evento_id`, `created_at` DESC');

-- El `enable row level security` de la 0135 no se traduce: MySQL no tiene
-- RLS. Lo que allí era «sin políticas = cerrada» aquí lo hace
-- `core/permisos/`, que es lo que sustituye a RLS en toda la fase 6.


-- ── 6 · 0136 · Vigencia por duración ───────────────────────────────────
--
-- La 0127 dio a cada tipo de boleta una ventana FIJA. Ésta es la otra, la de
-- los pases: «válida 4 horas», «un día, el que elijas». No tiene fecha
-- propia — corre desde que la persona entra por primera vez.

CALL gestek_add_col('ticket_types', 'vigencia_cantidad', "INT NULL");
CALL gestek_add_col('ticket_types', 'vigencia_unidad',   "TEXT NULL");

CALL gestek_add_chk('ticket_types', 'ticket_types_vigencia_unidad_chk',
                    "`vigencia_unidad` IS NULL OR `vigencia_unidad` IN ('horas','dias','semanas')");
CALL gestek_add_chk('ticket_types', 'ticket_types_vigencia_cantidad_chk',
                    "`vigencia_cantidad` IS NULL OR `vigencia_cantidad` > 0");

-- `checked_in_at` no sirve para esto: en un evento de varios días se
-- reescribe con cada entrada de un día nuevo. El primer ingreso se guarda
-- aparte y no se vuelve a tocar.
CALL gestek_add_col('tickets', 'primer_ingreso_at', "DATETIME(6) NULL");

-- El relleno de la 0136. Es idempotente —sólo toca las que están en NULL— y
-- va aquí por si esta base se carga con datos que ya traigan `checked_in_at`
-- pero no la columna nueva.
--
-- Para quien vino dos días esto guarda el ÚLTIMO ingreso, no el primero. Es
-- lo mejor que se sabe y sólo importa si a un tipo que ya se usó se le pone
-- duración después. Lo mismo decía la migración de Postgres.
UPDATE `tickets` SET `primer_ingreso_at` = `checked_in_at`
 WHERE `primer_ingreso_at` IS NULL AND `checked_in_at` IS NOT NULL;


-- ── 7 · Lo que NO está aquí, y por qué ─────────────────────────────────
--
-- **0130 · las zonas en los permisos.** Es un `create or replace function
-- private.fn_roles_semilla()` más un `update` sobre los roles que ya
-- existían. Ninguna de las dos mitades va a MySQL:
--
--   · La función es una semilla, y en el camino MySQL las semillas viven en
--     `modules/eventos/semillas.js` (paso 4 de la fase 6). **Comprobado: ese
--     archivo ya incluye `gestionar_zonas`**, así que un evento creado contra
--     MySQL nace con el permiso correcto.
--   · El `update` tocaba filas que ya existían en Postgres. Esas filas llegan
--     a MySQL por la carga de datos, ya con el permiso dentro. Repetirlo aquí
--     no cambiaría nada.
--
-- **0137 · cerrar funciones y vistas públicas.** Son `revoke`/`grant` sobre
-- los roles `anon` y `authenticated` de Supabase. MySQL no tiene esos roles
-- ni esa superficie: a la base sólo entra el backend, con un usuario único.
-- Quien decide qué puede ver cada persona es `core/permisos/`, y eso ya está
-- al día — 378 rutas, 378 declaradas.
--
-- **0138 · dos ventas a la vez.** Dos funciones (`sumar_aforo_vendido`,
-- `sumar_vendidos_tipo`) que hacen `update … set x = x + n` en una sola
-- sentencia, más el recálculo de lo que se había perdido.
--
--   ⚠ Y AQUÍ HAY UN HUECO QUE ESTE ARCHIVO NO PUEDE TAPAR.
--
--   El recálculo no hace falta: los datos llegan de Postgres ya corregidos.
--   Las funciones sí, y por la regla de la fase 6 no se traducen a MySQL —
--   van a `modules/contadores/`, que es donde viven los contadores atómicos
--   con `SELECT … FOR UPDATE`.
--
--   **Hoy `modules/contadores/index.js` NO las tiene.** Cubre la cuota de
--   stands, los inscritos a sesiones y el canje de recompensas; `aforo_vendido`
--   y `vendidos` no aparecen. Y hay **diez llamadas** a esas dos funciones en
--   el código (`lib/confirmarTicket.js`, `lib/agente.js`,
--   `routes/eventos.publicos.js`, `routes/clientes.js`, `routes/pagos.js`),
--   todas por `supabase.rpc(...)`.
--
--   Lo que pasa si se enciende MySQL sin eso: vuelve exactamente el fallo que
--   la 0138 arregló —dos ventas simultáneas leen el mismo contador y una se
--   pierde—, que es el que el README cuenta que se midió en FESTECH.
--
--   Es trabajo de código, no de SQL, y por eso no está aquí. Pero **tiene que
--   estar hecho antes del corte**, y es la razón por la que esta nota ocupa
--   veinte líneas en vez de dos.
--
--   (Hecho el 27-oct: `modules/contadores/` ya trae `sumarAforoVendido()` y
--   `sumarVendidosTipo()`. Lo que sigue pendiente es cablear las diez llamadas
--   para que dejen de ir por `supabase.rpc` cuando mande MySQL.)
--
-- **0139 · el camino de búsqueda de las diez.** Fija el `search_path` de diez
-- funciones de Postgres. **MySQL no tiene `search_path`**: una conexión se abre
-- contra una base y ahí se queda, así que no hay nada que traducir — ni una
-- línea.
--
--   Se declara aquí de todas formas porque
--   `test/elEsquemaMysqlNoSeQuedaAtras.test.js` no sabe leer qué hace cada
--   migración: sólo comprueba que ninguna quede sin mencionar. Una migración
--   que no necesita lado MySQL se declara igual, diciendo por qué. Es más
--   barato que enseñarle a la prueba a distinguir, y deja la decisión escrita
--   donde se busca.


SET FOREIGN_KEY_CHECKS = 1;


-- ── 8 · Las claves foráneas ────────────────────────────────────────────
--
-- Aparte y al final, como en la 006 y la 007: si una tabla referida todavía
-- no está cargada, esto falla ruidosamente en vez de dejar tablas a medias.
-- Y con `FOREIGN_KEY_CHECKS` ya en 1, para que al crearlas se valide lo que
-- hubiera cargado.
--
-- `ticket_id` y `operador_id` van con SET NULL y no con CASCADE: borrar una
-- boleta no tiene por qué borrar la constancia de que alguien intentó usarla,
-- que es justo para lo que existe la tabla.

CALL gestek_add_fk('puerta_rechazos', 'puerta_rechazos_evento_id_fkey',
                   '(`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('puerta_rechazos', 'puerta_rechazos_ticket_id_fkey',
                   '(`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE SET NULL');
CALL gestek_add_fk('puerta_rechazos', 'puerta_rechazos_operador_id_fkey',
                   '(`operador_id`) REFERENCES `profiles` (`id`) ON DELETE SET NULL');


DROP PROCEDURE IF EXISTS gestek_add_col;
DROP PROCEDURE IF EXISTS gestek_add_idx;
DROP PROCEDURE IF EXISTS gestek_add_chk;
DROP PROCEDURE IF EXISTS gestek_add_fk;


-- ── Comprobación ───────────────────────────────────────────────────────
--
--   -- La tabla nueva existe:
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = DATABASE() AND table_name = 'puerta_rechazos';
--
--   -- Las ocho columnas nuevas están, y son ocho:
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema = DATABASE()
--      AND (table_name, column_name) IN (
--            ('networking_expositores','nit'),
--            ('tickets','escarapela_impresa_at'), ('tickets','escarapela_impresa_por'),
--            ('tickets','contacto_oculto'),       ('tickets','contacto'),
--            ('tickets','primer_ingreso_at'),
--            ('ticket_types','vigencia_cantidad'),('ticket_types','vigencia_unidad'));
--
--   -- Nadie queda oculto por error (la columna nace en 0 para todos):
--   SELECT COUNT(*) FROM tickets WHERE contacto_oculto <> 0;
--   -- 0.
--
--   -- Y la regla de la vigencia es de verdad. Esto TIENE que fallar con
--   -- «Check constraint 'ticket_types_vigencia_unidad_chk' is violated»:
--   --   UPDATE ticket_types SET vigencia_unidad = 'meses' LIMIT 1;
--   -- Si pasa sin quejarse, el servidor es anterior a MySQL 8.0.16 y las
--   -- CHECK se están ignorando en silencio: la validación queda sólo en
--   -- `lib/vigenciaDuracion.js`, que es lo que había antes de esto.
