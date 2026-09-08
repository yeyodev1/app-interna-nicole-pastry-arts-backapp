/**
 * Siembra (o corrige) el contador de secuenciales de factura de la serie configurada
 * (por defecto 001-001 = CDP) con el mayor número REALMENTE emitido.
 *
 * Fuentes que consulta y combina (se queda con el máximo):
 *   1. Mongo: `orders.invoiceInfo.documento` de los pedidos ya facturados.
 *   2. Contífico: GET /documento/ día por día (la API sólo filtra por fecha de emisión).
 *
 * Los secuenciales iguales o mayores a `CONTIFICO_SECUENCIAL_TECHO` (1 000 000) se
 * ignoran: son las 10 facturas 001000001–001000010 del 07–08/09/2026, fuera de la
 * secuencia real (ver src/config/contifico-emision.config.ts).
 *
 * Uso:
 *   pnpm seed:invoice-sequence                          # Mongo + últimos 7 días de Contífico
 *   pnpm seed:invoice-sequence -- --dias 30             # Mongo + últimos 30 días
 *   pnpm seed:invoice-sequence -- --desde 14/01/2026    # Mongo + TODO el historial (recomendado, ~1 h)
 *   pnpm seed:invoice-sequence -- --set 975842          # fija el contador a mano (se combina con lo leído)
 *   pnpm seed:invoice-sequence -- --dry-run             # sólo informa, no escribe
 *
 * Bajar el contador (por ejemplo de 1 000 010 a 975 842) requiere `--force`, porque
 * es la única operación que puede reutilizar un número: hazlo sólo cuando el barrido
 * cubra todo el historial de la serie.
 *
 * Es idempotente: vuelve a leer y deja el contador en el máximo real.
 */
import * as dotenv from "dotenv";
dotenv.config();

import dbConnect from "../src/config/mongo";
import { InvoiceSequenceModel } from "../src/models/invoice-sequence.model";
import { OrderModel } from "../src/models/order.model";
import { ContificoService } from "../src/services/contifico.service";
import {
  CONTIFICO_SERIE,
  CONTIFICO_SECUENCIAL_TECHO,
  buildDocumentNumber,
  parseSequential,
} from "../src/config/contifico-emision.config";

const SOURCE = "nicole";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function parseFechaDMY(raw: string): Date {
  const [d, m, y] = raw.split("/").map(Number);
  const date = new Date(y, m - 1, d);
  if (!d || !m || !y || Number.isNaN(date.getTime())) {
    throw new Error(`Fecha inválida "${raw}" — usar DD/MM/YYYY`);
  }
  return date;
}

async function maxFromMongo(): Promise<{ max: number; count: number; documento?: string }> {
  const cursor = OrderModel.find(
    { "invoiceInfo.documento": { $regex: `^${CONTIFICO_SERIE}-` } },
    { "invoiceInfo.documento": 1 }
  ).lean().cursor();

  let max = 0;
  let count = 0;
  let documento: string | undefined;
  for await (const order of cursor) {
    const doc = (order as any).invoiceInfo?.documento;
    const seq = parseSequential(doc);
    if (seq === null) continue;
    count++;
    if (seq > max) { max = seq; documento = doc; }
  }
  return { max, count, documento };
}

async function main() {
  await dbConnect();

  const dryRun = flag("dry-run");
  const force = flag("force");
  const manual = arg("set") ? Number(arg("set")) : 0;
  const desde = arg("desde") ? parseFechaDMY(arg("desde")!) : undefined;
  const daysBack = Number(arg("dias") || 7);

  console.log(`📌 Serie ${CONTIFICO_SERIE} — techo de lectura ${CONTIFICO_SECUENCIAL_TECHO} (se ignoran secuenciales ≥ techo)`);

  const current = await InvoiceSequenceModel.findOne({ source: SOURCE, serie: CONTIFICO_SERIE }).lean();
  const currentSeq = current?.lastSequential ?? 0;
  console.log(`📍 Contador actual en Mongo: ${currentSeq} ${current ? `(próxima sería ${buildDocumentNumber(currentSeq + 1)})` : "(no existe todavía)"}`);

  console.log(`🔎 Leyendo pedidos facturados en Mongo...`);
  const mongo = await maxFromMongo();
  console.log(`   → ${mongo.count} facturas de la serie; máximo ${mongo.max}${mongo.documento ? ` (${mongo.documento})` : ""}`);

  const service = new ContificoService(SOURCE);
  const rango = desde
    ? `desde ${desde.toLocaleDateString("en-GB")} hasta hoy`
    : `últimos ${daysBack} días`;
  console.log(`🔎 Leyendo documentos en Contífico (${rango})... cada día tarda varios segundos.`);
  const contifico = await service.fetchLastSequentialFromContifico(CONTIFICO_SERIE, {
    daysBack,
    desde,
    floor: 0,
    onDay: (fecha, maxDia, acumulado) => {
      console.log(`   ${fecha}: máx del día ${maxDia || "-"} · acumulado ${acumulado}`);
    },
  });
  console.log(`   → máximo en Contífico: ${contifico}`);

  const target = Math.max(mongo.max, contifico, manual);
  if (target <= 0) {
    console.error("❌ No se encontró ningún secuencial de la serie en ninguna fuente y no se pasó --set. No se escribe nada.");
    process.exit(1);
  }

  console.log("");
  console.log(`🎯 Máximo real de la serie: ${target}. La próxima factura sería ${buildDocumentNumber(target + 1)}.`);

  if (target === currentSeq) {
    console.log("✅ El contador ya está en ese valor. Nada que hacer.");
    process.exit(0);
  }
  if (target < currentSeq) {
    console.log(`⬇️  Esto BAJA el contador de ${currentSeq} a ${target}.`);
    if (!desde) {
      console.log("   ⚠️  Sólo se leyeron los últimos días de Contífico. Para bajar el contador con seguridad hay que barrer todo el historial: --desde 14/01/2026");
    }
    if (!force) {
      console.log("   Agrega --force para confirmar (se recomienda haber corrido con --desde 14/01/2026).");
      process.exit(2);
    }
  }
  if (dryRun) {
    console.log("🧪 --dry-run: no se escribió nada.");
    process.exit(0);
  }

  await InvoiceSequenceModel.updateOne(
    { source: SOURCE, serie: CONTIFICO_SERIE },
    {
      $set: { lastSequential: target },
      $setOnInsert: { source: SOURCE, serie: CONTIFICO_SERIE },
    },
    { upsert: true }
  );

  console.log(`✅ Contador de ${CONTIFICO_SERIE} listo en ${target}. La próxima factura será ${buildDocumentNumber(target + 1)}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error sembrando el contador:", err);
  process.exit(1);
});
