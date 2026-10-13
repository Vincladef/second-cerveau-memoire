# Second cerveau — Mémoire personnelle

Backend privé du projet **Second cerveau** : souvenirs en PostgreSQL sur Neon, embeddings OpenAI et recherche hybride.

- `netlify/functions/memoire.mjs` : API sécurisée du service.
- `netlify.toml` : configuration de déploiement Netlify.
- Les secrets `OPENAI_API_KEY`, `DATABASE_URL` et le jeton d'accès sont définis uniquement dans l'environnement Netlify, jamais dans Git.

L'API ne peut être déclarée opérationnelle qu'après un déploiement Netlify réussi et des tests de bout en bout.
