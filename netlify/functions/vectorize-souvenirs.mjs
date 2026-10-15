import { db, embedStoredMemory } from "./memoire.mjs";

// Rattrape les écritures directes depuis le connecteur Neon :
// elles ne passent pas par /remember et n'ont donc pas d'embedding immédiat.
// Le traitement est borné pour rester sous la limite des fonctions planifiées.
export default async function vectorizeSouvenirs() {
  const sql = db();
  const rows = await sql.query(
    "SELECT id FROM public.souvenirs_a_vectoriser ORDER BY created_at, id LIMIT 8"
  );
  let vectorises = 0;
  for (const row of rows) {
    if (await embedStoredMemory(sql, row.id)) vectorises++;
  }
  console.log("second_cerveau_vectorisation", { selectionnes: rows.length, vectorises });
  return new Response(JSON.stringify({ selectionnes: rows.length, vectorises }), {
    headers: { "content-type": "application/json" }
  });
}

export const config = { schedule: "15 * * * *" };
