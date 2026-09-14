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

DROP PROCEDURE IF EXISTS gestek_add_col;
DROP PROCEDURE IF EXISTS gestek_add_idx;
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
DELIMITER ;

-- ── 1 · 0125 · El vaivén es de cada persona ────────────────────────────
--
-- Sin esto, en una mesa de cuatro el escáner alterna entre ellos y el aforo de
-- la zona dice que no hay nadie mientras entran cuatro personas.

CALL gestek_add_col('ticket_movimientos', 'puesto_id', "CHAR(36) NULL");
CALL gestek_add_idx('ticket_movimientos', 'ticket_movimientos_puesto_idx', '`puesto_id`, `created_at` DESC');

-- ── 2 · 0127 y 0128 · La credencial ────────────────────────────────────

CALL gestek_add_col('ticket_types', 'vigencia_desde',        "DATETIME(6) NULL");
CALL gestek_add_col('ticket_types', 'vigencia_hasta',        "DATETIME(6) NULL");
CALL gestek_add_col('ticket_types', 'requiere_autorizacion', "TINYINT(1) NOT NULL DEFAULT 0");
CALL gestek_add_col('ticket_types', 'visible_publico',       "TINYINT(1) NOT NULL DEFAULT 1");
CALL gestek_add_col('ticket_types', 'autoriza',              "VARCHAR(255) NOT NULL DEFAULT 'evento'");

CALL gestek_add_col('ticket_puestos', 'foto_url',       "TEXT NULL");
CALL gestek_add_col('ticket_puestos', 'telefono',       "TEXT NULL");
CALL gestek_add_col('ticket_puestos', 'autorizado_at',  "DATETIME(6) NULL");
CALL gestek_add_col('ticket_puestos', 'autorizado_por', "TEXT NULL");
CALL gestek_add_col('ticket_puestos', 'credencial_gen', "INT NOT NULL DEFAULT 0");

CALL gestek_add_idx('ticket_puestos', 'ticket_puestos_por_autorizar_idx', '`evento_id`, `autorizado_at`');

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
-- necesitaban dos índices parciales. Son `STORED` y no `VIRTUAL` porque MySQL
-- 8 no admite índices únicos sobre columnas virtuales.

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
  `titular_id`  CHAR(36) GENERATED ALWAYS AS (COALESCE(`puesto_id`, `ticket_id`)) STORED,
  `ventana_key` CHAR(36) GENERATED ALWAYS AS (COALESCE(`ventana_id`, '-')) STORED,

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

ALTER TABLE `derechos`
  ADD CONSTRAINT `derechos_evento_id_fkey`
  FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE;

ALTER TABLE `derecho_ventanas`
  ADD CONSTRAINT `derecho_ventanas_derecho_id_fkey`
  FOREIGN KEY (`derecho_id`) REFERENCES `derechos` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `derecho_ventanas_evento_id_fkey`
  FOREIGN KEY (`evento_id`) REFERENCES `eventos` (`id`) ON DELETE CASCADE;

ALTER TABLE `derecho_consumos`
  ADD CONSTRAINT `derecho_consumos_derecho_id_fkey`
  FOREIGN KEY (`derecho_id`) REFERENCES `derechos` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `derecho_consumos_ventana_id_fkey`
  FOREIGN KEY (`ventana_id`) REFERENCES `derecho_ventanas` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `derecho_consumos_ticket_id_fkey`
  FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `derecho_consumos_puesto_id_fkey`
  FOREIGN KEY (`puesto_id`) REFERENCES `ticket_puestos` (`id`) ON DELETE CASCADE;

ALTER TABLE `ticket_movimientos`
  ADD CONSTRAINT `ticket_movimientos_puesto_id_fkey`
  FOREIGN KEY (`puesto_id`) REFERENCES `ticket_puestos` (`id`) ON DELETE CASCADE;

DROP PROCEDURE IF EXISTS gestek_add_col;
DROP PROCEDURE IF EXISTS gestek_add_idx;

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
