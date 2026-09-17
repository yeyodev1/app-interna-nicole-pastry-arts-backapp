/**
 * Siembra el catálogo de vendedores (`sellers`) leyendo las personas marcadas
 * `es_vendedor: true` en Contífico, cuenta por cuenta.
 *
 * Por qué existe: `createOrder` valida la cédula del vendedor contra este catálogo
 * filtrando por la cuenta del pedido (`contificoSource`). El catálogo se había
 * sembrado sólo con los vendedores de Nicole, así que ningún pedido de Sucree con
 * vendedor asignado se podía guardar: devolvía 400 "Vendedor con cédula X no está
 * en el catálogo activo." (reportado el 17/09/2026; el último pedido de Sucree que
 * entró fue del 31/08/2026).
 *
 * Uso:
 *   pnpm seed:sellers                    # ambas cuentas
 *   pnpm seed:sellers -- --source sucree # sólo una
 *   pnpm seed:sellers -- --dry-run       # sólo informa, no escribe
 *
 * Es idempotente: hace upsert por (contificoSource, identification) y nunca borra
 * ni desactiva lo que ya está, para no perder ajustes hechos a mano desde /api/sellers.
 */
import * as dotenv from "dotenv";
dotenv.config();

import dbConnect from "../src/config/mongo";
import { SellerModel } from "../src/models/seller.model";
import { ContificoService } from "../src/services/contifico.service";

type Source = "nicole" | "sucree";

/**
 * Personas de prueba/sistema que Contífico trae marcadas como vendedor pero que no
 * son gente real. No tiene sentido ofrecerlas en el selector del pedido.
 */
const IGNORAR_CEDULAS = new Set(["1234567890", "9999999999"]);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const raw = get("--source");
  const source = raw === "nicole" || raw === "sucree" ? (raw as Source) : undefined;
  return { source, dryRun: args.includes("--dry-run") };
}

async function seedSource(source: Source, dryRun: boolean) {
  const svc = new ContificoService(source);
  const personas = await svc.getPersonas({ es_vendedor: true });

  const vendedores = (personas || []).filter(
    (p: any) => p?.es_vendedor && p?.cedula && !IGNORAR_CEDULAS.has(String(p.cedula).trim())
  );

  console.log(`\n📋 [${source}] ${vendedores.length} vendedor(es) en Contífico:`);

  let creados = 0;
  let actualizados = 0;

  for (const [i, p] of vendedores.entries()) {
    const identification = String(p.cedula).replace(/\D/g, "");
    const name = String(p.razon_social || "").trim();
    console.log(`   · ${name} (${identification})`);
    if (dryRun) continue;

    const res = await SellerModel.updateOne(
      { contificoSource: source, identification },
      {
        $set: { name, contificoPersonId: p.id },
        $setOnInsert: { contificoSource: source, identification, isActive: true, sortOrder: i },
      },
      { upsert: true }
    );
    if (res.upsertedCount) creados++;
    else if (res.modifiedCount) actualizados++;
  }

  return { creados, actualizados, total: vendedores.length };
}

async function main() {
  const { source, dryRun } = parseArgs();
  const sources: Source[] = source ? [source] : ["nicole", "sucree"];

  await dbConnect();
  if (dryRun) console.log("🔍 Dry run: no se escribe nada en Mongo.");

  for (const s of sources) {
    const { creados, actualizados, total } = await seedSource(s, dryRun);
    if (!dryRun) {
      console.log(`✅ [${s}] ${total} vendedor(es): ${creados} creado(s), ${actualizados} actualizado(s).`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error sembrando vendedores:", err);
  process.exit(1);
});
