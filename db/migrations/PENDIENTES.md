# Migraciones pendientes en Supabase

**Queda media: la segunda mitad de la 0126.** Estado comprobado contra la base
real el 2026-09-17, preguntando por los objetos, no por lo que diga este
archivo — que antes decía «No queda ninguna» y era falso.

## Lo aplicado el 2026-09-17

| Nº | Qué | Estado |
|---|---|---|
| 0125 | `ticket_movimientos.puesto_id` + su índice parcial | ✅ aplicada |
| 0126 · tablas | `derechos`, `derecho_ventanas`, `derecho_consumos`, sus índices y los dos únicos | ✅ aplicada |
| 0126 · RLS | `enable row level security` en las tres | ✅ aplicada — **no venía en la migración**, se añadió |

Las dos estaban escritas desde hacía días y nunca se habían corrido, mientras
que la 0127 y la 0128 —posteriores— sí. No era una cola a medias: eran dos
salteadas. Por eso mirar el número más alto no dice qué falta.

## Lo que FALTA: el permiso `entregar`

La 0126 tiene una segunda mitad que no se aplicó: redefine
`private.fn_roles_semilla()` para que el rol Administrador nazca con el permiso
`entregar`, y luego se lo añade a los roles que ya existen:

```sql
update public.event_roles r
   set permissions = coalesce(
         (select jsonb_agg(distinct p)
            from jsonb_array_elements_text(r.permissions || '["entregar"]'::jsonb) p),
         r.permissions)
 where r.permissions ? 'editar_evento'
   and not (r.permissions ? 'entregar');
```

**Hoy hay 114 roles con `editar_evento` y sin `entregar`.** Mientras eso no
corra, las tablas están pero nadie tiene permiso de entregar nada: los
refrigerios siguen sin poder usarse, sólo que ahora el motivo es otro.

Es un `update` sobre permisos de todos los eventos, así que conviene correrlo a
la vista de alguien y no dentro de un lote. Comprobación después:

```sql
select count(*) from public.event_roles
 where permissions ? 'editar_evento' and not (permissions ? 'entregar');
-- tiene que dar 0
```

## Cómo se comprueba todo lo demás

```sql
select to_regclass('public.derechos')         as t1,
       to_regclass('public.derecho_ventanas') as t2,
       to_regclass('public.derecho_consumos') as t3,
       (select count(*) from information_schema.columns
          where table_name='ticket_movimientos' and column_name='puesto_id') as c0125;
```

Las tres tablas con nombre y `c0125 = 1`. Verificado el 2026-09-17.

## Y lo que hace falta DESPUÉS

La 0126 no enciende nada por sí sola: sin código que cree derechos, las tablas
se quedan vacías. Lo que falta —endpoint de entrega, pantalla y reporte— está
en `docs/DERECHOS.md`.

---

## Historial anterior



**(Histórico — esta línea decía «No queda ninguna» y era falsa; ver arriba.)**

> **El número 0103 estaba duplicado y ya no lo está.** El torneo de puntaje por
> jurado nació como `0103_torneo_calificacion_jurado.sql`, con el número que ya
> tenía `0103_solicitud_de_cambio.sql`. Renumerado a **0114** el 2026-09-06. No
> hay nada que volver a correr: cambió el nombre del archivo, no el contenido.


| Nº | Qué hace | Estado |
|---|---|---|
| 0113 | El interruptor de la rueda, el tope de citas por participante y las franjas bloqueadas | ✅ aplicada el 2026-09-06 |
| 0112 | Recordar la cita una hora antes (`networking_citas.recordatorio_at`) | ✅ aplicada el 2026-09-06 |
| 0111 | De dónde vino cada inscripción (`tickets.origen`) | ✅ aplicada el 2026-09-05 |
| 0110 | Qué pasó en la reunión y qué negocio se espera | ✅ aplicada el 2026-09-05 |
| 0109 | Los roles hacen lo que dicen que hacen | ✅ aplicada el 2026-09-05 |
| 0108 | Sentar a alguien en la rueda con sólo su correo | ✅ aplicada el 2026-09-05 |
| 0107 | Límite de caracteres y de palabras en las preguntas | ✅ aplicada el 2026-09-05 |
| 0114 | Formato de torneo "puntaje jurado" (show de talento): jurado, criterios, rondas — nació como 0103, renumerada | ✅ aplicada el 2026-09-05 |
| 0102 | Una notificación que lleva a algún sitio (`notificaciones.link`) | ✅ aplicada el 2026-09-04 |
| 0100 | Los descuentos del agente se mudan a donde se cobran | ✅ aplicada el 2026-09-04 |
| 0101 | Tirar cuatro tablas que nunca se usaron | ✅ aplicada el 2026-09-04 |
| 0097 | Políticas RLS para las tablas que tenían la puerta cerrada y ninguna llave | ✅ aplicada el 2026-09-03 |
| 0098 | Las reglas de la puerta se mudan con ella (`zonas.reglas`) | ✅ aplicada el 2026-09-03 |
| 0099 | Que el código de descuento llegue al cobro | ✅ aplicada el 2026-09-03 |
| 0092 | Las zonas dejan `page_json` (paso 3 de 3) | ✅ aplicada el 2026-09-03 |
| 0093 | Un tipo de boleta declara qué crea al pagarse | ✅ aplicada el 2026-09-03 |
| 0094 | Una zona declara qué es (evento / ingreso / evacuación / otra) | ✅ aplicada el 2026-09-03 |
| 0095 | Cada torneo declara qué le pide a un equipo | ✅ aplicada el 2026-09-03 |
| 0096 | Las puertas pasan a ser zonas de tipo ingreso | ✅ aplicada el 2026-09-03 |

