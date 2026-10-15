import { db, makeEmbedding } from "./memoire.mjs";

// Index derive des onze tables du Second cerveau. Les tables de travail
// ne sont jamais modifiees ni dupliquees dans public.souvenirs.
export default async function vectorizeMemory() {
  const sql = db();

  await sql.query(`
    INSERT INTO public.memoire_index_semantique AS idx (origine, cle, texte, actif)
    SELECT origine, cle, texte, true FROM public.second_cerveau_documents
    ON CONFLICT (origine, cle) DO UPDATE
      SET texte=EXCLUDED.texte, embedding=NULL, embedding_modele=NULL,
          embedding_mis_a_jour=NULL, actualise_le=now(), actif=true
      WHERE idx.texte IS DISTINCT FROM EXCLUDED.texte OR NOT idx.actif
  `);

  // Une suppression ou un déplacement dans la table source désactive son index,
  // sans jamais toucher à la donnée d'origine.
  await sql.query(`
    UPDATE public.memoire_index_semantique AS idx SET actif=false,actualise_le=now()
    WHERE idx.actif AND NOT EXISTS (
      SELECT 1 FROM public.second_cerveau_documents d
      WHERE d.origine=idx.origine AND d.cle=idx.cle
    )
  `);

  // Réutiliser les embeddings de souvenirs déjà présents pour éviter le recalcul.
  await sql.query(`
    UPDATE public.memoire_index_semantique idx
    SET embedding=s.embedding, embedding_modele=s.embedding_modele,
        embedding_mis_a_jour=s.embedding_mis_a_jour
    FROM public.souvenirs s
    WHERE idx.origine='souvenirs' AND idx.cle=s.id::text
      AND idx.actif AND idx.embedding IS NULL
      AND s.embedding IS NOT NULL AND s.embedding_modele='text-embedding-3-small'
      AND idx.texte=concat_ws(E'\\n',NULLIF(s.sujet,''),s.contenu,NULLIF(s.contexte,''))
  `);

  // Les appels OpenAI sont bornés ; le reste sera repris à la prochaine exécution.
  const pending = await sql.query(`
    SELECT origine,cle,texte FROM public.memoire_index_semantique
    WHERE actif AND embedding IS NULL ORDER BY actualise_le,origine,cle LIMIT 8
  `);
  let vectorises = 0;
  for (const item of pending) {
    const vector = await makeEmbedding(item.texte);
    const result = await sql.query(
      "UPDATE public.memoire_index_semantique SET embedding=$1::vector, " +
      "embedding_modele=$2,embedding_mis_a_jour=now() " +
      "WHERE origine=$3 AND cle=$4 AND texte=$5 AND actif AND embedding IS NULL RETURNING cle",
      [vector,"text-embedding-3-small",item.origine,item.cle,item.texte]
    );
    if (result.length) vectorises++;
  }

  // Garder également compatible l'ancien moteur hybride de souvenirs.
  await sql.query(`
    UPDATE public.souvenirs s
    SET embedding=idx.embedding,embedding_modele=idx.embedding_modele,
        embedding_mis_a_jour=idx.embedding_mis_a_jour
    FROM public.memoire_index_semantique idx
    WHERE idx.origine='souvenirs' AND idx.cle=s.id::text AND idx.actif
      AND idx.embedding IS NOT NULL
      AND (s.embedding IS NULL OR s.embedding_modele IS DISTINCT FROM idx.embedding_modele)
      AND idx.texte=concat_ws(E'\\n',NULLIF(s.sujet,''),s.contenu,NULLIF(s.contexte,''))
  `);

  const stats = await sql.query(`
    SELECT count(*)::integer total,
      count(embedding)::integer vectorises,
      count(*) FILTER (WHERE actif AND embedding IS NULL)::integer restants
    FROM public.memoire_index_semantique WHERE actif
  `);
  console.log("second_cerveau_indexation", stats[0]);
  return new Response(JSON.stringify({ indexation: stats[0], nouveaux_embeddings: vectorises }), {
    headers: { "content-type": "application/json" }
  });
}

export const config = { schedule: "15 * * * *" };
