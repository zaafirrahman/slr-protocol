// Supabase Edge Function: llm-proxy
// Meneruskan permintaan chat/completions ke DeepSeek memakai key milik admin,
// setelah memeriksa API key pengguna (slr_...) dan kuota hariannya,
// lalu mencatat pemakaian token ke tabel token_logs.
//
// Secrets (Dashboard > Edge Functions > Secrets):
//   DEEPSEEK_API_KEY   key DeepSeek milik admin (TIDAK pernah ke laptop pengguna)
//   DEEPSEEK_URL       opsional, default https://api.deepseek.com/chat/completions
// SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY tersedia otomatis.
//
// Deploy: supabase functions deploy llm-proxy --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const DEEPSEEK_URL = Deno.env.get("DEEPSEEK_URL") ?? "https://api.deepseek.com/chat/completions";
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Baca salinan respons (SSE atau JSON biasa), ambil blok "usage", simpan ke token_logs.
async function recordUsage(body: ReadableStream<Uint8Array>, isStream: boolean, userId: string, model: string) {
  try {
    const text = await new Response(body).text();
    let usage: any = null;
    if (isStream) {
      // Blok usage ada di potongan data terakhir sebelum [DONE]; cukup parse 2 potongan terakhir (hemat CPU).
      const events = text.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]"));
      for (const line of events.slice(-2)) {
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev?.usage) usage = ev.usage;
        } catch { /* potongan tidak lengkap, abaikan */ }
      }
    } else {
      usage = JSON.parse(text)?.usage ?? null;
    }
    if (!usage) return;
    const prompt = Number(usage.prompt_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? 0);
    const hit = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0);
    const total = Number(usage.total_tokens ?? prompt + completion);
    if (total <= 0) return;
    const row = {
      user_id: userId,
      model_name: model,
      prompt_tokens: prompt,
      cache_hit_tokens: hit,
      completion_tokens: completion,
      total_tokens: total,
    };
    // Coba sampai 3 kali: koneksi sesaat ke database kadang putus, jangan sampai pemakaian tak tercatat.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await db.from("token_logs").insert(row);
      if (!error) return;
      console.error(`insert token_logs gagal (percobaan ${attempt}/3):`, error.message);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  } catch (e) {
    console.error("recordUsage gagal:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "Gunakan POST.");
  if (!DEEPSEEK_KEY) return fail(500, "Server belum dikonfigurasi (DEEPSEEK_API_KEY kosong).");

  const userKey = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!userKey.startsWith("slr_")) return fail(401, "API key tidak valid. Daftar ulang lewat /signup.");

  const { data, error } = await db.rpc("check_user", { p_key_hash: await sha256Hex(userKey) });
  if (error) return fail(500, "Gagal memeriksa akun. Coba lagi.");
  const user = data?.[0];
  if (!user) return fail(401, "API key tidak dikenal. Hubungi admin.");
  if (user.status === "disabled") return fail(403, "Akun kamu dinonaktifkan oleh admin.");
  if (user.status === "quota") return fail(429, "Kuota token harian kamu habis. Coba lagi besok atau hubungi admin.");

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "Body harus JSON.");
  }
  const isStream = payload?.stream === true;
  if (isStream) payload.stream_options = { ...(payload.stream_options ?? {}), include_usage: true };

  const upstream = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!upstream.body) return fail(502, "Respons kosong dari penyedia AI.");

  const headers = { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" };
  if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers });

  const [toClient, toLog] = upstream.body.tee();
  // @ts-ignore EdgeRuntime tersedia di Supabase Edge Functions
  EdgeRuntime.waitUntil(recordUsage(toLog, isStream, user.user_id, String(payload?.model ?? "")));
  return new Response(toClient, { status: upstream.status, headers });
});