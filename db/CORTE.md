# El día del corte — guía paso a paso

Para seguir **mientras se hace**, no para leer antes. Cada paso dice qué
correr, qué tiene que salir, qué hacer si sale otra cosa, y cómo devolverse.

Escrito el 27 de octubre de 2026. Complementa a `CAMINO-A.md` (el estado del
frente), `../CONFIGURAR.md` (los interruptores) y
`migraciones/CARGA-DE-DATOS.md` (el detalle de los datos). Donde este
documento y aquéllos se contradigan, **manda éste**: los otros se escribieron
antes de la 008 y antes de que FESTECH pasara.

---

## La regla que manda sobre todo lo demás

> **Supabase no se apaga.** Ni al final de esta guía. Se queda encendido y
> pagado unos días más, con las cuentas dentro, porque es lo que convierte
> cualquier error en «apagar una variable» en vez de en «restaurar una copia».

Y la segunda, que es la que de verdad hay que recordar a las once de la noche:

> **Un paso que no da lo que dice esta guía se para.** No se interpreta, no se
> sigue «a ver si el siguiente lo arregla». Se para y se mira. Todo lo de aquí
> es reversible mientras no se hayan encendido los interruptores del §D.

---

## 0 · Lo que tiene que estar antes de empezar

No son pasos del día: si algo de esto falta, el día del corte no empieza.

| | Qué | Cómo se comprueba |
|---|---|---|
| 0.1 | **`PG_URL`**, la cadena de Postgres de Supabase | `psql "$PG_URL" -c 'select 1'` o el paso 1.1 |
| 0.2 | **Acceso a la consola de Google Cloud** del cliente OAuth que usa Supabase | Entrar y ver el cliente. **Si no se tiene, el corte no se hace**: 22 de 29 usuarios entran por ahí |
| 0.3 | El **dominio definitivo** decidido | Ver §0.A |
| 0.4 | Las bases MySQL creadas en cPanel, en `utf8mb4` | Paso 2.1 |
| 0.5 | Un **ensayo completo** hecho (§1) | Sin esto no se empieza |

### 0.A · Lo del dominio, que se decide una sola vez

Hoy la API responde en `api.gestekeventost.dpdns.org`. La `redirect_uri` de
Google se registra **una vez y con el dominio bueno**: cambiarla después
obliga a volver a la consola, y entre una cosa y otra nadie entra con Google.

Si el dominio va a cambiar algún día, **cámbielo antes del corte**, no después.

---

## 1 · El ensayo, que es el paso que más tiempo ahorra

**Se hace días antes, sobre una base de juguete, y se tira.** No toca nada de
producción. Sirve para que el día del corte no haya ni una sorpresa.

```bash
# Una base desechable, en su máquina o en cPanel con otro nombre
mysql -u USUARIO -p -e "CREATE DATABASE ensayo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

Y después, los pasos **3.1 a 3.11** de abajo apuntando a `ensayo`, con los
datos que haya (aunque estén viejos: el ensayo mide si el esquema carga, no si
los datos están al día).

**Qué se busca en el ensayo:** cuánto tarda cada paso, y si alguno se queja.
Lo que tarde aquí, tardará igual el día del corte — con eso se sabe si cabe en
una noche o hay que partirlo.

**Lo que el ensayo NO prueba:** que los datos cuadren. Eso sólo lo dice
`comparar-bases.js` con los datos de verdad, el día del corte (paso 4.3).

---

## 2 · Las bases

### 2.1 · Crearlas, con el juego de caracteres correcto

En cPanel → **MySQL® Databases**. Dos bases: una para la identidad y otra para
los datos.

> ⚠️ cPanel les pone delante el prefijo de la cuenta. Si escribe `gestek`, la
> base se llama `cuenta_gestek`. **El nombre completo, con prefijo, es el que
> va en las variables.** Poner `gestek` a secas da «Access denied», que suena a
> contraseña mala y no lo es. Es el error de configuración número uno.

cPanel no pregunta el juego de caracteres y el servidor está en `utf8mb3`, así
que la base **nace mal**. En phpMyAdmin → SQL, **antes de crear ninguna tabla**:

```sql
ALTER DATABASE `cuenta_gestek_auth` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER DATABASE `cuenta_gestek`      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

