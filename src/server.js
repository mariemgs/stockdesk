// StockDesk: tiny stock-tracking API. Node.js 18+, no dependency.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkDatabase } = require("./db");

const config = {
  port: Number(process.env.PORT || 3000),
  dbHost: process.env.DB_HOST || "localhost",
  dbPort: Number(process.env.DB_PORT || 5432),
  dbUser: process.env.DB_USER || "stockdesk",
  dbPassword: process.env.DB_PASSWORD || "",
  apiKey: process.env.API_KEY || "",
};

// Seeded in-memory data (the real application would read it from PostgreSQL).
const products = [
  { sku: "BOLT-M6", name: "Hex bolt M6", stock: 1200 },
  { sku: "NUT-M6", name: "Hex nut M6", stock: 950 },
  { sku: "WASH-M6", name: "Flat washer M6", stock: 40 },
  { sku: "DRILL-18V", name: "Cordless drill 18V", stock: 12 },
  { sku: "GLOVE-L", name: "Work gloves, size L", stock: 75 },
];

// Largest request body accepted on POST routes (the adjust payload is a few bytes).
const MAX_BODY_BYTES = 16 * 1024;

// Compare the presented API key with the configured one in constant time.
function apiKeyMatches(presented) {
  if (!config.apiKey || typeof presented !== "string") return false;
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(config.apiKey).digest();
  return crypto.timingSafeEqual(a, b);
}

// What is safe to print at startup: never the password or the API key.
function redactedConfig() {
  return {
    port: config.port,
    dbHost: config.dbHost,
    dbPort: config.dbPort,
    dbUser: config.dbUser,
    dbPasswordSet: config.dbPassword !== "",
    apiKeySet: config.apiKey !== "",
  };
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    // Liveness: the process answers. Does not depend on the database, so a
    // database outage does not make Kubernetes restart every pod in a loop.
    if (req.method === "GET" && url.pathname === "/livez") return send(res, 200, { status: "alive" });

    // Readiness: the process answers and the database accepts connections.
    if (req.method === "GET" && url.pathname === "/health") {
      const dbOk = await checkDatabase(config.dbHost, config.dbPort);
      return dbOk ? send(res, 200, { status: "ok", database: "up" }) : send(res, 503, { status: "degraded", database: "down" });
    }

    if (req.method === "GET" && url.pathname === "/api/products") return send(res, 200, products);

    const m = url.pathname.match(/^\/api\/products\/([A-Z0-9-]+)\/adjust$/);
    if (req.method === "POST" && m) {
      if (!apiKeyMatches(req.headers["x-api-key"])) return send(res, 401, { error: "Missing or invalid API key" });
      const product = products.find((p) => p.sku === m[1]);
      if (!product) return send(res, 404, { error: "Unknown SKU" });
      let raw = "";
      let tooLarge = false;
      req.on("data", (c) => {
        if (tooLarge) return;
        raw += c;
        if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
          tooLarge = true;
          send(res, 413, { error: "Request body too large" });
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooLarge) return;
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "Invalid JSON" }); }
        if (!Number.isInteger(body.delta)) return send(res, 400, { error: "delta must be an integer" });
        if (product.stock + body.delta < 0) return send(res, 409, { error: "Stock cannot go below zero" });
        product.stock += body.delta;
        send(res, 200, product);
      });
      return;
    }

    send(res, 404, { error: "Not found" });
  });
}

function start() {
  // Startup trace, useful when debugging a deployment (secrets are not printed).
  console.log("StockDesk starting with config:", JSON.stringify(redactedConfig()));
  // Small marker file written at startup (used by the support team to see the last restart time).
  fs.writeFileSync(path.join(os.tmpdir(), "stockdesk-started.txt"), new Date().toISOString());
  const server = createServer();
  server.listen(config.port, () => console.log("StockDesk listening on port " + config.port));
  // Node does not stop on SIGTERM by default when it runs as PID 1 in a container:
  // close the server so Kubernetes and Docker can stop the pod cleanly.
  process.once("SIGTERM", () => {
    console.log("SIGTERM received, closing the server");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, config, products, redactedConfig, MAX_BODY_BYTES };
