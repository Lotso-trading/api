interface TargetSeed {
  address: string;
  alias: string;
  weightMultiplier: number;
  maxUsdcPerTrade: number;
}

const TOP_TRADERS: TargetSeed[] = [
  {
    address: "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
    alias: "Theo4 (+22.0M$)",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 50.0,
  },
  {
    address: "0x204f72f35326db932158cba6adff0b9a1da95e14",
    alias: "swisstony (+18.5M$)",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 50.0,
  },
  {
    address: "0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf",
    alias: "Fredi9999 (+16.6M$)",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 50.0,
  },
  {
    address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    alias: "RN1 (+13.4M$)",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 50.0,
  },
  {
    address: "0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee",
    alias: "kch123 (+11.4M$)",
    weightMultiplier: 1.0,
    maxUsdcPerTrade: 50.0,
  },
];

export async function seedTopTraders(): Promise<void> {
  const apiUrl = Deno.env.get("API_URL") || "http://localhost:3000/api";
  console.log(`[Seed] Injection des top baleines vers ${apiUrl}/targets...`);

  for (const trader of TOP_TRADERS) {
    try {
      const res = await fetch(`${apiUrl}/targets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trader),
      });

      if (res.ok) {
        console.log(`✅ [Seed] Baleine ajoutée : ${trader.alias} (${trader.address})`);
      } else {
        const errorText = await res.text();
        console.log(`ℹ️ [Seed] Déjà existant ou ignoré : ${trader.alias} (${errorText})`);
      }
    } catch (err: unknown) {
      console.warn(`⚠️ [Seed] Erreur pour ${trader.alias}:`, err);
    }
  }

  console.log("[Seed] Terminé avec succès !");
}

if (import.meta.main) {
  await seedTopTraders();
}
