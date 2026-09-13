# Derechos y consumos — Fase 1

**Estado:** diseño, sin implementar. La migración `0126_lo_que_incluye_la_credencial.sql`
es la única pieza escrita.

---

## De dónde sale

Una petición concreta: en los stands hay dos personas registradas y hay que
entregarles refrigerio de la mañana, almuerzo y refrigerio de la tarde, dejando
constancia de a quién se le dio cada cosa, usando el QR de acreditación.

Resuelta tal cual, eso es una tabla `refrigerios` y una pantalla. Y dentro de
dos meses una tabla `kits` y otra pantalla, y luego `parqueadero`.

## Qué se construye en su lugar

> Una credencial da derecho a N usos de algo, dentro de una ventana de tiempo,
> y cada uso queda registrado con quién lo entregó.

Refrigerio-almuerzo-refrigerio es **una configuración** de esa frase. Sin código
adicional, la misma frase cubre:

| Caso | titular | cadencia | usos | ventanas |
|---|---|---|---|---|
| Almuerzo de los expositores | persona | ventana | 1 | una por día |
| Refrigerio mañana / tarde | persona | ventana | 1 | dos por día |
| Camiseta, kit de bienvenida | persona | total | 1 | — |
| Dos aguas por caseta | grupo | ventana | 2 | una por día |
| Bebidas incluidas en la VIP | persona | total | 3 | — |
| Parqueadero, guardarropa | grupo | total | 1 | — |
| Material del jurado | persona | total | 1 | — |
| Vale de un patrocinador | persona | total | 1 | — |
| Comida del personal de logística | persona | ventana | 1 | una por día |

Todas ésas son filas en `derechos`, no desarrollos.

## Lo que ya estaba hecho

**Las dos personas del stand no hay que inventarlas.** La 0118 ya creó
`ticket_puestos`: una persona dentro de una boleta, con nombre, correo,
documento y **su propio QR**, que rota si el puesto se transfiere.

Un tipo de boleta con `es_expositor` y dos puestos en modo `anfitrion` es
exactamente «el stand y sus dos acreditados»: el stand compra una boleta,
recibe un enlace, llena los dos nombres y cada persona tiene su credencial.
Nada de eso hay que escribirlo.

Del lado del escaneo también está casi todo:

- `verifyTicketQR` ya devuelve `puesto_id` cuando el QR es de una persona (`lib/qr.js`)
- el escáner (`src/components/ui/QrScanner.jsx` en el frontend)
- la cola sin conexión (`src/lib/checkinOffline.js`)
- el patrón de permiso fino sobre el rol del miembro, tras la 0124
- el registro de quién operó, como `checkin_operado` en auditoría

**Lo que falta es una capa, y es pequeña.**

---

## El esquema

Tres tablas. Están comentadas en detalle dentro de la migración; aquí el resumen.

- **`derechos`** — el catálogo por evento. Qué es, de quién es (`titular`:
  persona o grupo), cada cuánto se renueva (`cadencia`: ventana o total),
  cuántos (`usos`), y a qué tipos de boleta aplica.
- **`derecho_ventanas`** — «Almuerzo día 1, 12:00–15:00». Filas, no columnas:
  tres días son nueve ventanas, no un rediseño. Con `cupo` opcional para la
  cocina.
- **`derecho_consumos`** — la entrega: qué derecho, qué ventana, **quién lo
  recibió** (`puesto_id`, o `ticket_id` si es de grupo), **quién lo entregó**
  (`operador_id`), la hora real, y el origen (`qr` / `manual` / `cola`).

### La decisión que sostiene todo

El «uno por persona por ventana» es un **índice único**, no un `if`:

```sql
create unique index derecho_consumo_unico_por_ventana
  on public.derecho_consumos (derecho_id, ventana_id, coalesce(puesto_id, ticket_id), uso_num)
  where ventana_id is not null;
```

