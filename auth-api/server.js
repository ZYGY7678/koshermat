const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || "");
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "https://koshermat-site.onrender.com");

function sendJson(res, status, payload, origin = ALLOWED_ORIGIN) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.end(JSON.stringify(payload));
}

function corsHeaders(res, origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ALLOWED_ORIGIN;
  corsHeaders(res, origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
    sendJson(res, configured ? 200 : 503, {
      ok: configured,
      service: "koshermat-auth-api"
    }, origin);
    return;
  }

  if (req.method !== "POST" || req.url !== "/signup") {
    sendJson(res, 404, { error: "Not found" }, origin);
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    sendJson(res, 500, { error: "Auth API is not configured." }, origin);
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message }, origin);
    return;
  }

  const username = String(body.username || "").trim();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");

  if (username.length < 3 || username.length > 30) {
    sendJson(res, 400, { error: "שם המשתמש חייב להכיל בין 3 ל-30 תווים." }, origin);
    return;
  }
  if (!validEmail(email)) {
    sendJson(res, 400, { error: "הזן כתובת אימייל תקינה." }, origin);
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: "הסיסמה חייבת להכיל לפחות 6 תווים." }, origin);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(SUPABASE_URL + "/auth/v1/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        email,
        password,
        data: { username }
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: text || "Unknown response from Supabase." };
    }

    if (!response.ok) {
      sendJson(res, response.status, {
        error: payload.msg || payload.message || payload.error_description || payload.error || "שגיאה בהרשמה.",
        code: payload.code || null
      }, origin);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      user: payload.user || null,
      session: payload.session || null
    }, origin);
  } catch (error) {
    console.error("Supabase signup proxy error:", error);
    sendJson(res, 502, {
      error: error && error.name === "AbortError"
        ? "שרת האימות לא הגיב בזמן."
        : "שרת האימות לא זמין כרגע."
    }, origin);
  } finally {
    clearTimeout(timeout);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("KosherMat auth API listening on port " + PORT);
});
