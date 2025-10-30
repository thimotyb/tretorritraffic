import http from "http";
import { collectSamples } from "../src/poller.js";

const PORT = Number(process.env.POLL_SERVER_PORT ?? 4000);
let isPolling = false;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && req.url === "/poll") {
    if (isPolling) {
      sendJson(res, 409, { success: false, message: "A poll is already in progress." });
      return;
    }

    isPolling = true;
    const startedAt = new Date().toISOString();

    try {
      const { samples } = await collectSamples({ logProgress: false, logErrors: true });
      sendJson(res, 200, {
        success: true,
        count: samples.length,
        startedAt,
        completedAt: new Date().toISOString()
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      isPolling = false;
    }
    return;
  }

  sendJson(res, 404, { success: false, message: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Poll control server listening on http://localhost:${PORT}`);
});