Un `if` lee «¿ya almorzó?» y después escribe «almorzó». Entre las dos cosas cabe
otra fila, y en la fila del almuerzo eso pasa de verdad: dos o tres tabletas
escaneando a la vez, más la cola sin conexión vaciándose sola cuando vuelve la
red. Es la misma lección de la 0117 (doble venta) y la 0125 (aforo). Y el modo
de fallo es el peor: no salta nada, sólo se acaba la comida antes de tiempo.

`uso_num` dentro de la clave hace que el tope de un derecho de N usos también lo
imponga el motor. Tres bebidas no pueden ser cuatro aunque el código falle.

`coalesce(puesto_id, ticket_id)` es lo que hace que `titular` funcione con un
solo índice: por persona el titular es el puesto, de grupo es la boleta.

### Por qué la entrega no es una `tarea`

La petición decía «que quede como tarea». `tareas` es el tablero del equipo
—pendiente/hecho, asignado a alguien—, no un registro de hechos. Cuatrocientas
entregas ahí dentro convierten el tablero en un log el día del evento, y encima
no sabría responder «¿esta persona ya comió?» sin recorrerlo.

Lo que sí cumple la intención: el **consumo** es el registro auditable, y si
hace falta el recordatorio operativo, una tarea **por ventana** —«entregar
almuerzos, 12:00»— que enlace a la pantalla de entrega. Trazabilidad en su
sitio, coordinación en el suyo.

---

## El backend

### `POST /eventos/:eventoId/consumo`

Calcado del de check-in (`routes/clientes.js:909`), que ya resolvió todos estos
problemas una vez.

```
Body: { derecho_id, qr_token | codigo | puesto_id, ventana_id?, at?, nota? }
```

1. `assertConsumoAccess` — owner, o miembro con permiso `entregar`. Mismo patrón
   que `assertCheckinAccess`.
2. Resolver el titular: `verifyTicketQR` → `ticket_id` + `puesto_id`. Con
   `codigo`, por código corto. Se comprueba que el QR es de este evento.
3. **Comparar el token contra el que guarda la base** cuando viene de un puesto.
   Verificar la firma no basta: un token rotado por una transferencia lleva
   firma válida. Es el mismo agujero que se arregló en la puerta.
4. Resolver la ventana: la que esté abierta ahora, o la explícita si viene.
5. Comprobar que el derecho aplica al tipo de boleta (`aplica_tipos`).
6. Insertar el consumo. **El duplicado se detecta por el error del índice
   (23505), no por una lectura previa** — y se responde 409 con la hora y el
   nombre de quien lo entregó la primera vez, que es lo que el operador necesita
   ver para resolverlo con la persona delante.
7. Auditoría (`consumo_entregado`) y evento para automatizaciones.

Respuestas:

| Situación | Código | Qué ve el operador |
|---|---|---|
| Entregado | 200 | verde, nombre y qué se entregó |
| Ya lo recibió | 409 | «Ya lo recibió a las 12:14, entregó María» |
| No le corresponde | 403 | «Esta boleta no incluye almuerzo» |
| Fuera de ventana | 200 + advertencia | se entrega igual, queda anotado |
| Sobre el cupo | 200 + advertencia | se entrega igual, avisa a cocina |
| QR de otro evento / inválido | 400 | rojo |

Fuera de ventana y sobre cupo **advierten y no bloquean**, a propósito: quedarse
con la comida en la mano y una persona delante sin poder entregarla es peor que
servir 201 de 200. La decisión es del staff; el sistema deja constancia.

### Otras rutas

- `GET/POST/PATCH/DELETE /eventos/:id/derechos` y `/derechos/:id/ventanas` — el
  CRUD del catálogo, con permiso `editar_evento`.
- `GET /eventos/:id/derechos/:derechoId/consumos` — el reporte: quién recibió
  qué, cuándo y de manos de quién. Filtrable por ventana. Con exportación CSV,
  igual que `exportar_asistentes_csv`.
- `GET /eventos/:id/derechos/:derechoId/pendientes` — a quién le falta. Es la
  pregunta que se hace a las 14:30 para ir a buscar a los que no han comido.

### Permiso nuevo

