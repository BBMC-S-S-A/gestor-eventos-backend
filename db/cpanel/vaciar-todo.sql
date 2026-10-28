/* VACIAR `gestek_datos` antes de cargar los datos de Supabase.
 *
 * ── Para qué ────────────────────────────────────────────────────────────
 *
 * La base trae un cargue de prueba viejo y a medias (162 boletas donde hay
 * 4.977, 32 perfiles donde hay 96). Si se suben los archivos encima, las
 * filas que ya estén chocan con «ERROR 1062 Duplicate entry» — y las que no
 * choquen se quedan mezcladas con las nuevas, sin forma de saber cuáles son
 * cuáles.
 *
 * ── Por qué en este orden ───────────────────────────────────────────────
 *
 * Es el orden de carga AL REVÉS. Una tabla no se puede vaciar mientras otra
 * todavía la apunte: las claves ajenas están encendidas y lo impiden.
 *
 * ── Esto BORRA datos ────────────────────────────────────────────────────
 *
 * Los de `gestek_datos`, que hoy son un cargue de prueba. NO toca:
 *   · Supabase, que sigue siendo la base en producción.
 *   · `gestek_auth`, donde viven las cuentas.
 *   · `archivos`, que no es del volcado y se queda como está.
 *
 * Antes de correrlo, mire qué hay con `que-hay-en-la-base.sql`.
 *
 * ── Se puede correr dos veces ───────────────────────────────────────────
 *
 * Vaciar lo ya vacío no hace nada. Va cualificado con `gestek_datos.` para
 * que corra desde cualquier pestaña de phpMyAdmin.
 */

SET NAMES utf8mb4;

DELETE FROM `gestek_datos`.`ticket_interacciones`;
DELETE FROM `gestek_datos`.`sesion_inscripciones`;
DELETE FROM `gestek_datos`.`networking_citas`;
DELETE FROM `gestek_datos`.`event_form_fields`;
DELETE FROM `gestek_datos`.`canjes`;
DELETE FROM `gestek_datos`.`agenda_favoritos`;
DELETE FROM `gestek_datos`.`torneo_ronda_participantes`;
DELETE FROM `gestek_datos`.`torneo_partidos`;
DELETE FROM `gestek_datos`.`torneo_calificaciones`;
DELETE FROM `gestek_datos`.`ticket_movimientos`;
DELETE FROM `gestek_datos`.`recompensas`;
DELETE FROM `gestek_datos`.`puesto_transferencias`;
DELETE FROM `gestek_datos`.`networking_horarios`;
DELETE FROM `gestek_datos`.`evento_motivos`;
DELETE FROM `gestek_datos`.`derecho_consumos`;
DELETE FROM `gestek_datos`.`agenda_sessions`;
DELETE FROM `gestek_datos`.`torneo_equipos`;
DELETE FROM `gestek_datos`.`ticket_puestos`;
DELETE FROM `gestek_datos`.`puerta_rechazos`;
DELETE FROM `gestek_datos`.`payment_transactions`;
DELETE FROM `gestek_datos`.`networking_expositores`;
DELETE FROM `gestek_datos`.`espacio_reservas`;
DELETE FROM `gestek_datos`.`email_log`;
DELETE FROM `gestek_datos`.`tickets`;
DELETE FROM `gestek_datos`.`ticket_type_espacios`;
DELETE FROM `gestek_datos`.`talento_resenas`;
DELETE FROM `gestek_datos`.`promociones`;
DELETE FROM `gestek_datos`.`event_waitlist`;
DELETE FROM `gestek_datos`.`cobros_vacantes`;
DELETE FROM `gestek_datos`.`torneo_rondas`;
DELETE FROM `gestek_datos`.`torneo_jurados`;
DELETE FROM `gestek_datos`.`torneo_criterios`;
DELETE FROM `gestek_datos`.`ticket_types`;
DELETE FROM `gestek_datos`.`tarea_log`;
DELETE FROM `gestek_datos`.`postulaciones`;
DELETE FROM `gestek_datos`.`vacantes`;
DELETE FROM `gestek_datos`.`torneos`;
DELETE FROM `gestek_datos`.`tareas`;
DELETE FROM `gestek_datos`.`evento_email_envios`;
DELETE FROM `gestek_datos`.`event_members`;
DELETE FROM `gestek_datos`.`derecho_ventanas`;
DELETE FROM `gestek_datos`.`chat_messages`;
DELETE FROM `gestek_datos`.`chat_channel_prefs`;
DELETE FROM `gestek_datos`.`zonas`;
DELETE FROM `gestek_datos`.`zona_cortes`;
DELETE FROM `gestek_datos`.`webhook_deliveries`;
DELETE FROM `gestek_datos`.`user_badges`;
DELETE FROM `gestek_datos`.`torneo_categorias`;
DELETE FROM `gestek_datos`.`sugerencias_dinamica`;
DELETE FROM `gestek_datos`.`sponsors`;
DELETE FROM `gestek_datos`.`speakers`;
DELETE FROM `gestek_datos`.`points_log`;
DELETE FROM `gestek_datos`.`padron_previo`;
DELETE FROM `gestek_datos`.`notificaciones`;
DELETE FROM `gestek_datos`.`evento_smtp`;
DELETE FROM `gestek_datos`.`evento_legal`;
DELETE FROM `gestek_datos`.`evento_email_plantillas`;
DELETE FROM `gestek_datos`.`evento_bolsa_puntos`;
DELETE FROM `gestek_datos`.`evento_anuncios`;
DELETE FROM `gestek_datos`.`evento_alertas`;
DELETE FROM `gestek_datos`.`event_views`;
DELETE FROM `gestek_datos`.`event_roles`;
DELETE FROM `gestek_datos`.`event_requests`;
DELETE FROM `gestek_datos`.`espacios`;
DELETE FROM `gestek_datos`.`email_cola`;
DELETE FROM `gestek_datos`.`discount_codes`;
DELETE FROM `gestek_datos`.`derechos`;
DELETE FROM `gestek_datos`.`chat_channels`;
DELETE FROM `gestek_datos`.`audit_log`;
DELETE FROM `gestek_datos`.`webhooks`;
DELETE FROM `gestek_datos`.`sugerencias_catalogo`;
DELETE FROM `gestek_datos`.`push_subscriptions`;
DELETE FROM `gestek_datos`.`puntos_balance`;
DELETE FROM `gestek_datos`.`perfil_talento`;
DELETE FROM `gestek_datos`.`oauth_tokens`;
DELETE FROM `gestek_datos`.`oauth_codes`;
DELETE FROM `gestek_datos`.`eventos`;
DELETE FROM `gestek_datos`.`catalogo_roles`;
DELETE FROM `gestek_datos`.`api_tokens`;
DELETE FROM `gestek_datos`.`recintos`;
DELETE FROM `gestek_datos`.`profiles`;
DELETE FROM `gestek_datos`.`organizador_conexiones`;
DELETE FROM `gestek_datos`.`oauth_clients`;
DELETE FROM `gestek_datos`.`categorias`;

/* ── Comprobación: tiene que dar 0 ──────────────────────────────────────
 * Vuelva a correr `que-hay-en-la-base.sql`. No debería devolver ninguna
 * fila, salvo `archivos` si la tuviera con datos.
 */
