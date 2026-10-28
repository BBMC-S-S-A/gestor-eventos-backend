/* Las 23 columnas que le faltan a `gestek_datos`
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ── De dónde salieron ──────────────────────────────────────────────────
 *
 * De un «#1054 La columna 'networking_activo' es desconocida» al cargar el
 * bloque de `eventos`. Comprobar las tablas (85) y las claves ajenas (182)
 * no bastaba: una tabla puede existir con la mitad de sus columnas y nada lo
 * dice hasta que un INSERT las nombra.
 *
 * El esquema canónico tiene 976 columnas en sus tablas base (1.006 contando
 * las de las cuatro vistas, que no son columnas de verdad); a `gestek_datos`
 * le faltaban 23
 * en 7 tablas. Ninguna sobraba, así que no hay datos suyos en juego.
 *
 * ── Las definiciones no están escritas a mano ──────────────────────────
 *
 * Salen de `SHOW CREATE TABLE` sobre un cargue desde cero: el mismo tipo, la
 * misma colación, el mismo DEFAULT y la misma posición. Copiarlas a ojo es
 * como se llega a un TEXT donde debía ir un VARCHAR(255) — y eso no da
 * error, da una columna que no se puede indexar el día que haga falta.
 *
 * ── El orden de los ALTER no es alfabético, y tiene que serlo así ──────
 *
 * Cada columna se añade con `AFTER <la anterior>` para que la tabla quede en
 * el mismo orden que el esquema. Eso obliga a añadirlas en el orden del
 * esquema: cuatro de las de `networking_citas` van seguidas, y alfabético
 * habría puesto `expectativa_moneda` AFTER `expectativa_monto` antes de que
 * `expectativa_monto` existiera. Sale «#1054 Unknown column», y se vio
 * probándolo.
 *
 * ── Se puede correr dos veces ──────────────────────────────────────────
 *
 * Cada columna mira antes de añadirse. Sin procedimientos almacenados (el
 * usuario de cPanel no los puede crear: #1227) y todo cualificado con
 * `gestek_datos.`, así que corre desde cualquier pestaña.
 *
 * ── No toca ningún dato ────────────────────────────────────────────────
 *
 * Son columnas nuevas: las filas que ya estén se quedan con el valor por
 * defecto, que es lo correcto — nunca tuvieron otro.
 */

SET NAMES utf8mb4;


/* ── event_form_fields ─────────────────────────────────────────────── */
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'event_form_fields' AND column_name = 'max_caracteres');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`event_form_fields` ADD COLUMN `max_caracteres` int DEFAULT NULL AFTER `torneo_id`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'event_form_fields' AND column_name = 'max_palabras');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`event_form_fields` ADD COLUMN `max_palabras` int DEFAULT NULL AFTER `max_caracteres`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'event_form_fields' AND column_name = 'sensible');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`event_form_fields` ADD COLUMN `sensible` tinyint(1) NOT NULL DEFAULT ''0'' AFTER `max_palabras`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ── eventos ─────────────────────────────────────────────── */
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'eventos' AND column_name = 'networking_activo');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`eventos` ADD COLUMN `networking_activo` tinyint(1) NOT NULL DEFAULT ''0'' AFTER `networking_modo`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'eventos' AND column_name = 'networking_tope_por_empresa');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`eventos` ADD COLUMN `networking_tope_por_empresa` int DEFAULT NULL AFTER `networking_activo`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ── networking_citas ─────────────────────────────────────────────── */
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'guest_email');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `guest_email` varchar(255) COLLATE utf8mb4_0900_as_ci DEFAULT NULL AFTER `creada_por`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'guest_nombre');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `guest_nombre` text COLLATE utf8mb4_0900_as_ci AFTER `guest_email`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'resultado');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `resultado` varchar(255) COLLATE utf8mb4_0900_as_ci DEFAULT NULL AFTER `guest_nombre`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'resultado_at');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `resultado_at` datetime(6) DEFAULT NULL AFTER `resultado`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'resultado_por');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `resultado_por` char(36) COLLATE utf8mb4_0900_as_ci DEFAULT NULL AFTER `resultado_at`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'expectativa_monto');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `expectativa_monto` decimal(14,2) DEFAULT NULL AFTER `resultado_por`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'expectativa_moneda');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `expectativa_moneda` text COLLATE utf8mb4_0900_as_ci AFTER `expectativa_monto`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'expectativa_plazo');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `expectativa_plazo` text COLLATE utf8mb4_0900_as_ci AFTER `expectativa_moneda`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'hubo_acuerdo');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `hubo_acuerdo` tinyint(1) DEFAULT NULL AFTER `expectativa_plazo`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'resultado_nota');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `resultado_nota` text COLLATE utf8mb4_0900_as_ci AFTER `hubo_acuerdo`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_citas' AND column_name = 'recordatorio_at');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_citas` ADD COLUMN `recordatorio_at` datetime(6) DEFAULT NULL AFTER `resultado_nota`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ── networking_horarios ─────────────────────────────────────────────── */
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_horarios' AND column_name = 'bloqueado');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_horarios` ADD COLUMN `bloqueado` tinyint(1) NOT NULL DEFAULT ''0'' AFTER `created_at`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'networking_horarios' AND column_name = 'bloqueo_motivo');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`networking_horarios` ADD COLUMN `bloqueo_motivo` text COLLATE utf8mb4_0900_as_ci AFTER `bloqueado`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ── ticket_types ─────────────────────────────────────────────── */
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'ticket_types' AND column_name = 'modo_entrada');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`ticket_types` ADD COLUMN `modo_entrada` text COLLATE utf8mb4_0900_as_ci NOT NULL DEFAULT (_latin1''individual'') AFTER `crea_torneo_id`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'ticket_types' AND column_name = 'color');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`ticket_types` ADD COLUMN `color` text COLLATE utf8mb4_0900_as_ci AFTER `modo_entrada`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'ticket_types' AND column_name = 'rol');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`ticket_types` ADD COLUMN `rol` text COLLATE utf8mb4_0900_as_ci NOT NULL DEFAULT (_latin1''entrada'') AFTER `color`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'ticket_types' AND column_name = 'instrucciones');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`ticket_types` ADD COLUMN `instrucciones` text COLLATE utf8mb4_0900_as_ci AFTER `rol`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

/* ── tickets ─────────────────────────────────────────────── */
SET @y = (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'gestek_datos' AND table_name = 'tickets' AND column_name = 'origen');
SET @s = IF(@y = 0, 'ALTER TABLE `gestek_datos`.`tickets` ADD COLUMN `origen` varchar(255) COLLATE utf8mb4_0900_as_ci DEFAULT NULL AFTER `promocion_id`', 'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


/* ── Comprobación ───────────────────────────────────────────────────────
 * Tiene que dar 976: las columnas de las 84 tablas del esquema. `archivos`
 * queda fuera porque no es del volcado, y las vistas también — sus columnas
 * las calcula MySQL. */

SELECT COUNT(*) AS columnas_esperado_976
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
 WHERE c.table_schema = 'gestek_datos' AND c.table_name <> 'archivos';