`entregar`, en `core/permisos/catalogo.js`, grupo *Clientes*, junto a `checkin`.
Deliberadamente separado: quien reparte los almuerzos no tiene por qué poder
abrir la puerta, y al revés. Las rutas aceptan `entregar` **o** `editar_evento`,
como hizo la 0124, para que nada se rompa antes de asignar el permiso.

---

## El frontend

- **Pantalla de entrega** — reutiliza `QrScanner.jsx` entero. Encima, un
  selector de derecho y ventana («Almuerzo · día 1»), fijado antes de empezar a
  escanear para que el operador no tenga que elegir por persona.
- **Búsqueda sin QR** — por nombre o documento, siempre visible y no escondida
  tras un «¿problemas?». Siempre llega quien perdió el teléfono, y si la salida
  no es obvia el staff acaba entregando sin registrar nada, que es el peor de
  los dos males. Se guarda con `origen: 'manual'`.
- **Sin conexión** — la cola de `checkinOffline.js` con el mismo contrato: la
  hora real viaja en `at` y el índice único resuelve los duplicados al vaciarse.
  El salón de comidas suele ser el peor punto de wifi del recinto; esto no es un
  extra.
- **Contador en vivo** — entregados / faltan, por ventana. Es lo que la cocina
  pregunta cada media hora.

---

## Qué NO entra en la fase 1

Para que el alcance sea el alcance:

- **Ventanas generadas desde la agenda.** Se crean a mano. Automatizarlo antes
  de ver cómo las usan es adivinar.
- **Panel de cocina** como pantalla propia. El contador en vivo alcanza.
- **Mover `canjes` a ser un derecho con costo.** Es la unificación de verdad
  —una recompensa por puntos es un derecho que se paga—, pero `canjes` está en
  producción y no hay prisa. Después de que esto haya rodado en un evento real.
- **Notificar a quien no ha recogido lo suyo.** Fase 2.
- **Derechos que dependan de otra cosa** («almuerzo sólo si hizo check-in»).
  Nadie lo ha pedido.

## Riesgos y cosas que se olvidan

- **Personal sin boleta.** La logística contratada el mismo día también come. Se
  resuelve con un tipo de boleta gratuito con puestos — sin concepto nuevo, pero
  hay que decirlo en la documentación o alguien pedirá una tabla de personal.
- **Datos personales.** Un registro nominativo de quién comió qué es dato
  personal y tiene finalidad y plazo de conservación. Conviene pasarlo por
  legal-radar antes de producción.
- **`aplica_tipos` vacío significa «todos».** Es cómodo y es una trampa: un
  derecho mal configurado reparte almuerzo a los 2.000 asistentes en vez de a
  los 40 expositores. La pantalla de configuración tiene que decir en texto a
  cuántas boletas va a aplicar antes de guardar.
- **La hora del dispositivo.** `at` viene de una tableta cuyo reloj puede estar
  mal. `lib/horaDeEscaneo.js` ya acota esto para la puerta; se reutiliza igual.

## Pruebas que tienen que existir

- Dos entregas simultáneas del mismo derecho a la misma persona: **una entra y
  la otra choca contra el índice.** Es la prueba que justifica la migración.
- Un derecho de grupo con `usos: 2` entrega dos y rechaza la tercera.
- Un token de puesto rotado por transferencia no entrega.
- La cola sin conexión vaciándose dos veces no duplica.
- Un derecho con `aplica_tipos` no entrega a una boleta de otro tipo.
- Cada prueba nueva, verificada revirtiendo el arreglo para comprobar que falla.

## Lo que falta decidir antes de implementar

- **Si un derecho de grupo lo puede consumir cualquiera de los dos.** El esquema
  lo permite (`titular: 'grupo'`), pero hay que preguntarle a quien organiza qué
  quiere para el almuerzo de los stands en concreto — es la diferencia entre que
  una persona se coma los dos o no.
- **Si la ventana bloquea o sólo advierte.** El diseño advierte. Si alguien
  quiere que bloquee, es un campo más en `derechos` y hay que decidirlo ahora,
  no el día del evento.
