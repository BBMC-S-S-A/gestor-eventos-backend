# El resto de las rutas — qué queda, y cómo se hace

Lo último grande de la fase 6: que las rutas dejen de hablarle a Supabase y le
hablen a MySQL. Este documento mide el frente y propone el camino. Escrito el
**27 de octubre de 2026**; todos los números salen de contar el código de hoy,
no de recordarlo.

Lo demás de la fase 6 ya está: el esquema (`008`), los contadores atómicos, las
semillas, el cableado de lo vendido y los arrays. El estado completo, en
`CORTE.md` §10.

---

## 1 · El tamaño, medido

| | |
|---|---|
| Llamadas `.from(...)` | **1.152** |
| Archivos que las contienen | **95** |
| Tablas distintas que tocan | **86** |

> `CORTE.md` decía «43 archivos». Era el número de archivos que *mencionan*
> supabase, no los que consultan. Queda corregido aquí.

### Lo que de verdad se usa de la API

Esto es lo que decide si el camino B de abajo es viable, así que está contado
con cuidado — separando los métodos de supabase-js de los de JavaScript, que
se llaman igual:

| Lectura | | Escritura | |
|---|---|---|---|
| `.select('…')` | 769 | `.update()` | 190 |
| `.eq()` | 1.330 | `.insert()` | 140 |
| `.maybeSingle()` | 378 | `.delete()` | 112 |
| `.order()` | 225 | `.upsert()` | 13 |
| `.single()` | 136 | | |
| `.limit()` | 82 | **Contar** | |
| `.is()` | 65 | `count: 'exact'` | **54** (44 con `head`) |
| `.or()` | 28 | | |
| `.ilike()` | 28 | **Funciones** | |
| `.not()` | 22 | `.rpc()` distintas | 12 |
| `.in()` | 18 | | |
| `.range()` | 18 | | |
| `.gte()` `.gt()` `.lt()` `.lte()` | 25 | | |
| `.neq()` | 31 | | |
| `.match()` | **0** | | |

> **`.filter(col, op, val)` de supabase: CERO.** Un recuento ingenuo da 200,
> pero las 157 son `Array.prototype.filter`. Se dice porque es justo el tipo
> de número que hace parecer imposible algo que no lo es.
>
> **Y `.match()` también es CERO**, por lo mismo: los 6 que decía esta tabla
> eran `String.prototype.match(/regex/)`. Corregido al escribir el tramo 2. El
> recuento ingenuo falla dos veces en la misma tabla, así que conviene
> desconfiar del tercero.

### Las dos cosas que no son mecánicas

**1 · Los 66 `select` con JOIN embebido.** La sintaxis de PostgREST para traer
una tabla relacionada dentro del mismo `select`:

```js
.select('*, autor:profiles!autor_id(id, nombre, avatar_url)')
.select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
```

Eso es un `LEFT JOIN` con el resultado anidado dentro de cada fila. Es **la
parte cara** de cualquiera de los dos caminos, y la que hay que hacer bien:
una de ellas la usa `lib/acceso.js`, o sea el guardia de los permisos.

**2 · Las 12 funciones (`.rpc`).** Ya tienen sitio decidido y la mayoría,
hecho:

| Función | Dónde va en MySQL | Estado |
|---|---|---|
| `sumar_aforo_vendido`, `sumar_vendidos_tipo` | `modules/contadores/` | ✅ hecho y cableado |
| `aforo_zonas` ×4 | `modules/aforo/consultas.js` | ✅ escrito, sin cablear |
| `canjear_recompensa` | `modules/contadores/` | ✅ escrito, sin cablear |
| `retener_espacio`, `liberar_espacio`, `confirmar_espacio` | pendiente | ⬜ |
| `promocion_consumir` | pendiente | ⬜ |
| `find_pending_reminders` | pendiente | ⬜ |
| `oauth_barrer` | dos `delete`, trivial | ⬜ |
| `generar_recordatorios_inapp` | **está rota** — su tabla ya no existe | borrar |

---

## 2 · Los dos caminos

### Camino A · Reescribir las 1.152 llamadas

Sacar cada consulta a una capa de repositorio por dominio
(`modules/eventos/repositorio.js`, `modules/tickets/…`) y cambiar los 95
archivos.

