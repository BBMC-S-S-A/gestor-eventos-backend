/* Memoria corta para respuestas que son iguales para todo el mundo.
 *
 * La página pública de un evento se pide en cada visita, en cada iframe
 * incrustado y en cada recarga del formulario, y cada vez recorría eventos,
 * tipos de boleta, formulario, agenda y zonas. El 17-sep eso fue la mayor
 * parte de las ~60k lecturas de `eventos` y de las ~23k de formulario y
 * boletas, con miles de personas registrándose sobre la MISMA respuesta.
 *
 * Se recuerda unos segundos por clave. Lo que se pierde: un cambio del
 * organizador (o un cupo que se agota) tarda como mucho ese tiempo en verse
 * en la página. La compra no depende de esto: `reservar` vuelve a comprobar
 * el cupo contra la base. */
function memoriaCorta({ ms, max = 500 }) {
  const m = new Map(); // clave → { valor, hasta }
  return {
    leer(clave) {
      const r = m.get(clave);
      if (!r) return undefined;
      if (r.hasta <= Date.now()) { m.delete(clave); return undefined; }
      return r.valor;
    },
    guardar(clave, valor) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(clave, { valor, hasta: Date.now() + ms });
    },
    olvidar(prefijo) {
      for (const k of m.keys()) if (k.startsWith(prefijo)) m.delete(k);
    },
    limpiar() { m.clear(); },
  };
}

module.exports = { memoriaCorta };