**Tiene que salir:** `Query OK`.

**Por qué importa:** en `utf8mb3` las tildes se escriben mal y **no da ningún
error**. Se descubre semanas después, cuando alguien busca «Bogotá» y no
aparece. Arreglarlo con datos dentro es un `ALTER` por tabla y por columna con
la aplicación parada.

**Si ya hay tablas creadas:** borre las bases y vuelva a empezar por aquí. Es
más rápido que arreglarlo.

### 2.2 · Comprobar

```bash
node scripts/comprobar-base.js
```

**Tiene que decir:** `conexión en utf8mb4`.
**Si dice utf8mb3:** el paso 2.1 no se hizo, o se hizo después de crear tablas.

---

## 3 · El esquema

> **Este orden está probado.** Se corrió entero contra MySQL 8.0.46 el 27 de
> octubre, sobre una base vacía, y termina sin un solo error. **No lo cambie
> por el que dicen `db/esquema/README.md` o `migraciones/CARGA-DE-DATOS.md`**:
> los dos son de septiembre, se contradicen entre sí, y el que proponen falla.
> Está contado en el §3.A.

> Todo va en la base de **DATOS** (`cuenta_gestek`) menos el 3.1, que va en la
> de identidad. Meter uno en la otra no da ningún aviso.

Abra la sesión de MySQL y **antes de nada**:

```sql
SET time_zone = '+00:00';
```

Los archivos ya lo traen dentro, pero la sesión desde la que carga también lo
necesita: `UNIX_TIMESTAMP` usa la zona de la sesión.

### El orden

| # | Archivo | Base |
|---|---|---|
| 3.1 | `migraciones/001_identidad.sql` | **auth** |
| 3.2 | `migraciones/002_archivos.sql` | datos |
| 3.3 | `esquema/01_tablas.sql` | datos |
| 3.4 | `esquema/02_indices_unicos_parciales.sql` | datos |
| 3.5 | `esquema/04_indices.sql` | datos |
| 3.6 | `esquema/05_claves_foraneas.sql` | datos |
| 3.7 | `migraciones/005_al_dia.sql` | datos |
| 3.8 | `migraciones/006_torneo_calificacion_jurado.sql` | datos |
| 3.9 | `migraciones/007_derechos_y_credenciales.sql` | datos |
| 3.10 | `migraciones/008_la_puerta_y_la_tarjeta.sql` | datos |
| 3.11 | `esquema/06_vistas.sql` | datos |

```bash
U=cuenta_usuario
mysql -u $U -p cuenta_gestek_auth < db/migraciones/001_identidad.sql
for f in db/migraciones/002_archivos.sql \
         db/esquema/01_tablas.sql \
         db/esquema/02_indices_unicos_parciales.sql \
         db/esquema/04_indices.sql \
         db/esquema/05_claves_foraneas.sql \
         db/migraciones/005_al_dia.sql \
         db/migraciones/006_torneo_calificacion_jurado.sql \
         db/migraciones/007_derechos_y_credenciales.sql \
         db/migraciones/008_la_puerta_y_la_tarjeta.sql \
         db/esquema/06_vistas.sql ; do
  echo "→ $f"; mysql -u $U -p cuenta_gestek < "$f" || break
done
```

**Tiene que salir:** nada debajo de cada `→`. Cualquier línea que no sea el
aviso de contraseña es un error — **pare ahí**, el `|| break` ya lo hace.

### 3.A · Lo que NO se corre, y por qué

