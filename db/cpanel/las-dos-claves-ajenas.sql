/* ═══════════════════════════════════════════════════════════════════════════
 * Las DOS claves ajenas que faltan en `gestek_datos`
 * ───────────────────────────────────────────────────────────────────────────
 * Salieron de comparar su base (180) contra un cargue desde cero (182):
 *
 *     torneo_jurados.user_id          -> profiles.id
 *     torneo_calificaciones.jurado_id -> profiles.id
 *
 * POR QUÉ FALTAN
 * La migración 006 crea las tablas de torneos, pero sólo pone CINCO de sus
 * claves ajenas; estas dos viven en `05_claves_foraneas.sql`, que corrió
 * ANTES — cuando las tablas de torneos todavía no existían. Así que se las
 * saltó, y nadie lo notó.
 *
 * QUÉ IMPIDEN
 * Que quede un jurado o una calificación apuntando a un usuario que ya no
 * existe. Sin ellas, al borrar un usuario quedan filas huérfanas y el panel
 * de calificaciones muestra un jurado fantasma.
 *
 * CÓMO SE CORRE
 *   phpMyAdmin -> clic en `gestek_datos` -> pestaña SQL -> pegar -> Continuar.
 *   Se puede correr dos veces: mira antes de crear.
 *
 * SI SALE «ERROR 1452 Cannot add or update a child row»
 * Es que YA hay huérfanos. El §1 de abajo los encuentra ANTES de intentarlo:
 * córralo primero, y si devuelve filas, me las manda y vemos qué hacer con
 * ellas (normalmente se ponen en NULL o se borran, pero eso se decide
 * mirándolas, no a ciegas).
 * ═══════════════════════════════════════════════════════════════════════════ */


/* ── §1 · PRIMERO: ¿hay huérfanos? ──────────────────────────────────────
 * Las dos consultas tienen que devolver CERO filas. Si devuelven algo, NO
 * siga al §2 todavía. */

SELECT 'torneo_jurados' AS tabla, j.torneo_id, j.user_id AS apunta_a_un_usuario_que_no_existe
  FROM torneo_jurados j
  LEFT JOIN profiles p ON p.id = j.user_id
 WHERE j.user_id IS NOT NULL AND p.id IS NULL;

SELECT 'torneo_calificaciones' AS tabla, c.id, c.jurado_id AS apunta_a_un_usuario_que_no_existe
  FROM torneo_calificaciones c
  LEFT JOIN profiles p ON p.id = c.jurado_id
 WHERE c.jurado_id IS NOT NULL AND p.id IS NULL;


/* ── §2 · Las dos claves ajenas ─────────────────────────────────────────
 * Sin procedimientos almacenados (el usuario de cPanel no puede crearlos:
 * #1227 SYSTEM_USER). Cada una mira antes de crear, con PREPARE/EXECUTE. */

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema = DATABASE() AND table_name = 'torneo_jurados'
             AND constraint_name = 'torneo_jurados_user_id_fkey'
             AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0,
  'ALTER TABLE `torneo_jurados` ADD CONSTRAINT `torneo_jurados_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @y = (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema = DATABASE() AND table_name = 'torneo_calificaciones'
             AND constraint_name = 'torneo_calificaciones_jurado_id_fkey'
             AND constraint_type = 'FOREIGN KEY');
SET @s = IF(@y = 0,
  'ALTER TABLE `torneo_calificaciones` ADD CONSTRAINT `torneo_calificaciones_jurado_id_fkey` FOREIGN KEY (`jurado_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE',
  'DO 0');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


/* ── §3 · Comprobación ──────────────────────────────────────────────────
 * Tiene que dar 182. */

SELECT COUNT(*) AS claves_ajenas_esperado_182
  FROM information_schema.table_constraints
 WHERE table_schema = 'gestek_datos' AND constraint_type = 'FOREIGN KEY';
