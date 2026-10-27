'use strict';

/* El `sub` de Google es el MISMO para todos los clientes OAuth.
 *
 * ── Qué se protege, y por qué hace falta una prueba ──────────────────────
 *
 * Durante meses este repositorio afirmó lo contrario en cuatro sitios
 * (`modules/auth/google.js`, `CONFIGURAR.md`, `db/CORTE.md` y el generador de
 * usuarios): que Google le da a cada persona un `sub` distinto por cada
 * `client_id`, y que por eso había que reutilizar sí o sí el cliente OAuth que
 * usa Supabase.
 *
 * Esa frase costó cara. El proyecto de Google que contiene ese cliente
 * (558760544025) quedó sin dueño accesible, y la migración se dio por bloqueada
 * creyendo que cambiar de cliente dejaría a 82 personas fuera de sus cuentas.
 *
 * Es falso, y Google lo publica. Comprobado el 27 de octubre de 2026:
 *
 *     $ curl -s https://accounts.google.com/.well-known/openid-configuration
 *     "subject_types_supported": ["public"]
 *
 * OIDC Core §8 define exactamente dos valores. `pairwise` es un `sub` por cada
 * cliente —lo que hacen Apple y Entra ID—; `public` es el mismo `sub` para
 * todos, porque identifica a la Cuenta de Google, no a la pareja
 * cuenta-aplicación. Google sólo ofrece `public`.
 *
 * ── Por qué esta prueba y no sólo un comentario ──────────────────────────
 *
 * Porque ya pasó una vez: la afirmación equivocada se copió de un archivo a
 * otro hasta que nadie recordaba de dónde salía, y nadie la comprobó porque
 * estaba escrita en cuatro sitios y eso la hacía parecer verificada. Un
 * comentario más no lo impide; una prueba que falla, sí.
 *
 * ── Lo que NO hace esta prueba ───────────────────────────────────────────
 *
 * Salir a la red. `npm test` tiene que correr en el CI y en un portátil sin
 * conexión, y una prueba que depende de accounts.google.com falla los días que
 * falla Google — y entonces alguien la borra, que es peor que no tenerla.
 *
 * La comprobación de verdad contra Google está aquí abajo pero sólo corre si se
 * pide: `COMPROBAR_GOOGLE=1 npm test`. Conviene correrla el día del corte.
 *
 * Correr: npm test */

process.env.JWT_SECRET = 'secreto-de-prueba-que-no-es-el-de-produccion';
process.env.AUTH_PROPIA = 'true';
process.env.GOOGLE_CLIENT_ID = 'cliente-de-prueba.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secreto-de-google-de-prueba';
process.env.GOOGLE_AUTH_REDIRECT = 'https://api.ejemplo.com/auth/google/callback';
process.env.FRONTEND_URL = 'https://app.ejemplo.com';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ficticio.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falsa';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const google = require('../modules/auth/google.js');
const { crearRepoFalso, uuid } = require('./_repoFalso.js');

const raiz = (...p) => path.join(__dirname, '..', ...p);
const leer = (f) => fs.readFileSync(raiz(f), 'utf8');

/* Los cuatro archivos que llevaban la afirmación equivocada. */
const ARCHIVOS = [
  'modules/auth/google.js',
  'CONFIGURAR.md',
  'db/CORTE.md',
  'db/migraciones/generar-usuarios-mysql.sql',
];

/* ── Que la afirmación equivocada no vuelva ────────────────────────────── */

test('ningún archivo vuelve a decir que el sub cambia con el cliente', () => {
  /* Las dos formas en que estaba escrita, más la variante obvia. Se busca sobre
     el texto entero A PROPÓSITO: aquí lo que se vigila son los comentarios y la
     documentación, que es donde vivía el error. Por eso las cabeceras que
     EXPLICAN el error lo citan siempre en pasado o negado («decía que», «es
     falso»), nunca en la forma que casa con esto. */
  const MALAS = [
    /sub.{0,30}distinto para cada/i,
    /sub.{0,30}distinto por cada/i,
    /un .{0,3}sub.{0,3} por cada cliente(?!.{0,45}(Apple|Entra|pairwise))/i,
  ];

  const hallazgos = [];
  for (const f of ARCHIVOS) {
    const src = leer(f);
    for (const re of MALAS) {
      const m = src.match(re);
      if (m) hallazgos.push(`${f}: «${m[0]}»`);
    }
  }

  assert.deepEqual(hallazgos, [],
    'Volvió la afirmación equivocada. Google declara `subject_types_supported: ["public"]`, ' +
    'o sea el MISMO `sub` para todos los clientes OAuth (OIDC Core §8).\n' +
    'Comprobarlo:  curl -s https://accounts.google.com/.well-known/openid-configuration\n' +
    hallazgos.map(h => `  · ${h}`).join('\n'));
});