**A favor:** el SQL queda a la vista, se puede optimizar consulta por consulta,
y no se depende de ningún envoltorio.

**En contra, y pesa mucho:** son 1.152 ediciones a mano. Cada una es una
oportunidad de equivocarse, y el modo de fallo de este proyecto ya lo
conocemos — una consulta mal traducida no revienta, devuelve de más o de
menos. Encima no se puede hacer a medias: `DATOS_PROPIOS` enciende todo a la
vez, así que hasta la última de las 1.152 no se puede probar nada de verdad.

### Camino B · Un adaptador que hable el mismo idioma ← **ELEGIDO**

Implementar el subconjunto medido arriba sobre MySQL, y que `lib/supabase.js`
devuelva el cliente de verdad o el adaptador según `DATOS_PROPIOS`:

```js
module.exports = config.DATOS_PROPIOS
  ? require('../core/db/postgrest.js')   // el adaptador sobre MySQL
  : clienteSupabase;
```

**Las 1.152 llamadas no se tocan.** Siguen escritas igual y empiezan a hablar
con MySQL el día que se mueva la bandera.

**A favor:**

- Una pieza que probar en vez de 1.152 que revisar, y se prueba **contra un
  MySQL de verdad**, sin montar rutas ni servidor.
- El trabajo es acotado y ya está medido: ~20 métodos, los JOIN embebidos y
  el contar.
- Se puede ir construyendo y probando sin que nada cambie en producción,
  porque la bandera sigue apagada.
- Volver atrás es apagar la bandera.

**En contra:**

- Un adaptador **al 95% es peligroso**: lo que no cubra bien devuelve datos
  equivocados en silencio, que es exactamente el fallo que este proyecto
  arrastra. Por eso la regla de abajo no es negociable.
- Hay semántica fina que hay que decidir y escribir: dónde ordena los NULL
  cada motor, si `ilike` casa igual con el cotejo `utf8mb4_0900_as_ci`
  (acento-sensible, mayúscula-insensible), y si `count` cuenta antes o después
  del `limit`. **Las dos, resueltas:** el cotejo en el tramo 2 y el `count` en
  el tramo 4.
- `.or()` trae su propia gramática (`and(a.eq.1,b.eq.2)`) y hay que
  interpretarla. Son 28 usos, con cinco formas distintas.

> ### La regla que hace que B sea seguro
>
> **Lo que el adaptador no sepa hacer, revienta.** Nunca devuelve una lista
> parcial, ni ignora un filtro que no entiende, ni adivina.
>
> Un error ruidoso el día de la prueba cuesta diez minutos. Una lista a la que
> le faltan filas el día del evento no se nota hasta que alguien no aparece en
> la puerta.

---

## 3 · El plan, si se toma el camino B

Cada tramo deja algo que se puede probar solo, y ninguno cambia nada mientras
`DATOS_PROPIOS` siga apagada.

| # | Qué | Cómo se comprueba | |
|---|---|---|---|
| 1 | El esqueleto: `from`, `select` de columnas, `eq`, `order`, `limit`, `single`/`maybeSingle`, y el **reventar** ante lo no soportado | Contra MySQL real, tabla por tabla | ✅ |
| 2 | El resto de filtros: `in`, `is`, `neq`, `not`, `gt/gte/lt/lte`, `ilike` (`match`: cero usos) | Idem, caso por caso | ✅ |
| 3 | Escrituras: `insert`, `update`, `delete`, `upsert` — y el `JSON.stringify` de las 8 columnas de array | Idem | ✅ |
| 4 | `count` y `range`, con la semántica escrita | Comparando contra Postgres | ✅ |
| 5 | **Los 66 JOIN embebidos** | Empezando por el de `lib/acceso.js`, con la prueba de permisos en verde | ✅ |
| 5b | `!inner` y filtrar por columna embebida | Los 2 que faltaban | ✅ |
| 6 | `.or()` y su gramática | Las cinco formas que hay hoy | ⬜ |
| 7 | Las 12 `.rpc()` que faltan | Una por una | ⬜ |
| 8 | La comparación final: las mismas consultas contra los dos motores | `scripts/comparar-bases.js` ampliado | ⬜ |

