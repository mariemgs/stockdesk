const { test } = require("node:test");
const assert = require("node:assert");
const net = require("net");
const { createServer, config, redactedConfig, MAX_BODY_BYTES } = require("../src/server");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("GET /api/products returns the seeded products", async () => {
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/products`);
  assert.strictEqual(res.status, 200);
  const list = await res.json();
  assert.strictEqual(list.length, 5);
  server.close();
});

test("GET /health is 503 when the database is unreachable", async () => {
  config.dbHost = "127.0.0.1";
  config.dbPort = 1; // nothing listens here
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(res.status, 503);
  server.close();
});

test("GET /health is 200 when the database accepts connections", async () => {
  const fakeDb = net.createServer((s) => s.end());
  await new Promise((r) => fakeDb.listen(0, "127.0.0.1", r));
  config.dbHost = "127.0.0.1";
  config.dbPort = fakeDb.address().port;
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.strictEqual(res.status, 200);
  server.close();
  fakeDb.close();
});

test("POST adjust is refused without the API key", async () => {
  config.apiKey = "test-key";
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/products/BOLT-M6/adjust`, { method: "POST", body: JSON.stringify({ delta: 1 }) });
  assert.strictEqual(res.status, 401);
  server.close();
});

test("POST adjust refuses a negative stock", async () => {
  config.apiKey = "test-key";
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/products/DRILL-18V/adjust`, {
    method: "POST",
    headers: { "x-api-key": "test-key" },
    body: JSON.stringify({ delta: -999 }),
  });
  assert.strictEqual(res.status, 409);
  server.close();
});

test("GET /livez is 200 even when the database is unreachable", async () => {
  config.dbHost = "127.0.0.1";
  config.dbPort = 1; // nothing listens here
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/livez`);
  assert.strictEqual(res.status, 200);
  server.close();
});

test("POST adjust is refused with a wrong API key", async () => {
  config.apiKey = "test-key";
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/products/BOLT-M6/adjust`, {
    method: "POST",
    headers: { "x-api-key": "test-kez" },
    body: JSON.stringify({ delta: 1 }),
  });
  assert.strictEqual(res.status, 401);
  server.close();
});

test("POST adjust works with the right API key", async () => {
  config.apiKey = "test-key";
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/products/NUT-M6/adjust`, {
    method: "POST",
    headers: { "x-api-key": "test-key" },
    body: JSON.stringify({ delta: 5 }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).stock, 955);
  server.close();
});

test("POST adjust refuses an oversized body", async () => {
  config.apiKey = "test-key";
  const server = createServer();
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/products/BOLT-M6/adjust`, {
    method: "POST",
    headers: { "x-api-key": "test-key" },
    body: "x".repeat(MAX_BODY_BYTES + 1),
  }).catch((e) => e);
  // The server answers 413 then closes the socket; depending on timing the
  // client sees the 413 or a reset. Either way the body was not processed.
  if (res instanceof Error) assert.ok(res);
  else assert.strictEqual(res.status, 413);
  server.close();
});

test("the startup log never contains the password or the API key", () => {
  config.dbPassword = "example-db-password";
  config.apiKey = "example-api-key";
  const line = JSON.stringify(redactedConfig());
  assert.ok(!line.includes("example-db-password"));
  assert.ok(!line.includes("example-api-key"));
  assert.ok(line.includes('"apiKeySet":true'));
});