test('la cabecera de google.js deja escrito el valor medido', () => {
  /* Para que quien lo dude no tenga que buscarlo fuera: el valor y el comando
     con el que se vuelve a comprobar están en el propio archivo. */
  const src = leer('modules/auth/google.js');
  assert.match(src, /subject_types_supported/,
    'la cabecera ya no dice de dónde sale que el `sub` no cambia');
  assert.match(src, /well-known\/openid-configuration/,
    'la cabecera ya no dice cómo volver a comprobarlo');
});

/* ── La red debajo: que el re-enlace avise ─────────────────────────────── */

test('re-enlazar por correo deja aviso en el registro', async () => {
  /* Es la línea que convierte una suposición en una medida. Si el día del corte
     el `sub` hubiera cambiado —contra lo que Google declara—, la gente entraría
     igual por este camino, y esto es lo único que lo diría. Sin el aviso, el
     corte parecería perfecto y nadie sabría que se recompuso solo. */
  const id = uuid();
  const repo = crearRepoFalso({ usuarios: [{ id, email: 'ana@ejemplo.com', emailConfirmado: true }] });

  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    await google.resolverUsuario(
      { sub: 'sub-que-no-estaba-guardado', email: 'ana@ejemplo.com', email_verified: true },
      { repo }
    );
  } finally {
    console.warn = original;
  }

  const linea = avisos.find(a => a.includes('[auth/google]'));
  assert.ok(linea, 'el re-enlace por correo pasó callado: el día del corte no habría forma de verlo');
  assert.match(linea, /re-enlazada por correo/);
  assert.ok(linea.includes(id), 'el aviso no dice de qué cuenta se trata');
  assert.ok(linea.includes('sub-que-no-estaba-guardado'), 'el aviso no dice qué `sub` llegó');
  assert.ok(!linea.includes('ana@ejemplo.com'),
    'el aviso lleva el correo: el registro del cPanel no tiene por qué llevar direcciones para esto');
});

test('entrar por el sub ya conocido NO avisa', async () => {
  /* El camino normal tiene que ser silencioso, o el aviso no sirve para contar
     nada: 78 personas activas entrando cada día ahogarían la señal. */
  const id = uuid();
  const repo = crearRepoFalso({ usuarios: [{ id, email: 'ana@ejemplo.com', emailConfirmado: true }] });
  /* La identidad se siembra por el contrato, no tocando el estado por dentro:
     `crearRepoFalso` sólo admite `usuarios`, y escribir en `_estado` a mano
     haría que esta prueba siguiera pasando si `enlazarIdentidad` se rompiera. */
  await repo.enlazarIdentidad({ usuarioId: id, proveedor: 'google', proveedorId: '1234', email: 'ana@ejemplo.com' });

  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    await google.resolverUsuario({ sub: '1234', email: 'ana@ejemplo.com', email_verified: true }, { repo });
  } finally {
    console.warn = original;
  }

  assert.deepEqual(avisos.filter(a => a.includes('[auth/google]')), [],
    'el camino normal avisa, y así el aviso no distingue nada');
});

/* ── La comprobación de verdad, a petición ─────────────────────────────── */

test('Google sigue declarando subject_types_supported: public', { skip: process.env.COMPROBAR_GOOGLE !== '1' }, async () => {
  const r = await fetch('https://accounts.google.com/.well-known/openid-configuration');
  assert.ok(r.ok, `Google respondió ${r.status}`);
  const doc = await r.json();

  assert.deepEqual(doc.subject_types_supported, ['public'],
    'Google cambió lo que declara. Si ahora ofrece `pairwise`, hay que volver a mirar ' +
    'si el `sub` depende del cliente ANTES de cambiar de cliente OAuth.');
});