Este archivo se mantiene al día **a propósito**. Una lista de pendientes que
miente entrena a no creerla, y entonces el día que una haga falta de verdad,
nadie la cree. Ya pasó en este repo: siete migraciones decían «PENDIENTE DE
APLICAR» en su cabecera y cinco estaban aplicadas.

## Qué pasaba si no se corría la 0100

Los dos códigos que hay hoy en `discount_codes` —creados por el chat— siguen
sin descontar nada, que es lo de ahora. Lo que **sí** cambia sin ella es que el
agente, con el código nuevo, escribirá en `promociones` desde el primer minuto:
los nuevos funcionan aunque la migración no se haya corrido. La migración es
para los dos viejos.

## La 0101 es la primera *contract* de la serie

Las anteriores sólo añadían. Ésta **borra tablas**, y un `drop table` no se
deshace con otra migración: se deshace con una copia de seguridad. Va igualmente
porque la prueba de que sobran es dura — `n_tup_ins = 0`, cero inserciones en
toda su historia— y no «están vacías», que no significa lo mismo.

## Lo que quedó comprobado al aplicarlas

- **0097** — las 9 políticas nombradas y las del bucle están puestas. Quedan
  **ocho** tablas con RLS y sin política, y son exactamente las ocho que el
  archivo deja cerradas a propósito: `cobros_vacantes`, `email_cola`,
  `evento_smtp`, `oauth_clients`, `oauth_codes`, `oauth_tokens`,
  `organizador_conexiones`, `recordatorio_inapp_log`. Ninguna de más.
- **0098** — `zonas.reglas` existe y la puerta «entrada inicial» salió con sus
  `tipos` y su `staff`, los mismos que tenía en `page_json.accesos`. El JSON
  sigue intacto: esto sólo copió.
- **0099** — `promocion_id` en las dos tablas y la función
  `promocion_consumir`. Ojo: **fusionar no es desplegar**. El descuento no
  empieza a aplicarse hasta que la API sirva el código nuevo; hasta entonces
  cae al precio de lista, sin error.

## Lo que se aprendió corriéndolas, y hay que respetar la próxima vez

**Fusionar no es desplegar.**

La 0092 tiene una condición previa que no se puede comprobar desde SQL: el
código que lee las zonas de la tabla tiene que estar **sirviendo**. Se corrió
con el PR ya fusionado… y el despliegue de cPanel iba por detrás, así que la API
seguía respondiendo con el código anterior.

Resultado: cuatro pantallas en blanco a la vez —Zonas del evento, el selector de
zona de un sub-evento, el escáner y el bloque de mapa de la landing— durante
horas, **sin un solo error en ninguna parte**. El síntoma de este proyecto,
otra vez: cuando el dato cambia de sitio y alguien sigue mirando el sitio viejo,
no falla nada; simplemente no hay nada.

**Cómo comprobarlo bien**, y son dos minutos:

```bash
curl -s https://api.gestekeventost.dpdns.org/eventos/publicos/slug/technova-summit-2026 | grep -o '"zonas"'
```

Si no imprime nada, la API **no** tiene el código nuevo, por más que `main` sí.
Contra la API desplegada, nunca contra la rama.

## La red de seguridad, mientras exista

`page_json.zonas_respaldo` sigue guardado en cada evento. Devuelve las zonas al
sitio viejo con una consulta, y con eso el código anterior vuelve a
encontrarlas:

```sql
update public.eventos
   set page_json = (page_json - 'zonas_respaldo')
                   || jsonb_build_object('zonas', page_json->'zonas_respaldo')
 where page_json ? 'zonas_respaldo';
```

Se borrará en una migración futura, cuando lleve semanas sin hacer falta. Un
jsonb con once objetos no le pesa a nadie; perder el plano de un evento en
marcha, sí.

## Lo que sigue esperando una decisión (no son de hoy)

- **0081** — borra columnas de datos de persona en `perfil_talento`. Es
  `DROP COLUMN`: revertirla **no devuelve los datos**, así que antes hay que ver
  cuántas filas los tienen rellenos.
- **0083** — migra `credenciales` → `wallet.variantes`. No corre riesgo, pero
  toca los 33 eventos. Hoy no rompe nada porque `walletVariantes()` traduce la
  forma vieja en caliente: **el fallback del código está haciendo el trabajo de
  la migración**.

## Cómo comprobar el estado en cualquier momento

```sql
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='ticket_types' and column_name='crea')            as m0093,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='zonas' and column_name='tipo')                   as m0094,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='event_form_fields' and column_name='torneo_id')  as m0095,
  (select count(*) from public.eventos where page_json ? 'zonas_respaldo')                       as m0092,
  (select count(*) from public.zonas where tipo = 'ingreso')                                     as m0096;
```
