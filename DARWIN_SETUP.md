# Darwin Trading Lab : moteur Paper à la minute

Cette branche ajoute une fonction Netlify indépendante de l'application Second cerveau. Elle ne modifie ni l'API Second cerveau ni sa variable DATABASE_URL.

## Fonctionnement

- Fonction : netlify/functions/darwin-paper.mjs.
- Fréquence : cron * * * * * (une minute), seulement après publication en production.
- Initialement désactivée : tant que DARWIN_TRADING_ENABLED n'est pas exactement true, aucune connexion au courtier et aucun ordre.
- URL strictement Paper : https://paper-api.alpaca.markets (éventuellement suffixe /v2).
- Base de trading séparée : DARWIN_DATABASE_URL pointe vers darwin_trading_lab, sans remplacer DATABASE_URL.
- Variables secrètes utilisées : ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL.
- Stratégies intraday traitées : 23 (momentum ETH 5 minutes) et 24 (retour à la moyenne ETH 1 minute).
- Un achat nécessite un signal réel et le solde disponible ; une vente nécessite une position ETH détenue par le moteur et une règle de sortie.
- Les positions BTC historiques ne sont pas touchées.
- Une clé client d'ordre déterministe et les tables darwin_engine_ticks, darwin_engine_orders, darwin_engine_positions limitent les doublons.
- Les ordres non résolus bloquent une nouvelle transmission tant que leur état n'a pas été rapproché avec Alpaca.
- Seuls les ordres remplis et confirmés par Alpaca sont inscrits en tant que trades exécutés.

## Mise en service

1. Vérifier que les variables Netlify sont accessibles en contexte production, scope Functions ; ne jamais publier les valeurs.
2. Vérifier l'authentification depuis Netlify vers les deux API (le plugin ChatGPT fonctionne avec une autre connexion).
3. Déployer après revue de code. Les Deploy Previews n'activent pas automatiquement la planification cron.
4. Examiner les logs de la fonction et les tables Neon sur une invocation sans trading.
5. Activer DARWIN_TRADING_ENABLED=true une fois les contrôles réussis ; redéployer, puis vérifier les véritables ordres dans Alpaca Paper et Neon.
6. Arrêt : remettre DARWIN_TRADING_ENABLED=false et redéployer, puis vérifier les ordres ouverts Alpaca.

## Limites

Ce service minute n'est pas du HFT sous la seconde. Il ne gère que les nouvelles stratégies 23 et 24 à ce stade. Aucun rendement n'est garanti et le coût des ordres peut épuiser les liquidités Paper. Le code de cette branche n'a pas été exécuté en production.

Documentation : https://docs.netlify.com/build/functions/scheduled-functions/ ; https://docs.alpaca.markets/us/docs/crypto-orders
