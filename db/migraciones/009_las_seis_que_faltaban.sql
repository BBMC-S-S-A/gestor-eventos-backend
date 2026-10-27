/* 009_las_seis_que_faltaban.sql — el módulo de espacios y puestos.
 *
 * ══ POR QUÉ EXISTE ESTE ARCHIVO ═════════════════════════════════════════
 *
 * Mirando `gestek_datos` en el cPanel el 27 de octubre de 2026: 79 tablas de
 * las 84 que debería tener. Faltaban diez — cuatro de las migraciones 007 y
 * 008, que es lo esperado porque se cargó antes de que existieran, y **seis
 * del volcado base**:
 *
 *     recintos  espacios  ticket_type_espacios
 *     espacio_reservas  ticket_puestos  puesto_transferencias
 *
 * Esas seis estaban en `01_tablas.sql` desde el principio. Que falten quiere
 * decir que la carga del esquema **se cayó a mitad y nadie lo notó**, o que se
 * cargó un volcado anterior a ese módulo.
 *
 * Y no son seis tablas sueltas: son el módulo ENTERO de espacios y puestos
 * numerados —stands, mesas, sillas, las reservas y los traspasos—, o sea todo
 * lo que se vende por puesto. En Supabase `espacios` tiene 128 filas y
 * `ticket_type_espacios` 124: son datos de verdad que hoy no tendrían dónde
 * entrar.
 *
 * ══ QUÉ TRAE ════════════════════════════════════════════════════════════
 *
 *   §1  Las seis tablas, copiadas de `01_tablas.sql` tal cual.
 *   §2  La columna generada y el índice único de `espacio_reservas` (de
 *       `02_indices_unicos_parciales.sql`): es lo que impide vender dos veces
 *       la misma silla.
 *   §3  Sus quince índices (de `04_indices.sql`).
 *   §4  Sus once claves ajenas (de `05_claves_foraneas.sql`).
 *
 * ══ LO QUE NO TRAE, Y HAY QUE CORRER APARTE ═════════════════════════════
 *
 * Las migraciones **007** y **008**, que también faltan. Se corren después de
 * ésta y en ese orden, porque la 007 añade una clave ajena de
 * `ticket_movimientos` a `ticket_puestos`, que hasta ahora no existía.
 *
 *     009  →  007  →  008
 *
 * ══ SE PUEDE CORRER DOS VECES ═══════════════════════════════════════════
 *
 * Todo va con `IF NOT EXISTS` o con los procedimientos de abajo. Correrlo
 * sobre una base que ya lo tenga no hace nada y no da error — que es lo que
 * hace falta cuando uno no está seguro de dónde se quedó la última vez.
 */