---

## 4 · Lo que hay que decidir antes de empezar

1. ~~**¿A o B?**~~ **DECIDIDO: B**, el 27 de octubre de 2026. La razón de
   fondo es que 1.152 ediciones a mano en un sistema cuyo modo de fallo es el
   silencio no es un plan: es una apuesta.
2. **¿Qué se hace con `generar_recordatorios_inapp`?** Está rota desde hace
   tiempo —lee una tabla que ya no existe— y lo que corresponde es borrarla.
   El `drop` está escrito en el comentario de la `0139`.
3. ~~**El cotejo.**~~ **MEDIDO el 27 de octubre de 2026, y coincide.** Las 91
   tablas de datos están en `utf8mb4_0900_as_ci` —insensible a mayúsculas,
   SENSIBLE a acentos—, que es exactamente lo que hace `ILIKE` en Postgres:

   | buscando | Postgres `ILIKE` | MySQL `0900_as_ci` | MySQL `unicode_ci` |
   |---|---|---|---|
   | `%bogotá%` | Bogotá, BOGOTÁ | Bogotá, BOGOTÁ ✅ | los tres ❌ |
   | `%bogota%` | Bogota | Bogota ✅ | los tres ❌ |

   Por eso `ilike` se traduce a un `LIKE` pelado. El otro cotejo —el de
   `001_identidad` y `002_archivos`— es acento-ciego y devolvería de más, pero
   esas tablas no se consultan por este camino. Lo vigila
   `test/postgrest.filtros.test.js`, porque si una tabla de datos entrara con
   `_ai_ci` las búsquedas empezarían a devolver de más sin error.

---

## 5 · Lo que lleva hecho el adaptador

**`core/db/postgrest.js`** — tramo 1, escrito el 27 de octubre de 2026.

Cubre `from`, `select` de columnas, `eq` (incluido `eq(col, null)` → `IS NULL`),
`order`, `limit`, `single` y `maybeSingle`. Todo lo demás **lanza**, con un
mensaje que dice a qué tramo pertenece.

### Las tres decisiones que no se ven en la firma

**1 · Lo no soportado LANZA, no devuelve `{ error }`.** Muchas de las 1.152
están escritas `const { data } = await …`, tirando el error. Un error devuelto
sería una lista vacía en silencio, que es el modo de fallo que el adaptador
existe para evitar. Los errores de SQL de verdad SÍ vuelven como `{ error }`,
porque es lo que hace supabase-js hoy.

**2 · El orden de los NULL.** Es la trampa fina, y no da error: ordena, y
ordena distinto. Medido el 27-oct con una tabla de tres filas, una con la
fecha a NULL:

| | ASC | DESC |
|---|---|---|
| Postgres 17.6 (Supabase, producción) | `1,3,2` | `2,3,1` |
| MySQL 8.0.46 a pelo | `2,1,3` ❌ | `3,1,2` ❌ |
| MySQL con el adaptador | `1,3,2` ✅ | `2,3,1` ✅ |

Está cambiado **en los dos sentidos**. Se arregla ordenando primero por
`(col IS NULL)`. Sin eso, cualquier lista ordenada por una columna que admita
NULL sale con los sin-valor donde no van — y nadie lo reporta como fallo.

**3 · `single()` pide `LIMIT 2`.** No es optimización: tiene que distinguir
«una» de «más de una», y con dos filas ya se sabe. Si quien llama puso su
propio `limit`, manda el suyo.

### Cómo se prueba

| Archivo | Qué | Corre |
|---|---|---|
| `test/postgrest.compila.test.js` | el SQL que se genera (`compilar()` es pura) | siempre, también en el CI |
| `test/postgrest.contraMysql.test.js` | que ese SQL hace lo que se cree | `MYSQL_PRUEBAS=1 npm test` |

La parte de integración está tras bandera porque el CI no tiene MySQL, y una
prueba que falla todos los días acaba borrada. Levanta su propia base, la llena
y la borra; no toca ninguna del proyecto.

---

## 6 · Tramo 2 — los filtros