| Archivo | Por qué no |
|---|---|
| `esquema/05b_faltantes.sql` | **Redundante al 100%.** Sus 76 claves foráneas están todas en `05_claves_foraneas.sql` (que trae 171). Existía como parche de las que el generador perdía, y ese bug ya está arreglado — ver §3.B |
| `migraciones/003_esquema_indices_parciales.sql` | Es el mismo contenido que `esquema/02`, que sí está en la lista. Sólo cambian dos líneas de `SET` |
| `migraciones/004_vistas.sql` | Copia idéntica de `esquema/06_vistas.sql` |

Y `CAMINO-A.md` menciona un `003_esquema.sql` que **no existe**: ése es
`esquema/01_tablas.sql`. Ese documento se quedó con un nombre viejo.

### 3.B · Los cinco fallos que tenía esta cadena (arreglados el 27-oct)

Se encontraron **haciendo el ensayo del §1**, que es exactamente para lo que
sirve. Se cuentan aquí porque si alguien regenera un archivo y vuelve a
aparecer uno, hay que reconocerlo:

| Dónde | Qué pasaba | Arreglo |
|---|---|---|
| `esquema/02` | `ERROR 1146` — un único parcial sobre la tabla `waitlist`, que ya no existe (era duplicada de `event_waitlist`). Como MySQL se para en el primer error, **el único que impide dos reservas vivas del mismo espacio no se creaba** | Bloque muerto retirado |
| `migraciones/007` | `ERROR 3192` — MySQL no deja poner clave foránea sobre la columna base de una columna generada `STORED`. `derecho_consumos` se quedaba **sin ninguna de sus cuatro claves** | `STORED` → `VIRTUAL`. El comentario decía que MySQL 8 no admite únicos sobre virtuales: **es falso**, comprobado |
| `migraciones/005` y `006` | `ERROR 1826` — tras la regeneración del volcado del 15-sep, `zonas` y las cuatro tablas de torneo **ya vienen en el volcado**, así que sus claves chocaban siempre | Sus claves preguntan antes de crear |
| `migraciones/007` | Lo mismo al correrlo dos veces | Igual |
| `esquema/01_tablas.sql` + el generador | `ERROR 1170` — `oauth_codes.client_id` y `oauth_tokens.client_id` salían `TEXT` y MySQL no puede indexar TEXT sin prefijo, así que sus claves foráneas no entraban. Postgres **no indexa la columna hija de una FK**, y el generador sólo miraba los índices | El generador ahora cuenta también las columnas que participan en una clave foránea |

### 3.C · Comprobar

```sql
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema='cuenta_gestek' AND table_type='BASE TABLE';
```

**Tiene que dar 85.** (Medido el 27-oct con el volcado de hoy. Si regeneró el
volcado y entraron tablas nuevas, será más — pero nunca menos.)

```sql
-- Las que históricamente han faltado. Tienen que salir las cinco:
SELECT table_name FROM information_schema.tables
 WHERE table_schema='cuenta_gestek'
   AND table_name IN ('zonas','puerta_rechazos','derechos','event_waitlist','espacio_reservas');

-- Las muertas tienen que estar borradas. Tiene que dar 0:
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema='cuenta_gestek'
   AND table_name IN ('missions','referral_codes','waitlist','recordatorio_inapp_log');

-- Los 9 únicos parciales que van a mano. Tiene que dar 9:
SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics
 WHERE table_schema='cuenta_gestek' AND index_name IN (
   'catalogo_roles_slug_global_uidx','chat_channels_dm_uidx','espacio_reservas_una_viva',
   'sesion_inscripciones_email_uidx','sesion_inscripciones_ticket_uidx','ticket_puestos_token_idx',
   'torneo_categorias_unica_hija','torneo_categorias_unica_raiz','waitlist_oferta_token_uidx');
```

Los otros dos números medidos, por si quiere compararlos: **182 claves
foráneas**, **266 índices**, **4 vistas**, y **4 tablas** en la base de
identidad.

**Si alguno no cuadra:** no siga. Un índice único que falta no da error — deja
pasar duplicados el día del evento.

