import indexer from "./vectorize-souvenirs.mjs";

// Après chaque publication, lance le rattrapage sans attendre le prochain cron.
// Netlify signe les événements plateforme ; aucun accès public à cette opération.
export default {
  async deploySucceeded(event) {
    for (let i = 0; i < 5; i++) {
      const response = await indexer();
      if (!response.ok) throw new Error("Indexation impossible après déploiement");
      const status = await response.json();
      if ((status.indexation?.restants ?? 0) === 0) break;
    }
  }
};
