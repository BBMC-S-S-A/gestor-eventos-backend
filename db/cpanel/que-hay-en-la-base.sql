-- ¿Qué tablas de `gestek_datos` tienen datos hoy?
-- Devuelve SÓLO las que no están vacías. Si no devuelve nada, la base
-- está limpia y no hace falta el 00_vaciar.sql.
-- Corre desde cualquier pestaña: todo va cualificado con gestek_datos.

SELECT * FROM (
SELECT 'agenda_favoritos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`agenda_favoritos`
UNION ALL
SELECT 'agenda_sessions' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`agenda_sessions`
UNION ALL
SELECT 'api_tokens' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`api_tokens`
UNION ALL
SELECT 'audit_log' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`audit_log`
UNION ALL
SELECT 'canjes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`canjes`
UNION ALL
SELECT 'catalogo_roles' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`catalogo_roles`
UNION ALL
SELECT 'categorias' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`categorias`
UNION ALL
SELECT 'chat_channel_prefs' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`chat_channel_prefs`
UNION ALL
SELECT 'chat_channels' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`chat_channels`
UNION ALL
SELECT 'chat_messages' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`chat_messages`
UNION ALL
SELECT 'cobros_vacantes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`cobros_vacantes`
UNION ALL
SELECT 'derecho_consumos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`derecho_consumos`
UNION ALL
SELECT 'derecho_ventanas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`derecho_ventanas`
UNION ALL
SELECT 'derechos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`derechos`
UNION ALL
SELECT 'discount_codes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`discount_codes`
UNION ALL
SELECT 'email_cola' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`email_cola`
UNION ALL
SELECT 'email_log' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`email_log`
UNION ALL
SELECT 'espacio_reservas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`espacio_reservas`
UNION ALL
SELECT 'espacios' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`espacios`
UNION ALL
SELECT 'event_form_fields' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`event_form_fields`
UNION ALL
SELECT 'event_members' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`event_members`
UNION ALL
SELECT 'event_requests' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`event_requests`
UNION ALL
SELECT 'event_roles' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`event_roles`
UNION ALL
SELECT 'event_views' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`event_views`
UNION ALL
SELECT 'event_waitlist' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`event_waitlist`
UNION ALL
SELECT 'evento_alertas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_alertas`
UNION ALL
SELECT 'evento_anuncios' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_anuncios`
UNION ALL
SELECT 'evento_bolsa_puntos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_bolsa_puntos`
UNION ALL
SELECT 'evento_email_envios' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_email_envios`
UNION ALL
SELECT 'evento_email_plantillas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_email_plantillas`
UNION ALL
SELECT 'evento_legal' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_legal`
UNION ALL
SELECT 'evento_motivos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_motivos`
UNION ALL
SELECT 'evento_smtp' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`evento_smtp`
UNION ALL
SELECT 'eventos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`eventos`
UNION ALL
SELECT 'networking_citas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`networking_citas`
UNION ALL
SELECT 'networking_expositores' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`networking_expositores`
UNION ALL
SELECT 'networking_horarios' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`networking_horarios`
UNION ALL
SELECT 'notificaciones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`notificaciones`
UNION ALL
SELECT 'oauth_clients' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`oauth_clients`
UNION ALL
SELECT 'oauth_codes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`oauth_codes`
UNION ALL
SELECT 'oauth_tokens' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`oauth_tokens`
UNION ALL
SELECT 'organizador_conexiones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`organizador_conexiones`
UNION ALL
SELECT 'padron_previo' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`padron_previo`
UNION ALL
SELECT 'payment_transactions' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`payment_transactions`
UNION ALL
SELECT 'perfil_talento' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`perfil_talento`
UNION ALL
SELECT 'points_log' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`points_log`
UNION ALL
SELECT 'postulaciones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`postulaciones`
UNION ALL
SELECT 'profiles' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`profiles`
UNION ALL
SELECT 'promociones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`promociones`
UNION ALL
SELECT 'puerta_rechazos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`puerta_rechazos`
UNION ALL
SELECT 'puesto_transferencias' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`puesto_transferencias`
UNION ALL
SELECT 'puntos_balance' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`puntos_balance`
UNION ALL
SELECT 'push_subscriptions' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`push_subscriptions`
UNION ALL
SELECT 'recintos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`recintos`
UNION ALL
SELECT 'recompensas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`recompensas`
UNION ALL
SELECT 'sesion_inscripciones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`sesion_inscripciones`
UNION ALL
SELECT 'speakers' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`speakers`
UNION ALL
SELECT 'sponsors' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`sponsors`
UNION ALL
SELECT 'sugerencias_catalogo' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`sugerencias_catalogo`
UNION ALL
SELECT 'sugerencias_dinamica' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`sugerencias_dinamica`
UNION ALL
SELECT 'talento_resenas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`talento_resenas`
UNION ALL
SELECT 'tarea_log' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`tarea_log`
UNION ALL
SELECT 'tareas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`tareas`
UNION ALL
SELECT 'ticket_interacciones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`ticket_interacciones`
UNION ALL
SELECT 'ticket_movimientos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`ticket_movimientos`
UNION ALL
SELECT 'ticket_puestos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`ticket_puestos`
UNION ALL
SELECT 'ticket_type_espacios' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`ticket_type_espacios`
UNION ALL
SELECT 'ticket_types' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`ticket_types`
UNION ALL
SELECT 'tickets' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`tickets`
UNION ALL
SELECT 'torneo_calificaciones' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_calificaciones`
UNION ALL
SELECT 'torneo_categorias' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_categorias`
UNION ALL
SELECT 'torneo_criterios' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_criterios`
UNION ALL
SELECT 'torneo_equipos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_equipos`
UNION ALL
SELECT 'torneo_jurados' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_jurados`
UNION ALL
SELECT 'torneo_partidos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_partidos`
UNION ALL
SELECT 'torneo_ronda_participantes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_ronda_participantes`
UNION ALL
SELECT 'torneo_rondas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneo_rondas`
UNION ALL
SELECT 'torneos' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`torneos`
UNION ALL
SELECT 'user_badges' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`user_badges`
UNION ALL
SELECT 'vacantes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`vacantes`
UNION ALL
SELECT 'webhook_deliveries' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`webhook_deliveries`
UNION ALL
SELECT 'webhooks' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`webhooks`
UNION ALL
SELECT 'zona_cortes' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`zona_cortes`
UNION ALL
SELECT 'zonas' AS tabla, COUNT(*) AS filas FROM `gestek_datos`.`zonas`
) x WHERE filas > 0 ORDER BY filas DESC;
