/* ¿Está MySQL listo para encender DATOS_PROPIOS?
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Es `scripts/listo-para-datos.js` en SQL, para cuando no hay forma cómoda
 * de correr Node en el servidor. Comprueba lo mismo salvo dos cosas que no
 * son de la base: que el adaptador cargue (lo cubren las 1.533 pruebas del
 * repositorio) y cómo está la bandera ahora (eso se ve en el panel).
 *
 * NO CAMBIA NADA. Sólo cuenta y compara.
 *
 * Cómo se corre: phpMyAdmin -> pestaña SQL -> pegar -> Continuar.
 * Va cualificado con `gestek_datos.`, así que da igual qué base tenga
 * seleccionada.
 *
 * ── Cómo se lee ────────────────────────────────────────────────────────
 *
 * Una fila por comprobación, con una columna `veredicto`. **Todas tienen
 * que decir OK.** La que diga `REVISAR` es la que hay que mirar, y la
 * columna `detalle` dice qué se esperaba.
 */

SELECT 'base en utf8mb4' AS comprueba,
       DEFAULT_CHARACTER_SET_NAME AS encontrado,
       'utf8mb4' AS esperado,
       IF(DEFAULT_CHARACTER_SET_NAME = 'utf8mb4', 'OK', 'REVISAR') AS veredicto,
       'utf8mb3 no da error: guarda las tildes mal y se ve semanas después' AS detalle
  FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'gestek_datos'

UNION ALL
SELECT 'tablas del volcado',
       CAST(COUNT(*) AS CHAR), '84',
       IF(COUNT(*) = 84, 'OK', 'REVISAR'),
       'sin contar `archivos`, que no es del volcado'
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'gestek_datos' AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'archivos'

UNION ALL
SELECT 'columnas',
       CAST(COUNT(*) AS CHAR), '976',
       IF(COUNT(*) = 976, 'OK', 'REVISAR'),
       'una tabla puede existir a medias y nada lo dice hasta que un INSERT la nombra'
  FROM information_schema.COLUMNS c
  JOIN information_schema.TABLES t
    ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       AND t.TABLE_TYPE = 'BASE TABLE'
 WHERE c.TABLE_SCHEMA = 'gestek_datos' AND c.TABLE_NAME <> 'archivos'

UNION ALL
SELECT 'claves ajenas',
       CAST(COUNT(*) AS CHAR), '182',
       IF(COUNT(*) = 182, 'OK', 'REVISAR'),
       'son las que impiden una boleta sin evento'
  FROM information_schema.TABLE_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA = 'gestek_datos' AND CONSTRAINT_TYPE = 'FOREIGN KEY'

UNION ALL
SELECT 'indices anti-duplicados',
       CAST(COUNT(DISTINCT INDEX_NAME) AS CHAR), '7',
       IF(COUNT(DISTINCT INDEX_NAME) = 7, 'OK', 'REVISAR'),
       'sin ellos la base acepta dos filas que no pueden existir a la vez'
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = 'gestek_datos'
   AND INDEX_NAME IN ('catalogo_roles_slug_global_uidx','sesion_inscripciones_email_uidx',
                      'torneo_categorias_unica_raiz','torneo_categorias_unica_hija',
                      'espacio_reservas_una_viva','ticket_puestos_token_idx',
                      'derecho_consumo_unico')

UNION ALL
SELECT 'hay datos cargados',
       CONCAT((SELECT COUNT(*) FROM `gestek_datos`.`tickets`), ' boletas, ',
              (SELECT COUNT(*) FROM `gestek_datos`.`profiles`), ' perfiles'),
       '4977 boletas, 96 perfiles',
       IF((SELECT COUNT(*) FROM `gestek_datos`.`tickets`)   > 0
      AND (SELECT COUNT(*) FROM `gestek_datos`.`profiles`)  > 0
      AND (SELECT COUNT(*) FROM `gestek_datos`.`eventos`)   > 0
      AND (SELECT COUNT(*) FROM `gestek_datos`.`ticket_types`) > 0
      AND (SELECT COUNT(*) FROM `gestek_datos`.`event_members`) > 0, 'OK', 'REVISAR'),
       'si alguna esta vacia, el cargue no se hizo o quedo a medias'

UNION ALL
SELECT 'el servidor lee en UTC',
       CONCAT(@@session.time_zone, ' (', TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW())/3600, ' h)'),
       '0 h de diferencia',
       IF(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) = 0, 'OK', 'REVISAR'),
       'las fechas se cargaron en UTC; en otra zona saldrian corridas';