/* ── Los ayudantes, los mismos de la 007 y la 008 ───────────────────────── */
DROP PROCEDURE IF EXISTS gestek_add_idx;
DROP PROCEDURE IF EXISTS gestek_add_fk;
DELIMITER //
CREATE PROCEDURE gestek_add_idx(IN p_tabla VARCHAR(64), IN p_idx VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                  WHERE table_schema = DATABASE() AND table_name = p_tabla AND index_name = p_idx) THEN
    SET @s = CONCAT('CREATE ', p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
CREATE PROCEDURE gestek_add_fk(IN p_tabla VARCHAR(64), IN p_fk VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE table_schema = DATABASE() AND table_name = p_tabla
                    AND constraint_name = p_fk AND constraint_type = 'FOREIGN KEY') THEN
    SET @s = CONCAT('ALTER TABLE `', p_tabla, '` ADD CONSTRAINT `', p_fk, '` ', p_def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;


/* ── §1 · Las seis tablas ───────────────────────────────────────────────
 *
 * Copiadas de `01_tablas.sql` sin tocar una coma, sólo con `IF NOT EXISTS`
 * añadido. El orden es el de dependencias: `recintos` y `espacios` antes que
 * lo que las referencia.
 */

CREATE TABLE IF NOT EXISTS `recintos` (
  `id` CHAR(36) NOT NULL,
  `owner_id` CHAR(36) NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `ciudad` TEXT NULL,
  `direccion` TEXT NULL,
  `aforo_legal` INT NULL,
  `plano` JSON NOT NULL DEFAULT (CAST('[]' AS JSON)),
  `fondo` JSON NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS `espacios` (
  `id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `parent_id` CHAR(36) NULL,
  `nombre` TEXT NOT NULL,
  `tipo` TEXT NOT NULL DEFAULT ('zona'),
  `modo` TEXT NOT NULL DEFAULT ('aforo'),
  `aforo_max` INT NULL,
  `capacidad` INT NOT NULL DEFAULT 1,
  `geometria` JSON NULL,
  `atributos` JSON NOT NULL DEFAULT (CAST('{}' AS JSON)),
  `orden` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS `ticket_type_espacios` (
  `ticket_type_id` CHAR(36) NOT NULL,
  `espacio_id` CHAR(36) NOT NULL,
  PRIMARY KEY (`ticket_type_id`, `espacio_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS `espacio_reservas` (
  `id` CHAR(36) NOT NULL,
  `espacio_id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `estado` VARCHAR(255) NOT NULL,
  `ticket_id` CHAR(36) NULL,
  `sesion_compra` TEXT NULL,
  `expira_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS `ticket_puestos` (
  `id` CHAR(36) NOT NULL,
  `ticket_id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `orden` INT NOT NULL DEFAULT 1,
  `nombre` TEXT NULL,
  `email` TEXT NULL,
  `documento` TEXT NULL,
  `qr_token` VARCHAR(255) NULL,
  `estado` VARCHAR(255) NOT NULL DEFAULT ('libre'),
  `asignado_at` DATETIME(6) NULL,
  `usado_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `foto_url` TEXT NULL,
  `telefono` TEXT NULL,
  `autorizado_at` DATETIME(6) NULL,
  `autorizado_por` TEXT NULL,
  `credencial_gen` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS `puesto_transferencias` (
  `id` CHAR(36) NOT NULL,
  `puesto_id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `de_nombre` TEXT NULL,
  `de_email` TEXT NULL,
  `a_nombre` TEXT NULL,
  `a_email` TEXT NULL,
  `a_documento` TEXT NULL,
  `monto` DECIMAL(12,2) NULL,
  `currency` TEXT NULL,
  `via` TEXT NOT NULL DEFAULT ('titular'),
  `actor_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;


/* ── §2 · La columna generada de `espacio_reservas` ─────────────────────
 *
 * En Postgres hay un índice único PARCIAL que impide vender dos veces la misma
 * silla: UNIQUE (espacio_id) WHERE estado IN ('retenido','vendido'). MySQL no
 * tiene índices parciales, así que se reproduce con una columna generada que
 * vale el `espacio_id` cuando la reserva está viva y NULL cuando no — y los
 * NULL no cuentan para la unicidad.
 *
 * Sin esto, dos personas pidiendo el mismo stand a la vez se lo llevan las
 * dos. `modules/espacios/` cuenta con que la base lo corte, no lo comprueba en
 * JavaScript, porque comprobarlo antes es la carrera clásica.
 */
SET @hay_col = (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = 'espacio_reservas' AND column_name = 'espacio_activo');
SET @s = IF(@hay_col = 0,
  'ALTER TABLE `espacio_reservas` ADD COLUMN `espacio_activo` CHAR(36) AS (IF(`estado` IN (''retenido'', ''vendido''), `espacio_id`, NULL)) VIRTUAL',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CALL gestek_add_idx('espacio_reservas', 'espacio_reservas_una_viva',
  'UNIQUE INDEX `espacio_reservas_una_viva` ON `espacio_reservas` (`espacio_activo`)');


/* El otro único de `02_indices_unicos_parciales.sql` que vive en estas seis:
 * el QR de un puesto no se puede repetir.
 *
 * En Postgres era parcial —WHERE qr_token IS NOT NULL— y aquí va completo,
 * porque los NULL no entran en la unicidad de MySQL y hacen solos el trabajo
 * de la condición: un puesto sin token no estorba, y en cuanto se le asigna
 * uno, ese token no puede repetirse en ningún otro.
 *
 * Esto se descubrió ENSAYANDO la carga: `02_indices_unicos_parciales.sql`
 * reventó con `ERROR 1146 ticket_puestos doesn't exist` — exactamente el
 * mismo error que debió llevarse la carga original y que dejó la base a
 * medias. Sin este índice, dos puestos podrían compartir credencial. */
CALL gestek_add_idx('ticket_puestos', 'ticket_puestos_token_idx',
  'UNIQUE INDEX `ticket_puestos_token_idx` ON `ticket_puestos` (`qr_token`)');


/* ── §2b · Los CUATRO ÚNICOS que se perdieron con el error ──────────────
 *
 * Esto se descubrió ensayando la carga, y es más grave que las seis tablas.
 *
 * `02_indices_unicos_parciales.sql` revienta en su línea 59 —el índice de
 * `ticket_puestos`, que no existía— y **un script SQL no sigue después de un
 * error**. Todo lo que venía detrás de esa línea nunca corrió:
 *
 *     catalogo_roles.slug_global         + catalogo_roles_slug_global_uidx
 *     sesion_inscripciones.email_sin_boleta + sesion_inscripciones_email_uidx
 *     torneo_categorias.nombre_raiz      + torneo_categorias_unica_raiz
 *     torneo_categorias.nombre_hija      + torneo_categorias_unica_hija
 *
 * No son índices de rendimiento: son los que IMPIDEN DUPLICADOS. Sin ellos se
 * pueden crear dos roles globales con el mismo slug, dos inscripciones del
 * mismo correo en la misma sesión, o dos categorías hermanas que se llaman
 * igual. Y se crean en silencio, que es lo de siempre.
 *
 * ⚠ SI YA HAY DUPLICADOS, EL ÍNDICE NO SE PUEDE CREAR y esta migración se
 * para con `ERROR 1062`. Eso NO es un fallo del archivo: es el archivo
 * diciendo que hay datos que arreglar primero. Las consultas para encontrarlos
 * están al final, en «Comprobación».
 */

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'catalogo_roles' AND column_name = 'slug_global');
SET @s = IF(@c = 0, 'ALTER TABLE `catalogo_roles` ADD COLUMN `slug_global` VARCHAR(255) AS (IF(`global` = 1, `slug`, NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
CALL gestek_add_idx('catalogo_roles', 'catalogo_roles_slug_global_uidx',
  'UNIQUE INDEX `catalogo_roles_slug_global_uidx` ON `catalogo_roles` (`slug_global`)');

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'sesion_inscripciones' AND column_name = 'email_sin_boleta');
SET @s = IF(@c = 0, 'ALTER TABLE `sesion_inscripciones` ADD COLUMN `email_sin_boleta` VARCHAR(255) AS (IF(`ticket_id` IS NULL, LOWER(`email`), NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
CALL gestek_add_idx('sesion_inscripciones', 'sesion_inscripciones_email_uidx',
  'UNIQUE INDEX `sesion_inscripciones_email_uidx` ON `sesion_inscripciones` (`session_id`, `email_sin_boleta`)');

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'torneo_categorias' AND column_name = 'nombre_raiz');
SET @s = IF(@c = 0, 'ALTER TABLE `torneo_categorias` ADD COLUMN `nombre_raiz` VARCHAR(255) AS (IF(`padre_id` IS NULL, LOWER(`nombre`), NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
CALL gestek_add_idx('torneo_categorias', 'torneo_categorias_unica_raiz',
  'UNIQUE INDEX `torneo_categorias_unica_raiz` ON `torneo_categorias` (`evento_id`, `nombre_raiz`)');

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'torneo_categorias' AND column_name = 'nombre_hija');
SET @s = IF(@c = 0, 'ALTER TABLE `torneo_categorias` ADD COLUMN `nombre_hija` VARCHAR(255) AS (IF(`padre_id` IS NOT NULL, LOWER(`nombre`), NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
CALL gestek_add_idx('torneo_categorias', 'torneo_categorias_unica_hija',
  'UNIQUE INDEX `torneo_categorias_unica_hija` ON `torneo_categorias` (`evento_id`, `padre_id`, `nombre_hija`)');


/* ── §3 · Los índices ───────────────────────────────────────────────────
 *
 * Los de `04_indices.sql` que tocan estas seis tablas. Los que allí eran
 * parciales en Postgres aquí van completos: la condición se puede tirar sin
 * cambiar el resultado, sólo el tamaño.
 */
CALL gestek_add_idx('espacio_reservas', 'espacio_reservas_caducan_idx',
  'INDEX `espacio_reservas_caducan_idx` ON `espacio_reservas` (`expira_at`)');
CALL gestek_add_idx('espacio_reservas', 'espacio_reservas_evento_idx',
  'INDEX `espacio_reservas_evento_idx` ON `espacio_reservas` (`evento_id`, `estado`)');
CALL gestek_add_idx('espacios', 'espacios_evento_idx',
  'INDEX `espacios_evento_idx` ON `espacios` (`evento_id`)');
CALL gestek_add_idx('espacios', 'espacios_padre_idx',
  'INDEX `espacios_padre_idx` ON `espacios` (`parent_id`)');
CALL gestek_add_idx('espacios', 'espacios_vendibles_idx',
  'INDEX `espacios_vendibles_idx` ON `espacios` (`evento_id`)');
CALL gestek_add_idx('puesto_transferencias', 'puesto_transf_evento_idx',
  'INDEX `puesto_transf_evento_idx` ON `puesto_transferencias` (`evento_id`, `created_at`)');
CALL gestek_add_idx('puesto_transferencias', 'puesto_transf_puesto_idx',
  'INDEX `puesto_transf_puesto_idx` ON `puesto_transferencias` (`puesto_id`, `created_at`)');
CALL gestek_add_idx('recintos', 'recintos_nombre_unico',
  'UNIQUE INDEX `recintos_nombre_unico` ON `recintos` (`owner_id`, (lower(nombre)))');
CALL gestek_add_idx('recintos', 'recintos_owner_idx',
  'INDEX `recintos_owner_idx` ON `recintos` (`owner_id`, `nombre`)');
CALL gestek_add_idx('ticket_puestos', 'ticket_puestos_evento_idx',
  'INDEX `ticket_puestos_evento_idx` ON `ticket_puestos` (`evento_id`, `estado`)');
CALL gestek_add_idx('ticket_puestos', 'ticket_puestos_orden_unico',
  'UNIQUE INDEX `ticket_puestos_orden_unico` ON `ticket_puestos` (`ticket_id`, `orden`)');
CALL gestek_add_idx('ticket_puestos', 'ticket_puestos_por_autorizar_idx',
  'INDEX `ticket_puestos_por_autorizar_idx` ON `ticket_puestos` (`evento_id`, `autorizado_at`)');
CALL gestek_add_idx('ticket_puestos', 'ticket_puestos_ticket_idx',
  'INDEX `ticket_puestos_ticket_idx` ON `ticket_puestos` (`ticket_id`)');
CALL gestek_add_idx('ticket_type_espacios', 'tte_espacio_idx',
  'INDEX `tte_espacio_idx` ON `ticket_type_espacios` (`espacio_id`)');


/* ── §4 · Las once claves ajenas ────────────────────────────────────────
 *
 * Ninguna otra tabla del volcado apunta a estas seis, así que no hay nada más
 * que reparar por ese lado. La única de fuera es la que añade la 007
 * (`ticket_movimientos` → `ticket_puestos`), y por eso la 007 va después.
 */
CALL gestek_add_fk('espacio_reservas', 'espacio_reservas_espacio_id_fkey',
  'FOREIGN KEY (`espacio_id`) REFERENCES `espacios` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('espacio_reservas', 'espacio_reservas_evento_id_fkey',
  'FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('espacio_reservas', 'espacio_reservas_ticket_id_fkey',
  'FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE SET NULL');
CALL gestek_add_fk('espacios', 'espacios_evento_id_fkey',
  'FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('espacios', 'espacios_parent_id_fkey',
  'FOREIGN KEY (`parent_id`) REFERENCES `espacios` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('puesto_transferencias', 'puesto_transferencias_evento_id_fkey',
  'FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('puesto_transferencias', 'puesto_transferencias_puesto_id_fkey',
  'FOREIGN KEY (`puesto_id`) REFERENCES `ticket_puestos` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('ticket_puestos', 'ticket_puestos_evento_id_fkey',
  'FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('ticket_puestos', 'ticket_puestos_ticket_id_fkey',
  'FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('ticket_type_espacios', 'ticket_type_espacios_espacio_id_fkey',
  'FOREIGN KEY (`espacio_id`) REFERENCES `espacios` (`id`) ON DELETE CASCADE');
CALL gestek_add_fk('ticket_type_espacios', 'ticket_type_espacios_ticket_type_id_fkey',
  'FOREIGN KEY (`ticket_type_id`) REFERENCES `ticket_types` (`id`) ON DELETE CASCADE');


DROP PROCEDURE IF EXISTS gestek_add_idx;
DROP PROCEDURE IF EXISTS gestek_add_fk;


/* ── Comprobación ───────────────────────────────────────────────────────
 *
 *   -- Las seis tablas existen:
 *   SELECT table_name FROM information_schema.tables
 *    WHERE table_schema = DATABASE()
 *      AND table_name IN ('recintos','espacios','ticket_type_espacios',
 *                         'espacio_reservas','ticket_puestos','puesto_transferencias');
 *   -- tienen que salir 6
 *
 *   -- Las once claves ajenas están:
 *   SELECT COUNT(*) FROM information_schema.table_constraints
 *    WHERE table_schema = DATABASE() AND constraint_type = 'FOREIGN KEY'
 *      AND table_name IN ('recintos','espacios','ticket_type_espacios',
 *                         'espacio_reservas','ticket_puestos','puesto_transferencias');
 *   -- tienen que salir 11
 *
 *   -- ⚠ SI LA MIGRACIÓN SE PARÓ CON «ERROR 1062 Duplicate entry», hay datos
 *   -- repetidos. Estas cuatro los encuentran:
 *
 *   SELECT slug, COUNT(*) FROM catalogo_roles WHERE `global` = 1
 *    GROUP BY slug HAVING COUNT(*) > 1;
 *
 *   SELECT session_id, LOWER(email), COUNT(*) FROM sesion_inscripciones
 *    WHERE ticket_id IS NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;
 *
 *   SELECT evento_id, LOWER(nombre), COUNT(*) FROM torneo_categorias
 *    WHERE padre_id IS NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;
 *
 *   SELECT evento_id, padre_id, LOWER(nombre), COUNT(*) FROM torneo_categorias
 *    WHERE padre_id IS NOT NULL GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
 *
 *   -- Y la que impide vender dos veces la misma silla:
 *   SELECT index_name FROM information_schema.statistics
 *    WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas'
 *      AND index_name = 'espacio_reservas_una_viva';
 */
