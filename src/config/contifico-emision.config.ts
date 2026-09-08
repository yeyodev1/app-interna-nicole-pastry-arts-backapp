/**
 * Configuración del punto de emisión de facturas en Contífico.
 *
 * Contexto (verificado contra la API el 04/09/2026, cuenta LA FINESTRA S.A.S. — RUC 0993375793001):
 * la cuenta tiene UN SOLO establecimiento (001), cuya dirección en el SRI es
 * "GUAYAQUIL / CALLE PRIMERA Y CALLE SEGUNDA / MAPASINGUE OESTE" — el CDP.
 * No existe ningún establecimiento ni punto de emisión de "Mall del Sol".
 *
 * Puntos de emisión de la cuenta:
 *   001-001 → Matriz / CDP  ← el que usa esta integración (principal)
 *   001-002 → Caja Dulcería
 *   001-003 → Caja Heladería
 *   001-004 → Caja Casa Mía
 *   001-005 → C.C. San Marino
 *   999-999 → POS "API" (no electrónico)
 *
 * Toda factura emitida por este sistema debe salir en 001-001 (CDP principal).
 */

/** Establecimiento SRI (3 dígitos). */
export const CONTIFICO_ESTABLECIMIENTO = (process.env.CONTIFICO_ESTABLECIMIENTO || "001").padStart(3, "0");

/** Punto de emisión SRI (3 dígitos). 001 = Matriz / CDP. */
export const CONTIFICO_PUNTO_EMISION = (process.env.CONTIFICO_PUNTO_EMISION || "001").padStart(3, "0");

/** Serie del documento, ej. "001-001". */
export const CONTIFICO_SERIE = `${CONTIFICO_ESTABLECIMIENTO}-${CONTIFICO_PUNTO_EMISION}`;

/**
 * Historia de la numeración de la serie 001-001, para entender los dos límites de abajo.
 *
 * 14/01/2026 – 04/09/2026: el número se sorteaba con `Math.random()` entre 100000 y
 *   999999. No era un secuencial: la serie quedó salpicada de números sin orden a lo
 *   largo de todo ese rango, y ninguna factura pasó de 999 999.
 *
 * 04/09/2026: se reemplazó el sorteo por el contador atómico en Mongo (`InvoiceSequence`),
 *   pero arrancando en 1 000 000 para no tener que reconstruir el máximo histórico.
 *   Resultado: las facturas 001-001-001000001 … 001000010 (07 y 08/09/2026). La
 *   clienta lo leyó como que la numeración "volvió a 1" y pidió que la secuencia
 *   continúe desde donde venía. Esas 10 facturas quedan emitidas y autorizadas; ella
 *   las justifica ante el SRI si hace falta, no se anulan.
 *
 * 08/09/2026: el contador se re-siembra con el mayor secuencial REAL emitido en la
 *   serie (por debajo del techo), leído de todo el historial de Contífico y de los
 *   pedidos en Mongo. Desde ahí la numeración es correlativa y, como el sorteo nunca
 *   superó ese máximo, no puede chocar con un número ya autorizado.
 *   Correr `pnpm seed:invoice-sequence -- --desde 14/01/2026` para hacerlo.
 */

/**
 * Piso opcional del contador. Sólo se usa al sembrar o re-sincronizar desde Contífico
 * cuando la lectura no encuentra nada mayor. Por defecto 0 (sin piso): el número
 * correcto sale de la lectura real, no de una constante.
 */
export const CONTIFICO_SECUENCIAL_MINIMO = Number(process.env.CONTIFICO_SECUENCIAL_MINIMO || 0);

/**
 * Techo de lectura: al leer documentos de Contífico se IGNORAN los secuenciales
 * iguales o mayores a este valor. Sirve para que las 10 facturas 001000001–001000010
 * del 07–08/09/2026 (ver historia arriba) no vuelvan a arrastrar el contador a
 * 1 000 000 en una re-sincronización. Al ritmo actual la serie real tardará décadas
 * en acercarse a este número; si algún día pasa, subir el techo por env var.
 */
export const CONTIFICO_SECUENCIAL_TECHO = Number(process.env.CONTIFICO_SECUENCIAL_TECHO || 1_000_000);

/** Arma el número completo del documento, ej. "001-001-000975843". */
export function buildDocumentNumber(sequential: number): string {
  return `${CONTIFICO_SERIE}-${String(sequential).padStart(9, "0")}`;
}

/**
 * Extrae el secuencial de un número de documento de la serie dada.
 * Devuelve `null` si el documento no pertenece a la serie, no es numérico o está
 * en o por encima del techo (`CONTIFICO_SECUENCIAL_TECHO`).
 */
export function parseSequential(documento: unknown, serie: string = CONTIFICO_SERIE): number | null {
  const numero = String(documento ?? "").trim();
  if (!numero.startsWith(`${serie}-`)) return null;
  const seq = Number(numero.slice(serie.length + 1));
  if (!Number.isFinite(seq) || seq <= 0) return null;
  if (seq >= CONTIFICO_SECUENCIAL_TECHO) return null;
  return seq;
}