---

## 4 · Los datos — aquí se decide si el corte se hace

### 4.1 · Regenerar el volcado, el mismo día

> 🚨 **El volcado se regenera HOY, no antes.** Mientras Supabase siga vivo,
> cada día que pasa se queda más corto. Entre el 30 de agosto y el 4 de
> septiembre ya se habían quedado fuera 5.009 filas, y había filas borradas
> que el volcado viejo **resucitaba**.

```bash
npm i pg
export PG_URL='postgresql://postgres:<PASS>@<HOST>:5432/postgres?sslmode=require'

node db/esquema/generar-esquema.mjs     # por si entró algo después de la 0138
node db/esquema/generar-datos.mjs       # escribe db/esquema/03_datos.sql
```

**Tiene que salir:** `03_datos.sql` creado, de varios MB.

**Mire el `git diff` del esquema.** Si `01_tablas.sql` cambió, entraron
migraciones nuevas y hay que reflejarlas antes de seguir. La prueba lo dice
también:

```bash
npm test 2>&1 | grep -iE "esquema|migraciones de Postgres"
```

> `03_datos.sql` está en `.gitignore` y **no se sube nunca**: lleva datos
> personales de 4.485 boletas.

### 4.2 · Cargar

```bash
mysql -u $U -p cuenta_gestek < db/esquema/03_datos.sql
```

Va **al final**, después de los índices y las claves foráneas, y eso está
bien: el archivo trae dentro `SET FOREIGN_KEY_CHECKS = 0` y
`SET UNIQUE_CHECKS = 0`, y los vuelve a activar al terminar.

> ⚠️ **Y por eso hay que comprobar los únicos después.** Con
> `UNIQUE_CHECKS = 0`, MySQL **no valida los índices únicos durante la carga**.
> Varios de los parciales se tradujeron a únicos que en MySQL son más estrictos
> que en Postgres. Si alguna fila los viola, entra **en silencio** y el índice
> queda inconsistente. Después de cargar:
>
> ```sql
> CHECK TABLE espacio_reservas, torneo_categorias, chat_channels,
>             sesion_inscripciones, ticket_puestos EXTENDED;
> ```
>
> Todas tienen que decir `OK`.

### 4.3 · 🚦 El paso que decide

```bash
node scripts/comparar-bases.js
```

No cuenta filas y ya. Compara en tres niveles: cuántas filas hay, una **huella
por tabla** (hash del contenido entero, ordenado por id) y, si la huella
difiere, las filas concretas. El nivel 2 es el que aporta: dice sí o no sobre
las 829 columnas a la vez.

> Esto **no necesita `PG_URL`**: si no está, usa `SUPABASE_URL` +
> `SUPABASE_SERVICE_KEY`, que ya están en cPanel.

| Resultado | Qué hacer |
|---|---|
| **Todas las tablas iguales** | ✅ Siga al §5 |
| Alguna tabla difiere | 🛑 **PARE.** `node scripts/comparar-bases.js <tabla> --detalle` y mire qué fila. No siga hasta entenderlo |
| Diferencias sólo en tablas de registro (`event_views`, `audit_log`) | ⚠️ Puede ser tráfico que entró durante la carga. Vuelva a correrlo; si sólo crecen ésas, siga |

**Por qué contar filas no basta:** una carga que trunca un texto a 255, que
pierde los microsegundos de una fecha o que convierte un `null` en cadena
vacía deja exactamente el mismo número de filas. El día del evento eso es un
nombre cortado en una escarapela.

---
## 5 · Las cuentas

Van a la base de **identidad** (`cuenta_gestek_auth`).

```bash
node --env-file=.env db/migraciones/generar-usuarios.mjs
```

Se conecta con `PG_URL` y escribe el SQL de las cuentas. Se pega en
`cuenta_gestek_auth`.

