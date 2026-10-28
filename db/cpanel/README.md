# Los archivos que sí se pueden correr en el cPanel

Las migraciones de `db/migraciones/` usan **procedimientos almacenados**
(`gestek_add_col`, `gestek_add_idx`, `gestek_add_fk`, `gestek_add_chk`) para no
repetir el «mira antes de crear» cincuenta veces.

**En el cPanel eso no corre.** Medido el 27 de octubre de 2026 contra
`gestek_datos`, en la primera línea del archivo:

```
DROP PROCEDURE IF EXISTS gestek_add_idx;
#1227 — Acceso negado. Usted necesita el privilegio SYSTEM_USER
```

El usuario de MySQL que reparte cPanel no puede crear ni borrar rutinas. Es lo
normal en hosting compartido, y no hay forma de pedirlo desde el panel.

Esta carpeta tiene las mismas migraciones **sin procedimientos**: cada paso
hace su comprobación en línea con `PREPARE` / `EXECUTE`, que no pide ningún
privilegio. Tampoco llevan `DELIMITER`, que es la otra cosa con la que
phpMyAdmin se atraganta.

Son equivalentes, no parecidas: se verificó cargando las dos versiones sobre
réplicas del estado roto y comparando los esquemas resultantes contra un
cargue desde cero — mismas 84 tablas, mismas 182 claves ajenas, cero
diferencias de columnas y cero de índices.

## Qué hay aquí

### `reparar-esquema.sql`

Las migraciones **009 → 007 → 008** pegadas en un solo archivo, en ese orden
(la 007 le cuelga una clave ajena a `ticket_puestos`, que es una tabla que
crea la 009).

Se corre entero de un pegue, y se puede repetir sin romper nada.

### `las-dos-claves-ajenas.sql`

Dos claves ajenas que no las pone ninguna migración:

```
torneo_jurados.user_id          -> profiles.id
torneo_calificaciones.jurado_id -> profiles.id
```

La 006 crea las tablas de torneos pero sólo pone cinco de sus claves ajenas.
Estas dos viven en `db/esquema/05_claves_foraneas.sql`, que corrió **antes** —
cuando las tablas de torneos todavía no existían—, así que se las saltó sin
decir nada. Por eso `gestek_datos` tenía 180 y no 182.

Trae primero las consultas que buscan huérfanos: si devuelven filas, hay que
mirarlas antes, o el `ALTER` falla con `ERROR 1452`.

### `listo-para-datos.sql`

`scripts/listo-para-datos.js` en SQL puro, para cuando no hay forma cómoda de
correr Node en el servidor. El cPanel de este proyecto trae **Application
Manager** y no el viejo *Setup Node.js App*, y esa pantalla no siempre ofrece
un botón para correr un script de `package.json`.

Comprueba lo mismo salvo dos cosas que no son de la base: que el adaptador
cargue —lo cubren las pruebas del repositorio— y cómo está la bandera ahora,
que se ve en el panel.

Devuelve una fila por comprobación con una columna `veredicto`: todas tienen
que decir `OK`. Verificado contra una réplica cargada (siete OK) y contra una
en utf8mb3 a la que le faltan una columna, un índice y los datos (cuatro
`REVISAR`, cada uno con lo que se esperaba).

### `diagnostico-claves-ajenas.sql`

Lista cuáles de las 182 claves ajenas faltan en una base. Fue lo que encontró
esas dos. La lista va embebida como JSON, así que **queda desactualizada en
cuanto se añada una clave ajena nueva**; para regenerarla:

```sh
mysql -N -e "SELECT CONCAT(table_name,'|',constraint_name) \
  FROM information_schema.table_constraints \
 WHERE constraint_schema='<base de referencia>' \
   AND constraint_type='FOREIGN KEY' ORDER BY 1"
```

## Cómo se corren

phpMyAdmin → clic en **`gestek_datos`** en el panel de la izquierda → pestaña
**SQL** → pegar el archivo entero → Continuar.

El clic en la base no es opcional: sin él `DATABASE()` apunta a otra cosa y
todas las comprobaciones de `information_schema` miran donde no es.

## Estado de `gestek_datos` al 27-oct-2026

Antes: 74 tablas base. Después de `reparar-esquema.sql`: **85**, que son las 84
del volcado más `archivos` (de la migración 002, que es correcta que esté).
Las seis que faltaban están, los siete índices que impiden duplicados están, y
la 006 ya había corrido.