`eq` ya estaba; entran `neq`, `gt`, `gte`, `lt`, `lte`, `is`, `in`, `not` e
`ilike`. Medido sobre el código: **1.330 `eq`, 65 `is`, 31 `neq`, 29 `ilike`,
25 de rango, 22 `not`, 18 `in`**. De los 22 `not` sólo hay dos formas
(`not(col,'is',null)` ×18, `not(col,'in',[…])` ×4) y los 65 `is` son todos
`is(col, null)`.

### La trampa: `.in(col, [])`

Los 18 usos pasan listas que salen de un `.map()`, o sea que **pueden venir
vacías**. Y los dos motores no se parecen en nada ahí:

| | |
|---|---|
| PostgREST | `col = ANY('{}')` → **0 filas**, sin error (medido contra Postgres 17.6 de producción) |
| MySQL | `col IN ()` es un **error de sintaxis** |

Se traduce a `1 = 0`, que es lo fiel. Dejar que reventara sería ruidoso, sí,
pero rompería código que hoy funciona: la regla de reventar es para lo que **no
sabemos** hacer, no para lo que sabemos hacer y da pereza.

### Lo que lanza a propósito

| | Por qué |
|---|---|
| `neq/gt/gte/lt/lte` con `null` | No casa con nada en ninguno de los dos motores. Correcto e inútil: quien lo escribe quería `is`. Cero usos. |
| `is` con algo que no sea `null`/`true`/`false` | Convertirlo en `= ?` parecería funcionar y devolvería otra cosa. |
| `like` | En Postgres distingue mayúsculas; en MySQL con cotejo `_ci` **no**. Se comportaría como `ilike` y devolvería de más, en silencio. Cero usos. |
| `match` | Cero usos medidos. No se escribe lo que nadie usa. |
| un `not` dentro de otro `not` | PostgREST no lo permite y no hay ninguno. |

---

## 7 · Tramo 3 — las escrituras

`insert`, `update`, `delete` y `upsert`, con `.select()` detrás. Medido:
**insert 140** (79 con `.select()`), **update 190** (71), **delete 112** (1),
**upsert 13** (5, y 15 con `onConflict`).

### MySQL no tiene `RETURNING`

156 de esas llamadas piden las filas de vuelta. En Postgres sale gratis; aquí
hay que ir a buscarlas, y hacerlo mal es fácil **de maneras que no dan error**:

| | Lo que pasaría |
|---|---|
| Releer con el mismo filtro tras un `UPDATE` | Si el update tocó la columna del filtro, **cero filas** donde había dos |
| Leer tras un `DELETE` | **Cero filas**, siempre |

Por eso cada escritura con `.select()` va **dentro de una transacción** y se
apunta las claves antes de tocar nada:

- **insert** → se generan las claves, se inserta, se lee por esas claves.
- **update** → se leen las claves que casan, se actualiza **por esas claves**,
  se relee. El filtro se evalúa una sola vez.
- **delete** → se leen las filas **enteras antes** de borrar, y se devuelven ésas.

Sin `.select()` no hay transacción ni relectura: son 61 inserciones y 111
borrados que no la piden, y supabase-js devuelve `{ data: null }`.

### El hallazgo gordo: los `id` no se generan solos

| | |
|---|---|
| Postgres | **73 de 77** columnas `id` tienen `DEFAULT gen_random_uuid()` |
| Volcado MySQL | las **70** columnas `id` son `CHAR(36) NOT NULL`, **sin DEFAULT y sin AUTO_INCREMENT** |
| El código | de los 83 `insert` con objeto literal, **81 no pasan `id`** |

O sea que, tal cual, **81 inserciones darían `ER_NO_DEFAULT_FOR_FIELD`.** Es un
fallo ruidoso —de los buenos—, pero sería un fallo.

Se arregla en el adaptador y no en el esquema a propósito:
`crypto.randomUUID()` da un **UUID v4**, igual que `gen_random_uuid()`;
`DEFAULT (UUID())` de MySQL daría un **v1**, que lleva dentro la MAC de la
máquina y la hora. Y de paso resuelve lo del `RETURNING`: para releer la fila
hay que conocer su clave de todos modos.

> **Ojo para quien escriba en MySQL sin pasar por el adaptador** (un script, una
> carga manual): ahí el `id` sí hay que ponerlo a mano.