> **Camino alterno**, si prefiere no conectarse: saque el volcado a mano con la
> consulta que está en la cabecera de `scripts/migrar-usuarios-a-mysql.js`
> (editor SQL de Supabase), guárdelo y:
> ```bash
> node scripts/migrar-usuarios-a-mysql.js --archivo volcado.json            # sólo mira
> node scripts/migrar-usuarios-a-mysql.js --archivo volcado.json --aplicar  # escribe
> ```
> La primera pasada **no escribe nada**: valida los UUID, comprueba que los
> hashes son bcrypt, busca correos repetidos y avisa de cuentas que se
> quedarían sin forma de entrar. **Hay que leerla antes de aplicar.**

### 5.1 · Comprobar

```bash
node scripts/comprobar-base.js
```

**Tiene que decir:** las cuatro tablas de identidad, y el conteo de usuarios.

**El número que decide:** cuántas cuentas quedan **sin ninguna forma de
entrar**. Tiene que ser **cero**. Si no lo es, esas personas no entran después
del corte — pare y mire a quiénes nombra el script.

> La referencia de septiembre era 29 cuentas, 10 con contraseña y 22 con
> Google. **Vuelva a medirlo hoy**: la gente se sigue registrando.
>
> Había un descuadre conocido —10 con contraseña frente a 9 identidades de
> tipo `email`— que señala una cuenta descolocada. El script la nombra. No
> impide el corte, pero hay que saber cuál es.

> 🔒 El archivo del volcado son **las llaves de todas las cuentas**. Ni al
> repositorio, ni a un correo, ni a un chat. **Bórrelo en cuanto termine este
> paso.**

---

## 6 · Encender la identidad

Dos interruptores, **y el orden importa**.

### 6.1 · Google, primero

Consola de Google → *Credenciales* → el cliente OAuth **que ya usa Supabase**
→ *URI de redirección autorizados* → **añadir** (no sustituir):

```
https://api.gestekeventost.dpdns.org/auth/google/callback
```

**Se añade, no se cambia:** mientras Supabase siga encendido, su URI tiene que
seguir ahí.

**El `client_id` tiene que ser el mismo.** Google identifica a cada persona con
un `sub` distinto por cada cliente. Con un cliente nuevo, los 22 `sub` que se
migraron no coinciden con nada, y esas 22 personas entrarían a **cuentas
nuevas y vacías**, con sus eventos dentro de las viejas.

### 6.2 · El backend

En cPanel → *Setup Node.js App* → *Environment variables*:

```
AUTH_PROPIA=true
```

Y **reiniciar la aplicación** (Passenger lee las variables al reiniciar, no al
guardarlas).

**Tiene que salir en el log:** `[auth] identidad propia montada en /auth`

```bash
curl -s https://api.gestekeventost.dpdns.org/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"SU CORREO","password":"SU CONTRASEÑA"}'
```

**Tiene que devolver:** `access_token`, `refresh_token` y `usuario`.
**Si devuelve `credenciales` con una contraseña que sabe que es buena:** el
hash no se migró bien. Vuelva al §5.

> Aquí **nadie se ve afectado todavía**: `/auth` responde pero el frontend
> sigue hablando con Supabase. Ya se gana algo — el middleware verifica los
> tokens en local y deja de preguntarle a Supabase en cada petición.

### 6.3 · El frontend

`VITE_AUTH_PROPIA=true` y volver a desplegar. **A partir de aquí las sesiones
nuevas son nuestras.**

Las sesiones que estén abiertas **no se cortan**: sus tokens son de Supabase y
el middleware los sigue aceptando hasta que caduquen.

### 6.4 · Si hay que devolverse

**Quite `VITE_AUTH_PROPIA` del frontend y vuelva a desplegar.** Las sesiones
nuestras se pierden —esa gente vuelve a entrar— pero todo lo demás sigue
igual, porque las cuentas nunca se borraron de Supabase.

Es molesto y es de segundos. Por eso se hace así.

---

## 7 · Los archivos

