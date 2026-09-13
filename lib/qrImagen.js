'use strict';

/* El PNG de un QR, pintado aquí.
 *
 * ── Por qué existe este archivo ───────────────────────────────────────────
 *
 * El QR de los correos se pedía a `api.qrserver.com` con una etiqueta
 * `<img src="…?data=EL_TOKEN">`. Es decir: el JWT que ABRE LA PUERTA del
 * evento viajaba en la URL de un servicio de terceros, y quedaba en sus logs
 * de acceso como queda cualquier query string.
 *
 * El resto del backend ya trata ese token con el cuidado que merece —el
 * escaneo de stands y el canje son POST y no GET precisamente para que el
 * `qr_token` no acabe escrito en los logs de acceso del propio servidor
 * (`routes/interacciones.js`)— así que mandárselo a un tercero en texto claro
 * era la única puerta que quedaba abierta.
 *
 * Y de paso quita una dependencia de red en el camino de «te llega tu
 * boleta»: si ese servicio está caído o bloquea el hotlinking, el correo salía
 * con un hueco donde tenía que estar la entrada.
 *
 * ── Por qué el PNG se escribe a mano ──────────────────────────────────────
 *
 * `qrcode` sabe hacer el PNG solo, pero por streams: `toBuffer` es asíncrono.
 * Eso obligaría a volver `renderEmail` asíncrono, y esa función la llaman
 * también la vista previa del panel y veinte pruebas — un cambio grande en
 * mucho sitio para pintar un cuadro en blanco y negro.
 *
 * Lo que sí es síncrono es `QRCode.create()`, que devuelve la matriz de
 * módulos ya calculada (la parte difícil: Reed-Solomon, máscaras, versión).
 * De ahí al PNG hay un formato muy simple —y `zlib.deflateSync` está en la
 * librería estándar—, así que se escribe aquí y todo sigue siendo síncrono.
 *
 * Un QR es blanco y negro, así que el PNG va en escala de grises de 8 bits:
 * sin paleta, sin canal alfa. Un QR de 253 caracteres a 280 px pesa ~1 KB.
 */

const zlib = require('zlib');
const QRCode = require('qrcode');

/* ── PNG mínimo ───────────────────────────────────────────────────────── */

/* La tabla de CRC-32 del propio formato PNG. Se calcula una vez. */
const TABLA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* Un trozo del PNG: longitud, tipo, datos y el CRC de los dos últimos. */
function chunk(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length, 0);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([largo, cuerpo, crc]);
}

/* `pixeles` es una fila por cada `alto`, de `ancho` bytes en gris (0 negro,
   255 blanco). Cada fila del PNG lleva delante su byte de filtro, que aquí es
   siempre 0 («ninguno»): filtrar sólo ayuda con degradados, y esto son dos
   colores planos que deflate ya comprime de sobra. */
function png({ ancho, alto, pixeles }) {
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8;   // 8 bits por muestra
  cabecera[9] = 0;   // escala de grises
  cabecera[10] = 0;  // deflate
  cabecera[11] = 0;  // filtrado estándar
  cabecera[12] = 0;  // sin entrelazado

  const conFiltro = Buffer.alloc((ancho + 1) * alto);
  for (let y = 0; y < alto; y++) {
    conFiltro[y * (ancho + 1)] = 0;
    pixeles.copy(conFiltro, y * (ancho + 1) + 1, y * ancho, (y + 1) * ancho);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', cabecera),
    chunk('IDAT', zlib.deflateSync(conFiltro, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── El QR ────────────────────────────────────────────────────────────── */

/* El PNG de un QR, síncrono.
 *
 * `tamano` es una orientación, no una promesa: el lado final es un múltiplo
 * exacto del número de módulos, porque escalar un QR por un número no entero
 * deja módulos de anchura desigual y hay lectores baratos —los de la puerta,
 * justo— que fallan con eso. Se busca el múltiplo que más se acerque.
 *
 * El margen de 4 módulos («quiet zone») es el que manda el estándar: sin él,
 * un QR pegado al borde de una tarjeta blanca no siempre se detecta.
 *
 * Nivel M como en todo lo demás de GESTEK: es contra lo que están medidas las
 * escarapelas y las etiquetas térmicas del frontend.
 */
function qrPng(texto, { tamano = 280, margen = 4 } = {}) {
  const qr = QRCode.create(String(texto), { errorCorrectionLevel: 'M' });
  const modulos = qr.modules.size;
  const total = modulos + margen * 2;

  const escala = Math.max(1, Math.round(tamano / total));
  const lado = total * escala;

  /* Blanco entero, y encima se pintan los módulos negros. */
  const pixeles = Buffer.alloc(lado * lado, 0xFF);

  for (let y = 0; y < modulos; y++) {
    for (let x = 0; x < modulos; x++) {
      if (!qr.modules.data[y * modulos + x]) continue;
      const px0 = (x + margen) * escala;
      const py0 = (y + margen) * escala;
      for (let dy = 0; dy < escala; dy++) {
        pixeles.fill(0x00, (py0 + dy) * lado + px0, (py0 + dy) * lado + px0 + escala);
      }
    }
  }

  return { buffer: png({ ancho: lado, alto: lado, pixeles }), lado };
}

/* El QR listo para meterlo en un correo.
 *
 * Va como adjunto embebido (`cid:`) y no como `data:` en el `src`: Gmail
 * bloquea las imágenes `data:` —se vería un hueco, que es exactamente el
 * problema que esto viene a arreglar—, mientras que el `cid:` de toda la vida
 * lo pintan Gmail, Outlook y Apple Mail sin preguntar.
 *
 * Devuelve `null` si el texto no se puede codificar (demasiado largo para un
 * QR). Quien llama enseña el correo sin QR, que es lo que pasaba ya cuando no
 * había token: se sigue yendo con el código corto escrito, que la puerta
 * también acepta.
 */
function qrParaCorreo(texto, { cid = 'qr-entrada', tamano = 280 } = {}) {
  if (!texto) return null;
  try {
    const { buffer, lado } = qrPng(texto, { tamano });
    return {
      cid,
      lado,
      adjunto: {
        filename: 'qr.png',
        content: buffer,
        contentType: 'image/png',
        cid,
        /* `inline` para que el cliente lo pinte en su sitio en vez de
           enseñarlo como un archivo colgando al final del mensaje. */
        contentDisposition: 'inline',
      },
    };
  } catch (e) {
    console.warn('[qr] no se pudo generar el PNG del QR:', e.message);
    return null;
  }
}

module.exports = { qrPng, qrParaCorreo, png, crc32 };