### El `JSON.stringify` de las columnas de array

Medido contra **mysql2 3.24.2**, y no es lo que decía `NOTAS-ESQUEMA`:

| | array crudo a una columna JSON |
|---|---|
| `execute()` (lo que usa `core/db/mysql.js`) | **funciona** |
| `query()` | revienta con `ER_WRONG_VALUE_COUNT_ON_ROW` |

Depender de cuál de los dos se usa es el tipo de detalle que nadie recuerda dos
meses después, así que el adaptador lo convierte él y queda igual con los dos.
Las fechas y los `Buffer` **no** se tocan: pasarlos por `JSON.stringify` los
convertiría en texto dentro de una columna `DATETIME`.

### Lo que lanza a propósito

| | Por qué |
|---|---|
| filas de un `insert` con columnas distintas | PostgREST lo rechaza. Rellenar con NULL lo que falte es como se escriben filas a medias. |
| `upsert` con `ignoreDuplicates` | Sería `INSERT IGNORE`, que se traga **todos** los errores recuperables: un texto largo se corta y una fecha mala se vuelve ceros, en silencio. Cero usos. |
| `.select()` sobre una tabla sin clave primaria | No hay forma de volver a encontrar lo escrito. |
| `throwOnError` | Devolverse a sí mismo sería mentir a medias. Cero usos. |

---

## 8 · Tramo 4 — contar y paginar

**54 `count: 'exact'`** (44 de ellos con `head: true`, o sea «cuéntalas y no me
las traigas») y **18 `.range()`**. Ni un `planned`, ni un `estimated`.

### El conteo ignora el `range` — y no es una interpretación

`routes/eventos.js:142` pide `count: 'exact'` junto con
`.range(tramo.desde, tramo.hasta)` y usa el `count` para paginar. Si el conteo
respetara el rango, esa pantalla diría «10 de 10» en vez de «10 de 1234»: o
sea que **la paginación de producción ya estaría rota hoy**. No lo está, luego
el conteo es el total.

Así que son **dos consultas**: la de las filas y un `COUNT(*)` que se queda con
el `WHERE` y tira el `ORDER BY` (no cambia cuántas hay y cuesta) y el `LIMIT`.
`SQL_CALC_FOUND_ROWS` haría un solo viaje, pero está obsoleto desde MySQL
8.0.17 y la propia documentación de MySQL recomienda justamente estas dos.

### `range` tiene los dos extremos dentro

`range(0, 9)` son **diez** filas. Equivocarse en ese borde **no da error**: da
páginas que se solapan por una fila, y la última de cada página vuelve a salir
la primera de la siguiente. Se ve como «este cliente aparece dos veces en la
lista», no como un fallo.

### Lo que lanza a propósito

| | Por qué |
|---|---|
| `count: 'planned'` / `'estimated'` | Salen del planificador de Postgres y son **aproximados**. Traducirlos a un `COUNT(*)` de verdad sería «mejor» y por eso mismo sería mentira: quien pide una estimación espera que sea barata, no exacta. Cero usos. |
| `head` sin `count` | No devolvería ni filas ni cuenta. |
| `range` y `limit` a la vez | Uno pisaría al otro y no está dicho cuál. Cero usos. |
| un `range` al revés o negativo | |
| `count` detrás de una escritura | Contar qué, y respecto a qué. Cero usos. |

---

## 9 · Tramo 5 — los embebidos

64 de los 66. Los otros 2 —los que llevan `!inner`— van en el 5b.

### Objeto o lista: la decisión que lo decide todo

PostgREST devuelve el embebido como **objeto** cuando la clave ajena está en la
tabla de arriba (muchos-a-uno) y como **lista** cuando está en la de abajo
(uno-a-muchos). No es un detalle de forma:

```js
// lib/acceso.js — el guardia de las 378 rutas
.select('custom_permissions, rol_detail:event_roles!rol_id(permissions)')
const lista = [...(m.rol_detail?.permissions || []), ...];
```

Si `rol_detail` volviera como lista, `?.permissions` daría `undefined`, el
`|| []` lo taparía, y **todo el mundo perdería los permisos de su rol sin un
solo error en ningún log**.

