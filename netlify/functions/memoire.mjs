import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const MODEL = "text-embedding-3-small";
const MAX_TEXT = 18000;
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

function trimmed(value, max = 3000) {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, max) || null;
}

function limit(value, max = 30) {
  if (value === undefined || value === null) return 10;
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(1, n)) : 10;
}

async function isAuthenticated(request, sql) {
  const supplied = request.headers.get("authorization") || "";
  if (!supplied.startsWith("Bearer ") || supplied.length > 256) return false;
  const records = await sql.query(
    "SELECT bearer_token FROM second_cerveau_prive.api_access WHERE id=1"
  );
  const token = records[0]?.bearer_token;
  if (typeof token !== "string" || token.length !== 64) return false;
  const a = Buffer.from(supplied.slice(7), "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  return neon(process.env.DATABASE_URL);
}

function inputText(row) {
  return [row.sujet, row.contenu, row.contexte].filter(Boolean).join("\n");
}

async function makeEmbedding(input) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const answer = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + process.env.OPENAI_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({ input, model: MODEL })
  });
  if (!answer.ok) throw new Error("Embedding request failed: HTTP " + answer.status);
  const output = await answer.json();
  const vector = output?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1536 || !vector.every(Number.isFinite)) {
    throw new Error("Invalid embedding result");
  }
  return JSON.stringify(vector);
}

async function embedStoredMemory(sql, id) {
  const rows = await sql.query(
    "SELECT id,contenu,sujet,contexte FROM public.souvenirs WHERE id=$1::bigint LIMIT 1",
    [id]
  );
  if (!rows.length) return false;
  const text = inputText(rows[0]);
  const vector = await makeEmbedding(text);
  const changed = await sql.query(
    "UPDATE public.souvenirs SET embedding=$1::vector,embedding_modele=$2,embedding_mis_a_jour=now() " +
    "WHERE id=$3::bigint AND concat_ws(E'\\n',NULLIF(sujet,''),contenu,NULLIF(contexte,''))=$4 RETURNING id",
    [vector, MODEL, id, text]
  );
  return changed.length === 1;
}

async function handle(request) {
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/api/second-cerveau") {
    return respond({ service: "Second cerveau", status: "online", model: MODEL });
  }
  if (request.method === "GET" && pathname === "/api/second-cerveau/ready") {
    const sql = db();
    const records = await sql.query("SELECT count(*)::integer AS n FROM second_cerveau_prive.api_access WHERE id=1");
    const authReady = records[0]?.n === 1;
    return respond({
      service: "Second cerveau",
      database: "connected",
      authentication: authReady ? "configured" : "missing",
      openai: process.env.OPENAI_API_KEY ? "configured" : "missing",
      ready: authReady && Boolean(process.env.OPENAI_API_KEY)
    }, authReady && process.env.OPENAI_API_KEY ? 200 : 503);
  }
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  const sql = db();
  if (!await isAuthenticated(request, sql)) return respond({ error: "Unauthorized" }, 401);

  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > 80000) return respond({ error: "Request too large" }, 413);
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return respond({ error: "Expected JSON object" }, 400);
  }

  if (pathname === "/api/second-cerveau/search" || pathname === "/api/second-cerveau") {
    const question = trimmed(payload.question, 6000);
    if (!question) return respond({ error: "Question required" }, 400);
    const count = limit(payload.limit);
    let vector, warning;
    try {
      vector = await makeEmbedding(question);
    } catch (error) {
      warning = "Embedding unavailable; lexical fallback (" + String(error?.message).slice(0, 90) + ")";
    }
    const results = vector
      ? await sql.query(
          "SELECT * FROM public.rechercher_souvenirs_hybride($1::text,$2::vector,$3::integer)",
          [question, vector, count]
        )
      : await sql.query(
          "SELECT * FROM public.rechercher_souvenirs($1::text,$2::integer)",
          [question, count]
        );
    return respond({ mode: vector ? "hybride" : "textuelle", model: MODEL, resultats: results, ...(warning ? { note: warning } : {}) });
  }

  if (pathname === "/api/second-cerveau/remember") {
    const contenu = trimmed(payload.contenu, MAX_TEXT);
    if (!contenu) return respond({ error: "Contenu required" }, 400);
    const sujet = trimmed(payload.sujet);
    const contexte = trimmed(payload.contexte);
    const provenance = trimmed(payload.source, 500);
    const date = typeof payload.date_evenement === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date_evenement)
      ? payload.date_evenement : null;
    const records = await sql.query(
      "INSERT INTO public.souvenirs(contenu,sujet,contexte,source,date_evenement) " +
      "VALUES($1,$2,$3,$4,$5::date) RETURNING id",
      [contenu, sujet, contexte, provenance, date]
    );
    const id = records[0].id;
    try {
      const vectorise = await embedStoredMemory(sql, id);
      return respond({ id, enregistre: true, vectorise }, 201);
    } catch (error) {
      return respond({ id, enregistre: true, vectorise: false, note: "Embedding pending: " + error.message }, 201);
    }
  }

  if (pathname === "/api/second-cerveau/update") {
    const id = Number(payload.id);
    const contenu = trimmed(payload.contenu, MAX_TEXT);
    if (!Number.isSafeInteger(id) || id <= 0 || !contenu) return respond({ error: "Invalid id or contenu" }, 400);
    const rows = await sql.query(
      "UPDATE public.souvenirs SET contenu=$1,updated_at=now() WHERE id=$2::bigint RETURNING id",
      [contenu, id]
    );
    if (!rows.length) return respond({ error: "Memory not found" }, 404);
    try {
      const vectorise = await embedStoredMemory(sql, id);
      return respond({ id, actualise: true, vectorise });
    } catch (error) {
      return respond({ id, actualise: true, vectorise: false, note: "Embedding pending: " + error.message });
    }
  }

  if (pathname === "/api/second-cerveau/vectorize") {
    const max = limit(payload.limit, 20);
    const todo = await sql.query(
      "SELECT id FROM public.souvenirs_a_vectoriser ORDER BY created_at ASC LIMIT $1",
      [max]
    );
    let vectorises = 0, warning;
    for (const row of todo) {
      try {
        if (await embedStoredMemory(sql, row.id)) vectorises++;
      } catch (error) {
        warning = "Vectorization interrupted: " + error.message;
        break;
      }
    }
    return respond({ selectionnes: todo.length, vectorises, termine: !warning, ...(warning ? { note: warning } : {}) }, warning ? 503 : 200);
  }

  return respond({ error: "Unknown endpoint" }, 404);
}

export default async function memoire(request) {
  try {
    return await handle(request);
  } catch (error) {
    console.error("Second cerveau backend", error?.name, error?.code);
    return respond({ error: "Internal service error" }, 500);
  }
}

export const config = {
  path: ["/api/second-cerveau", "/api/second-cerveau/*"]
};

// Fonctions internes reutilisees par la tache de rattrapage planifiee.
export { db, embedStoredMemory };
