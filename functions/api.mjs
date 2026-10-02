import { getStore } from "@netlify/blobs";
import seed from "./seed.json";

const KEY = "products";

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function getProducts(store) {
  let arr = await store.get(KEY, { type: "json" });
  if (!arr) {
    arr = seed && Array.isArray(seed.products) ? seed.products : [];
    await store.setJSON(KEY, arr);
  }
  return arr;
}

async function identify(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "no_key" });

  const model = process.env.AI_MODEL || "claude-haiku-4-5-20251001";
  const img = body.image || "";
  const m = /^data:(.*?);base64,([\s\S]*)$/.exec(img);
  const media = m ? m[1] : "image/jpeg";
  const data = m ? m[2] : img;
  if (!data) return json({ error: "no_image" });

  const taxoBlock = (body.taxo && body.taxo.trim())
    ? ("Categories and subcategories already in use (REUSE exactly one if it fits, with the same spelling and language; invent a new short one only if none fits, in the same language as the list):\n" + body.taxo)
    : ('No categories yet. Choose short labels (e.g. category "Hair", subcategory "Shampoo").');

  const prompt =
    "You help manage a spa/cosmetics product inventory. The image shows ONE product. Read the packaging and classify it.\n" +
    taxoBlock +
    "\n\nReply with ONLY a JSON object, no other text: {\"name\": string, \"category\": string, \"subcategory\": string, \"description\": string}. " +
    "\"name\" = brand + product name exactly as on the packaging, short, without volume or weight. " +
    "\"description\" = 1-2 sentences: what the product is and what it is used for, based on the packaging. " +
    "If unsure about the subcategory, use \"\".";

  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch (e) {
    return json({ error: "net" });
  }

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return json({ error: "ai_" + r.status, message: txt.slice(0, 200) });
  }

  const d = await r.json();
  let text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  let obj = {};
  try {
    obj = JSON.parse(text);
  } catch {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s >= 0 && e > s) { try { obj = JSON.parse(text.slice(s, e + 1)); } catch {} }
  }
  return json({
    name: (obj.name || "").toString(),
    category: (obj.category || "").toString(),
    subcategory: (obj.subcategory || "").toString(),
    description: (obj.description || "").toString(),
  });
}

export default async (req) => {
  const store = getStore("stock");
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.get("a") === "list") {
      const arr = await getProducts(store);
      return json({ products: arr });
    }
    if (req.method === "GET" && url.searchParams.get("a") === "reseed") {
      const arr = seed && Array.isArray(seed.products) ? seed.products : [];
      await store.setJSON(KEY, arr);
      return json({ ok: true, count: arr.length });
    }
    if (req.method === "POST") {
      const body = await req.json();
      if (body.op === "identify") return await identify(body);
      if (body.op === "put") {
        const p = body.product;
        if (!p || !p.id) return json({ error: "bad_product" }, 400);
        const arr = await getProducts(store);
        const i = arr.findIndex(x => x.id === p.id);
        if (i >= 0) arr[i] = p; else arr.push(p);
        await store.setJSON(KEY, arr);
        return json({ ok: true });
      }
      if (body.op === "del") {
        const arr = await getProducts(store);
        const next = arr.filter(x => x.id !== body.id);
        await store.setJSON(KEY, next);
        return json({ ok: true });
      }
    }
    return json({ error: "bad_request" }, 400);
  } catch (e) {
    return json({ error: "server", message: String((e && e.message) || e) }, 500);
  }
};
