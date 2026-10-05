const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || "");
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "https://koshermat-site.onrender.com");

function applyCors(res, requestOrigin) {
  const origin = requestOrigin === ALLOWED_ORIGIN ? requestOrigin : ALLOWED_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type, x-supabase-api-version, prefer");
  res.setHeader("Access-Control-Expose-Headers", "content-range, x-supabase-api-version");
  res.setHeader("Vary", "Origin");
}

function json(res, status, data, requestOrigin) {
  applyCors(res, requestOrigin);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", chunk => {
      total += chunk.length;
      if (total > 12 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyToSupabase(req, res, requestOrigin) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    json(res, 500, { message: "Auth proxy is not configured." }, requestOrigin);
    return;
  }

  const targetPath = req.url.slice("/supabase".length);
  const targetUrl = SUPABASE_URL + (targetPath.startsWith("/") ? targetPath : "/" + targetPath);
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readRequestBody(req);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (["host", "origin", "content-length", "connection"].includes(lower)) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (value != null) headers[key] = value;
  }

  // The publishable/anon key is needed by Supabase APIs. The browser's
  // Authorization header is preserved so logged-in requests keep their user session.
  if (!headers.apikey) headers.apikey = SUPABASE_ANON_KEY;
  if (!headers.authorization && !targetPath.startsWith("/auth/v1/user")) {
    headers.authorization = "Bearer " + SUPABASE_ANON_KEY;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal
    });

    applyCors(res, requestOrigin);
    res.statusCode = upstream.status;

    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    for (const header of ["content-range", "x-supabase-api-version", "cache-control", "etag", "location"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.end(responseBody);
  } catch (error) {
    console.error("Supabase proxy error:", {
      method: req.method,
      path: targetPath,
      name: error && error.name,
      message: error && error.message
    });

    json(
      res,
      error && error.name === "AbortError" ? 504 : 502,
      {
        message: error && error.name === "AbortError"
          ? "שרת האימות לא הגיב בזמן."
          : "שרת האימות לא זמין כרגע."
      },
      requestOrigin
    );
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ALLOWED_ORIGIN;
  applyCors(res, origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    json(res, SUPABASE_URL && SUPABASE_ANON_KEY ? 200 : 503, {
      ok: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
      service: "koshermat-auth-api",
      proxy: true
    }, origin);
    return;
  }

  if (req.url.startsWith("/supabase/")) {
    await proxyToSupabase(req, res, origin);
    return;
  }

  json(res, 404, { message: "Not found" }, origin);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("KosherMat Supabase proxy listening on port " + PORT);
});