Por eso la dirección **no se adivina** por el nombre ni por si suena a plural:
se lee de las claves ajenas del esquema (`information_schema`), una vez por par
de tablas y guardada.

### Por qué NO es un JOIN

Parecería que un embebido es un `LEFT JOIN`. Con muchos-a-uno casi; con
uno-a-muchos **un JOIN multiplica las filas del padre** —tres hijos, tres
copias— y entonces el `LIMIT` deja de contar filas del padre y el `count`
miente. Rearmarlo después es adivinar dónde empieza cada grupo.

Así que se hace como lo hacen los ORM: una consulta para el padre y **una más
por cada embebido**, con un `IN (…)` de las claves que salieron.

> **No es N+1:** es una consulta por embebido, no una por fila. Hay una prueba
> que lo cuenta y falla si se convierte en N+1.

### Con dos caminos, lanza

Si hay dos claves ajenas entre las mismas tablas —`autor_id` y `revisor_id`,
por ejemplo— y nadie dijo cuál, **lanza**. Coger la primera sería devolver los
datos de otra persona: el revisor donde se pedía el autor.

### Dos fallos que encontraron las propias pruebas

1. **Se borraba la columna de emparejamiento antes de usarla.** El embebido
   salía `null` para todo el mundo — incluido el guardia.
2. **Los anidados no traían la clave del nieto.** El tercer nivel salía `null`.

Los dos son exactamente el fallo que este adaptador existe para evitar: sin
error, con la respuesta a medias.

---

## 10 · Tramo 5b — `!inner` y filtrar por columna embebida

Los 2 que faltaban. Son pocos, pero son el **único** sitio del adaptador donde
hace falta un JOIN de verdad.

### Por qué aquí sí es un JOIN

`!inner` **descarta filas del padre**, y eso tiene que pasar **antes** del
`LIMIT` y del `count`. Con la consulta aparte del tramo 5 no se puede: la
página ya estaría cortada cuando se descubriera que a una fila le falta el
hijo.

El JOIN está ahí **sólo para filtrar**: las columnas del embebido se siguen
trayendo con su propia consulta. Mezclar las dos cosas es lo que multiplica
filas, y para un `!inner` hacia muchos-a-uno no hace falta.

### El conteo lleva el mismo JOIN

Si no, la página vendría recortada pero el total seguiría siendo el de la tabla
entera: **«1 de 2» cuando de verdad hay 1.** Un número creíble y equivocado,
que es el peor de todos.

> Esto lo cazó una prueba, no la lectura del código: el conteo se calculaba
> **antes** de resolver los embebidos, así que nunca veía el JOIN.

### Con JOIN se cualifica todo

`event_members` y `event_roles` tienen las dos un `id`. Sin cualificar, MySQL
daría `ER_NON_UNIQ_ERROR` —ruidoso, se arregla—; pero con una columna que sólo
existiera en una de las dos **la resolvería callando**, filtrando por la tabla
equivocada.

Y el `*` del padre pasa a ser `tabla.*`: un `SELECT *` con JOIN traería las dos
tablas pegadas y las columnas que se llamen igual se machacarían — el `id`
sería el del rol.

### Lo que lanza a propósito

| | Por qué |
|---|---|
| filtrar por una columna embebida **sin** `!inner` | PostgREST también lo exige: sin el `!inner` no hay nada que filtrar. |
| `!inner` hacia **uno-a-muchos** | Multiplicaría las filas del padre —tres hijos, tres copias— y el `LIMIT` dejaría de contar filas del padre. PostgREST lo resuelve con un lateral; aquí haría falta un `EXISTS`, que es otra cosa y nadie la ha pedido. Los dos `!inner` del código son muchos-a-uno. |

### Lo que NO está cableado todavía

`lib/supabase.js` **sigue devolviendo el cliente de Supabase siempre.** El
cambio de la cabecera de este documento —

```js
module.exports = config.DATOS_PROPIOS ? require('../core/db/postgrest.js') : clienteSupabase;
```

— se hace al final, cuando los ocho tramos estén. Cablearlo ahora no rompería
nada (la bandera está apagada), pero dejaría escrito que el adaptador está
listo cuando le faltan siete tramos.
