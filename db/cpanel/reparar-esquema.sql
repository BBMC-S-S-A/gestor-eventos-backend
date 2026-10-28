/* ═══════════════════════════════════════════════════════════════════════════
 * GESTEK — reparación del esquema de `gestek_datos` en cPanel
 *                                                      versión SIN PROCEDIMIENTOS
 * ───────────────────────────────────────────────────────────────────────────
 * La versión anterior usaba procedimientos almacenados (`CREATE PROCEDURE`)
 * para no repetir el «mira antes de crear». El MySQL del cPanel no deja:
 *
 *     #1227 — Acceso negado. Necesita el privilegio SYSTEM_USER
 *
 * Es normal en hosting compartido. Aquí los procedimientos están quitados y
 * cada paso hace la misma comprobación en línea, con PREPARE/EXECUTE, que no
 * pide ningún privilegio especial. Tampoco hay `DELIMITER`, que es la otra
 * cosa con la que phpMyAdmin se suele atragantar.
 *
 * Trae las tres migraciones que faltan, EN ORDEN:
 *
 *     1 de 3 · 009_las_seis_que_faltaban.sql   ← el módulo de espacios y puestos
 *     2 de 3 · 007_derechos_y_credenciales.sql
 *     3 de 3 · 008_la_puerta_y_la_tarjeta.sql
 *
 * El orden importa: la 007 le cuelga una clave ajena a `ticket_puestos`, que
 * es una de las tablas que crea la 009.
 *
 * ── CÓMO SE CORRE ─────────────────────────────────────────────────────────
 *   1. En el panel de la izquierda de phpMyAdmin, CLIC en `gestek_datos`.
 *      (Si no la selecciona, `DATABASE()` apunta a otra cosa y nada cuadra.)
 *   2. Pestaña «SQL».
 *   3. Pegue TODO este archivo y dele «Continuar».
 *
 * Se puede correr dos veces sin romper nada: todo mira antes de crear.
 *
 * ── AL FINAL, PARA COMPROBAR ──────────────────────────────────────────────
 *   SELECT COUNT(*) FROM information_schema.tables
 *    WHERE table_schema = 'gestek_datos' AND table_type = 'BASE TABLE';
 *   -- tiene que dar 84   (hoy da 74)
 *
 * ── SI SALE «ERROR 1062 Duplicate entry» ──────────────────────────────────
 * No es un fallo del archivo: es el archivo diciendo que ya hay filas
 * repetidas que hay que limpiar primero. Las consultas que las encuentran
 * están al final del bloque «1 de 3».
 * ═══════════════════════════════════════════════════════════════════════════ */


/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║  1 de 3 — 009_las_seis_que_faltaban.sql                               ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */

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

SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas' AND index_name = 'espacio_reservas_una_viva');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `espacio_reservas_una_viva` ON `espacio_reservas` (`espacio_activo`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


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
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND index_name = 'ticket_puestos_token_idx');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `ticket_puestos_token_idx` ON `ticket_puestos` (`qr_token`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


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
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'catalogo_roles' AND index_name = 'catalogo_roles_slug_global_uidx');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `catalogo_roles_slug_global_uidx` ON `catalogo_roles` (`slug_global`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'sesion_inscripciones' AND column_name = 'email_sin_boleta');
SET @s = IF(@c = 0, 'ALTER TABLE `sesion_inscripciones` ADD COLUMN `email_sin_boleta` VARCHAR(255) AS (IF(`ticket_id` IS NULL, LOWER(`email`), NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'sesion_inscripciones' AND index_name = 'sesion_inscripciones_email_uidx');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `sesion_inscripciones_email_uidx` ON `sesion_inscripciones` (`session_id`, `email_sin_boleta`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'torneo_categorias' AND column_name = 'nombre_raiz');
SET @s = IF(@c = 0, 'ALTER TABLE `torneo_categorias` ADD COLUMN `nombre_raiz` VARCHAR(255) AS (IF(`padre_id` IS NULL, LOWER(`nombre`), NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'torneo_categorias' AND index_name = 'torneo_categorias_unica_raiz');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `torneo_categorias_unica_raiz` ON `torneo_categorias` (`evento_id`, `nombre_raiz`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'torneo_categorias' AND column_name = 'nombre_hija');
SET @s = IF(@c = 0, 'ALTER TABLE `torneo_categorias` ADD COLUMN `nombre_hija` VARCHAR(255) AS (IF(`padre_id` IS NOT NULL, LOWER(`nombre`), NULL)) VIRTUAL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'torneo_categorias' AND index_name = 'torneo_categorias_unica_hija');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `torneo_categorias_unica_hija` ON `torneo_categorias` (`evento_id`, `padre_id`, `nombre_hija`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


/* ── §3 · Los índices ───────────────────────────────────────────────────
 *
 * Los de `04_indices.sql` que tocan estas seis tablas. Los que allí eran
 * parciales en Postgres aquí van completos: la condición se puede tirar sin
 * cambiar el resultado, sólo el tamaño.
 */
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas' AND index_name = 'espacio_reservas_caducan_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `espacio_reservas_caducan_idx` ON `espacio_reservas` (`expira_at`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas' AND index_name = 'espacio_reservas_evento_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `espacio_reservas_evento_idx` ON `espacio_reservas` (`evento_id`, `estado`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'espacios' AND index_name = 'espacios_evento_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `espacios_evento_idx` ON `espacios` (`evento_id`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'espacios' AND index_name = 'espacios_padre_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `espacios_padre_idx` ON `espacios` (`parent_id`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'espacios' AND index_name = 'espacios_vendibles_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `espacios_vendibles_idx` ON `espacios` (`evento_id`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'puesto_transferencias' AND index_name = 'puesto_transf_evento_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `puesto_transf_evento_idx` ON `puesto_transferencias` (`evento_id`, `created_at`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'puesto_transferencias' AND index_name = 'puesto_transf_puesto_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `puesto_transf_puesto_idx` ON `puesto_transferencias` (`puesto_id`, `created_at`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'recintos' AND index_name = 'recintos_nombre_unico');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `recintos_nombre_unico` ON `recintos` (`owner_id`, (lower(nombre)))', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'recintos' AND index_name = 'recintos_owner_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `recintos_owner_idx` ON `recintos` (`owner_id`, `nombre`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND index_name = 'ticket_puestos_evento_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `ticket_puestos_evento_idx` ON `ticket_puestos` (`evento_id`, `estado`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND index_name = 'ticket_puestos_orden_unico');
SET @s = IF(@y = 0, 'CREATE UNIQUE INDEX `ticket_puestos_orden_unico` ON `ticket_puestos` (`ticket_id`, `orden`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND index_name = 'ticket_puestos_por_autorizar_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `ticket_puestos_por_autorizar_idx` ON `ticket_puestos` (`evento_id`, `autorizado_at`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND index_name = 'ticket_puestos_ticket_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `ticket_puestos_ticket_idx` ON `ticket_puestos` (`ticket_id`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_type_espacios' AND index_name = 'tte_espacio_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `tte_espacio_idx` ON `ticket_type_espacios` (`espacio_id`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


/* ── §4 · Las once claves ajenas ────────────────────────────────────────
 *
 * Ninguna otra tabla del volcado apunta a estas seis, así que no hay nada más
 * que reparar por ese lado. La única de fuera es la que añade la 007
 * (`ticket_movimientos` → `ticket_puestos`), y por eso la 007 va después.
 */
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas' AND constraint_name = 'espacio_reservas_espacio_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `espacio_reservas` ADD CONSTRAINT `espacio_reservas_espacio_id_fkey` FOREIGN KEY (`espacio_id`) REFERENCES `espacios` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas' AND constraint_name = 'espacio_reservas_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `espacio_reservas` ADD CONSTRAINT `espacio_reservas_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'espacio_reservas' AND constraint_name = 'espacio_reservas_ticket_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `espacio_reservas` ADD CONSTRAINT `espacio_reservas_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'espacios' AND constraint_name = 'espacios_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `espacios` ADD CONSTRAINT `espacios_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'espacios' AND constraint_name = 'espacios_parent_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `espacios` ADD CONSTRAINT `espacios_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `espacios` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'puesto_transferencias' AND constraint_name = 'puesto_transferencias_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `puesto_transferencias` ADD CONSTRAINT `puesto_transferencias_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'puesto_transferencias' AND constraint_name = 'puesto_transferencias_puesto_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `puesto_transferencias` ADD CONSTRAINT `puesto_transferencias_puesto_id_fkey` FOREIGN KEY (`puesto_id`) REFERENCES `ticket_puestos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND constraint_name = 'ticket_puestos_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD CONSTRAINT `ticket_puestos_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND constraint_name = 'ticket_puestos_ticket_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD CONSTRAINT `ticket_puestos_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_type_espacios' AND constraint_name = 'ticket_type_espacios_espacio_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_type_espacios` ADD CONSTRAINT `ticket_type_espacios_espacio_id_fkey` FOREIGN KEY (`espacio_id`) REFERENCES `espacios` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_type_espacios' AND constraint_name = 'ticket_type_espacios_ticket_type_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_type_espacios` ADD CONSTRAINT `ticket_type_espacios_ticket_type_id_fkey` FOREIGN KEY (`ticket_type_id`) REFERENCES `ticket_types` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


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


/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║  2 de 3 — 007_derechos_y_credenciales.sql                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */

-- 007 · Lo que incluye la boleta, y quién entra con ella — en MySQL
--
-- El espejo de cuatro migraciones de Postgres que entraron DESPUÉS del último
-- volcado de `db/esquema/`:
--
--   0125  el vaivén es de cada persona      (ticket_movimientos.puesto_id)
--   0126  derechos, ventanas y consumos     (tres tablas nuevas)
--   0127  la credencial de quien monta      (siete columnas)
--   0128  el que iba se enfermó             (una columna)
--
-- ── Por qué existe este archivo ────────────────────────────────────────
--
-- `db/esquema/` se GENERA leyendo Postgres (`generar-esquema-mysql.sql`), y hay
-- que regenerarlo después de cada migración. Mientras eso no se haga, quien
-- cargue el volcado tal cual se lleva una base sin estas tablas — y el modo de
-- fallo es el de siempre en este proyecto: no salta nada. El almuerzo no se
-- puede entregar, la acreditación del montaje no existe, y las pantallas salen
-- vacías como si nadie hubiera configurado nada.
--
-- Es el mismo caso que la 005: el volcado se quedó atrás y hace falta un
-- archivo que lo ponga al día. Si cuando leas esto el volcado ya se regeneró
-- con las cuatro dentro, esto no hace nada — todo va con `IF NOT EXISTS`.
--
-- ── Lo que NO se traduce ───────────────────────────────────────────────
--
-- Los índices únicos PARCIALES de la 0126 (`where ventana_id is not null`).
-- MySQL no los tiene, y ahí está el problema: son justamente lo que impide
-- entregar dos almuerzos a la misma persona. La solución de MySQL para eso
-- está abajo, y no es cosmética — leer el apartado 3 antes de tocar nada.

SET FOREIGN_KEY_CHECKS = 0;

-- ── 1 · 0125 · El vaivén es de cada persona ────────────────────────────
--
-- Sin esto, en una mesa de cuatro el escáner alterna entre ellos y el aforo de
-- la zona dice que no hay nadie mientras entran cuatro personas.

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_movimientos' AND column_name = 'puesto_id');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_movimientos` ADD COLUMN `puesto_id` CHAR(36) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_movimientos' AND index_name = 'ticket_movimientos_puesto_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `ticket_movimientos_puesto_idx` ON `ticket_movimientos` (`puesto_id`, `created_at` DESC)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 2 · 0127 y 0128 · La credencial ────────────────────────────────────

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'vigencia_desde');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `vigencia_desde` DATETIME(6) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'vigencia_hasta');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `vigencia_hasta` DATETIME(6) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'requiere_autorizacion');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `requiere_autorizacion` TINYINT(1) NOT NULL DEFAULT 0', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'visible_publico');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `visible_publico` TINYINT(1) NOT NULL DEFAULT 1', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'autoriza');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `autoriza` VARCHAR(255) NOT NULL DEFAULT ''evento''', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND column_name = 'foto_url');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD COLUMN `foto_url` TEXT NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND column_name = 'telefono');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD COLUMN `telefono` TEXT NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND column_name = 'autorizado_at');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD COLUMN `autorizado_at` DATETIME(6) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND column_name = 'autorizado_por');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD COLUMN `autorizado_por` TEXT NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND column_name = 'credencial_gen');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_puestos` ADD COLUMN `credencial_gen` INT NOT NULL DEFAULT 0', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ticket_puestos' AND index_name = 'ticket_puestos_por_autorizar_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `ticket_puestos_por_autorizar_idx` ON `ticket_puestos` (`evento_id`, `autorizado_at`)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── 3 · 0126 · Derechos, ventanas y consumos ───────────────────────────

CREATE TABLE IF NOT EXISTS `derechos` (
  `id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `nombre` TEXT NOT NULL,
  `descripcion` TEXT NULL,
  `titular` VARCHAR(255) NOT NULL DEFAULT 'persona',
  `cadencia` VARCHAR(255) NOT NULL DEFAULT 'ventana',
  `usos` INT NOT NULL DEFAULT 1,
  `aplica_tipos` JSON NOT NULL,
  `activo` TINYINT(1) NOT NULL DEFAULT 1,
  `orden` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `derechos_evento_idx` (`evento_id`, `activo`, `orden`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

CREATE TABLE IF NOT EXISTS `derecho_ventanas` (
  `id` CHAR(36) NOT NULL,
  `derecho_id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `nombre` TEXT NOT NULL,
  `inicio` DATETIME(6) NULL,
  `fin` DATETIME(6) NULL,
  `cupo` INT NULL,
  `orden` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `derecho_ventanas_derecho_idx` (`derecho_id`, `orden`),
  KEY `derecho_ventanas_evento_idx` (`evento_id`, `inicio`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- ── El que hay que leer antes de tocar ─────────────────────────────────
--
-- En Postgres, «una persona no recibe dos veces el mismo almuerzo» lo impone un
-- índice único PARCIAL:
--
--   unique (derecho_id, ventana_id, coalesce(puesto_id, ticket_id), uso_num)
--     where ventana_id is not null
--
-- MySQL no tiene índices parciales, y el `coalesce` de dos columnas tampoco
-- entra en una clave única normal. Traducirlo mal es fácil y el fallo no se ve:
-- un único sobre `(derecho_id, ventana_id, puesto_id, uso_num)` parece lo
-- mismo y NO lo es, porque en MySQL —igual que en Postgres— **dos NULL no son
-- iguales**, así que dos consumos de grupo (`puesto_id` nulo) pasarían los dos.
-- Es decir: el derecho de grupo se podría cobrar tantas veces como se quiera y
-- nadie vería un error.
--
-- La traducción correcta es una columna GENERADA que resuelve los dos nulos, y
-- el único encima de ella:
--
--   · `titular_id`  el puesto, o la boleta cuando no hay puesto
--   · `ventana_key` la ventana, o una cadena fija cuando no hay ventana
--
-- Con las dos, un solo índice único cubre los dos casos que en Postgres
-- necesitaban dos índices parciales.
--
-- ── Son `VIRTUAL`, y antes decían `STORED` ─────────────────────────────
--
-- El motivo que estaba escrito aquí —«MySQL 8 no admite índices únicos sobre
-- columnas virtuales»— **no es cierto**. Comprobado contra MySQL 8.0.46: un
-- `UNIQUE KEY` sobre una columna VIRTUAL se crea sin protestar y rechaza el
-- duplicado como debe.
--
-- Y `STORED` rompía este archivo. MySQL prohíbe poner una clave foránea sobre
-- la columna BASE de una columna generada almacenada, así que el bloque de
-- claves foráneas del §4 moría con:
--
--     ERROR 3192 · Cannot add foreign key on the base column of stored column
--
-- Las tres columnas de las que comen estas dos —`puesto_id`, `ticket_id`,
-- `ventana_id`— son justamente las que llevan clave foránea. Con el cliente de
-- MySQL parándose en el primer error, `derecho_consumos` se quedaba SIN
-- NINGUNA de sus cuatro claves foráneas, y `ticket_movimientos` sin la suya.
--
-- Con `VIRTUAL` desaparece la restricción, el único sigue valiendo igual, y de
-- paso no se ocupa disco: el motor las calcula al leer.

CREATE TABLE IF NOT EXISTS `derecho_consumos` (
  `id` CHAR(36) NOT NULL,
  `evento_id` CHAR(36) NOT NULL,
  `derecho_id` CHAR(36) NOT NULL,
  `ventana_id` CHAR(36) NULL,
  `ticket_id` CHAR(36) NOT NULL,
  `puesto_id` CHAR(36) NULL,
  `uso_num` INT NOT NULL DEFAULT 1,
  `operador_id` CHAR(36) NULL,
  `entregado_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `origen` VARCHAR(255) NOT NULL DEFAULT 'qr',
  `nota` TEXT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  -- Las dos que hacen posible la regla. No se escriben nunca a mano: las
  -- calcula el motor a partir de las de arriba, así que no se pueden quedar
  -- desacordadas con ellas.
  `titular_id`  CHAR(36) GENERATED ALWAYS AS (COALESCE(`puesto_id`, `ticket_id`)) VIRTUAL,
  `ventana_key` CHAR(36) GENERATED ALWAYS AS (COALESCE(`ventana_id`, '-')) VIRTUAL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `derecho_consumo_unico` (`derecho_id`, `ventana_key`, `titular_id`, `uso_num`),
  KEY `derecho_consumos_evento_idx` (`evento_id`, `entregado_at`),
  KEY `derecho_consumos_ventana_idx` (`ventana_id`, `entregado_at`),
  KEY `derecho_consumos_titular_idx` (`derecho_id`, `titular_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

-- ── 4 · Las claves foráneas ────────────────────────────────────────────
--
-- Aparte y al final, como en la 006: si una tabla referida todavía no está
-- cargada, esto falla ruidosamente en vez de dejar tablas a medias.

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derechos' AND constraint_name = 'derechos_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derechos` ADD CONSTRAINT `derechos_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derecho_ventanas' AND constraint_name = 'derecho_ventanas_derecho_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derecho_ventanas` ADD CONSTRAINT `derecho_ventanas_derecho_id_fkey` FOREIGN KEY (`derecho_id`) REFERENCES `derechos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derecho_ventanas' AND constraint_name = 'derecho_ventanas_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derecho_ventanas` ADD CONSTRAINT `derecho_ventanas_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derecho_consumos' AND constraint_name = 'derecho_consumos_derecho_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derecho_consumos` ADD CONSTRAINT `derecho_consumos_derecho_id_fkey` FOREIGN KEY (`derecho_id`) REFERENCES `derechos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derecho_consumos' AND constraint_name = 'derecho_consumos_ventana_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derecho_consumos` ADD CONSTRAINT `derecho_consumos_ventana_id_fkey` FOREIGN KEY (`ventana_id`) REFERENCES `derecho_ventanas` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derecho_consumos' AND constraint_name = 'derecho_consumos_ticket_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derecho_consumos` ADD CONSTRAINT `derecho_consumos_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'derecho_consumos' AND constraint_name = 'derecho_consumos_puesto_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `derecho_consumos` ADD CONSTRAINT `derecho_consumos_puesto_id_fkey` FOREIGN KEY (`puesto_id`) REFERENCES `ticket_puestos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_movimientos' AND constraint_name = 'ticket_movimientos_puesto_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_movimientos` ADD CONSTRAINT `ticket_movimientos_puesto_id_fkey` FOREIGN KEY (`puesto_id`) REFERENCES `ticket_puestos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET FOREIGN_KEY_CHECKS = 1;

-- ── Comprobación ───────────────────────────────────────────────────────
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = DATABASE()
--      AND table_name IN ('derechos','derecho_ventanas','derecho_consumos');
--
--   -- Y que la regla es de verdad. Con un derecho y una ventana creados,
--   -- correr el mismo INSERT dos veces: el segundo tiene que dar
--   -- «Duplicate entry … for key 'derecho_consumo_unico'».
--   -- Y otra vez con `puesto_id` NULL las dos, que es el caso de grupo — el
--   -- que un único mal traducido dejaría pasar en silencio.
--
--   -- Ninguna boleta de hoy cambió de comportamiento:
--   SELECT COUNT(*) FROM ticket_types
--    WHERE requiere_autorizacion = 1 OR visible_publico = 0 OR autoriza <> 'evento';
--   -- 0.
--   SELECT COUNT(*) FROM ticket_puestos WHERE credencial_gen <> 0;
--   -- 0.


/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║  3 de 3 — 008_la_puerta_y_la_tarjeta.sql                              ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */

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

-- ── 1 · 0129 · El NIT de quien se sienta en la rueda ───────────────────
--
-- `text` y no un número: un NIT no se suma, lleva dígito de verificación que
-- a veces va pegado con guion, y un documento extranjero puede traer ceros a
-- la izquierda. Se guarda como lo escribió quien lo escribió.
--
-- Opcional y sin único: la misma empresa puede tener ficha en dos eventos.

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'networking_expositores' AND column_name = 'nit');
SET @s = IF(@y = 0, 'ALTER TABLE `networking_expositores` ADD COLUMN `nit` TEXT NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- ── 2 · 0131 · La lista de la puerta ───────────────────────────────────
--
-- De los tres índices de la 0131, **sólo uno se traduce**.
--
-- El que sí: paginar la lista de asistentes de un evento. `id` al final
-- desempata cuando dos boletas se crearon en el mismo microsegundo — sin eso
-- la paginación repite o se salta filas.

SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'tickets' AND index_name = 'tickets_evento_creado_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `tickets_evento_creado_idx` ON `tickets` (`evento_id`, `created_at` DESC, `id` DESC)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

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

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'escarapela_impresa_at');
SET @s = IF(@y = 0, 'ALTER TABLE `tickets` ADD COLUMN `escarapela_impresa_at` DATETIME(6) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
-- Sin clave foránea a propósito, igual que en Postgres: un operador borrado
-- no debe llevarse por delante el registro de la impresión.
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'escarapela_impresa_por');
SET @s = IF(@y = 0, 'ALTER TABLE `tickets` ADD COLUMN `escarapela_impresa_por` CHAR(36) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- En Postgres este índice es PARCIAL (`where escarapela_impresa_at is null`).
-- MySQL no los tiene, y éste es de los 24 que NO son únicos: se le tira la
-- condición y ya, que es la regla de `NOTAS-ESQUEMA.md`. El índice resultante
-- cubre lo mismo y algo más —también las ya impresas— y sólo cuesta espacio.
--
-- Lo que se pierde es que el de Postgres se encogía solo a medida que
-- avanzaba la jornada. Aquí no, y da igual: no cambia ninguna respuesta.
SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'tickets' AND index_name = 'tickets_sin_imprimir_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `tickets_sin_imprimir_idx` ON `tickets` (`evento_id`, `created_at` DESC)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


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

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'contacto_oculto');
SET @s = IF(@y = 0, 'ALTER TABLE `tickets` ADD COLUMN `contacto_oculto` TINYINT(1) NOT NULL DEFAULT 0', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
-- Sólo las ocho claves que valida `lib/tarjetaContacto.js` (empresa, cargo,
-- email, telefono, whatsapp, web, linkedin, nota). NUNCA se llena con las
-- respuestas del formulario de registro: ésas traen documento, fecha de
-- nacimiento, etnia y discapacidad, y tienen otra finalidad y otra
-- autorización.
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'contacto');
SET @s = IF(@y = 0, 'ALTER TABLE `tickets` ADD COLUMN `contacto` JSON NOT NULL DEFAULT (CAST(''{}'' AS JSON))', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


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

SET @y = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'puerta_rechazos' AND index_name = 'puerta_rechazos_evento_idx');
SET @s = IF(@y = 0, 'CREATE INDEX `puerta_rechazos_evento_idx` ON `puerta_rechazos` (`evento_id`, `created_at` DESC)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- El `enable row level security` de la 0135 no se traduce: MySQL no tiene
-- RLS. Lo que allí era «sin políticas = cerrada» aquí lo hace
-- `core/permisos/`, que es lo que sustituye a RLS en toda la fase 6.


-- ── 6 · 0136 · Vigencia por duración ───────────────────────────────────
--
-- La 0127 dio a cada tipo de boleta una ventana FIJA. Ésta es la otra, la de
-- los pases: «válida 4 horas», «un día, el que elijas». No tiene fecha
-- propia — corre desde que la persona entra por primera vez.

SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'vigencia_cantidad');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `vigencia_cantidad` INT NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND column_name = 'vigencia_unidad');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD COLUMN `vigencia_unidad` TEXT NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND constraint_name = 'ticket_types_vigencia_unidad_chk' AND constraint_type = 'CHECK');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD CONSTRAINT `ticket_types_vigencia_unidad_chk` CHECK (`vigencia_unidad` IS NULL OR `vigencia_unidad` IN (''horas'',''dias'',''semanas''))', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'ticket_types' AND constraint_name = 'ticket_types_vigencia_cantidad_chk' AND constraint_type = 'CHECK');
SET @s = IF(@y = 0, 'ALTER TABLE `ticket_types` ADD CONSTRAINT `ticket_types_vigencia_cantidad_chk` CHECK (`vigencia_cantidad` IS NULL OR `vigencia_cantidad` > 0)', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- `checked_in_at` no sirve para esto: en un evento de varios días se
-- reescribe con cada entrada de un día nuevo. El primer ingreso se guarda
-- aparte y no se vuelve a tocar.
SET @y = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tickets' AND column_name = 'primer_ingreso_at');
SET @s = IF(@y = 0, 'ALTER TABLE `tickets` ADD COLUMN `primer_ingreso_at` DATETIME(6) NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

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
--   y `vendidos` no aparecen. Y hay **trece llamadas** a esas dos funciones en
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
--   (Hecho el 27-oct: `modules/contadores/` trae `sumarAforoVendido()` y
--   `sumarVendidosTipo()`, y las llamadas ya están cableadas — pasan todas por
--   `lib/contadores.js`, que decide el motor según `DATOS_PROPIOS`.
--
--   Y son TRECE, no diez: el conteo de diez que decía antes esta nota salió de
--   contar líneas de un `grep` donde una de las llamadas ocupa cuatro. Las
--   trece están contadas archivo por archivo en
--   `test/contadoresCableados.test.js`, que falla si aparece una catorceava
--   sin pasar por la costura.)
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

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'puerta_rechazos' AND constraint_name = 'puerta_rechazos_evento_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `puerta_rechazos` ADD CONSTRAINT `puerta_rechazos_evento_id_fkey` FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'puerta_rechazos' AND constraint_name = 'puerta_rechazos_ticket_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `puerta_rechazos` ADD CONSTRAINT `puerta_rechazos_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'puerta_rechazos' AND constraint_name = 'puerta_rechazos_operador_id_fkey' AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0, 'ALTER TABLE `puerta_rechazos` ADD CONSTRAINT `puerta_rechazos_operador_id_fkey` FOREIGN KEY (`operador_id`) REFERENCES `profiles` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


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