**Va aparte y en otro día.** Tiene su propio interruptor (`ARCHIVOS_PROPIOS`)
y se vuelve atrás por separado. Necesita la identidad ya encendida.

```bash
node scripts/copiar-storage.js             # lista y cuenta, no baja nada
node scripts/copiar-storage.js --aplicar   # baja los referenciados
```

De los 107 objetos, **40 son huérfanos y suman 28 MB** — más de un tercio — y
por defecto se quedan fuera.

Después, `migraciones/postgres/001_reescribir_urls.sql` en el editor SQL de
Supabase, **entero y de una vez**. Termina en `ROLLBACK`: la primera pasada
enseña los conteos sin cambiar nada.

> La referencia de agosto eran 57 filas en 13 columnas. **Ese número ya no
> vale** — vuelva a medirlo. Si no cuadra con lo que ve, o alguien subió cosas
> desde entonces, o hay filas que la reescritura no alcanza. **Pare.**

Cuando cuadre, cambie `ROLLBACK` por `COMMIT` y repita.

**Las dos copias conviven** durante toda la ventana. Si se apaga el origen
antes de tiempo, cada portada sin migrar es un hueco en la página pública de
un evento publicado.

---

## 8 · Lo que hay que mirar los días siguientes

| Cuándo | Qué | Dónde |
|---|---|---|
| Cada mañana, 1ª semana | Que las sesiones vivas **crezcan**. Si no crecen, algo no está entrando | `node scripts/comprobar-base.js` |
| El primer día | Que **uno de los 22 de Google** entre. Con uno basta para saber que el `client_id` y los `sub` cuadran | Pregúntele a alguien |
| El primer día | Que una **compra** sume bien el aforo | Comprar una boleta y mirar `aforo_vendido` |
| Cuando haya tráfico | La tabla `sesiones` crece (una fila por dispositivo y por refresco). `repositorio.limpiarCaducados()` está escrita para el cron | Engancharla |

---

## 9 · Lo que esta guía NO cubre

- **Apagar Supabase.** No se toca hasta que pasen varios días con todo el
  mundo entrando por lo nuestro. Las cuentas están en los dos sitios a
  propósito.
- **La cookie `httpOnly`.** Hoy el token vive en `localStorage`. La cookie es
  mejor —un XSS no la lee— pero necesita que frontend y API estén bajo el
  mismo dominio. Cuando los dos vivan bajo `gestekeventost.dpdns.org`, se
  cambia `src/lib/authPropia.js` y nada más.

---

## 10 · 🚨 Lo que todavía falta en el código antes de poder cortar

Esto no es un paso: es la lista de lo que **tiene que estar hecho** antes de
que el §4 tenga sentido. Al 27 de octubre:

| Qué | Estado |
|---|---|
| Esquema MySQL al día hasta la 0138 (`008`) | ✅ hecho |
| Sumas atómicas de lo vendido en `modules/contadores/` | ✅ hecho |
| Semillas de evento (roles, canales) en `modules/eventos/semillas.js` | ✅ hecho |
| Lo vendido: las 13 llamadas pasan por `lib/contadores.js` y obedecen a `DATOS_PROPIOS` | ✅ hecho |
| **Cablear el RESTO de las rutas a MySQL** (los 43 archivos que usan Supabase directo) | ⬜ **falta** |
| **Las 8 columnas `ARRAY` → `JSON`**: lo que hoy se consulta con `@>` o `= ANY()` hay que reescribirlo con `JSON_CONTAINS` / `MEMBER OF` | ⬜ **falta** |
| Los 5 uploaders del frontend, que hoy suben directo a Supabase | ⬜ falta (va con el §7) |

La de los `ARRAY` es la que más cuidado pide: `event_members.custom_permissions`
la lee `core/permisos/cargarEvento()`, o sea **el guardia de las 378 rutas**.
Cuando se toque, la prueba de permisos tiene que seguir en verde.

El detalle de las ocho columnas está en `migraciones/NOTAS-ESQUEMA.md`.
