import express from "express";
import cors from "cors";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ---- config ---------------------------------------------------------------
const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // comma-separated allowed
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "events.db");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // optional shared secret

// ---- storage --------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);
`);

const insertStmt = db.prepare(
  "INSERT INTO events (id, type, source, payload, created_at) VALUES (?, ?, ?, ?, ?)",
);
const listStmt = db.prepare(
  "SELECT id, type, source, payload, created_at FROM events ORDER BY datetime(created_at) DESC LIMIT ?",
);
const getStmt = db.prepare(
  "SELECT id, type, source, payload, created_at FROM events WHERE id = ?",
);
const deleteStmt = db.prepare("DELETE FROM events WHERE id = ?");
const clearStmt = db.prepare("DELETE FROM events");

function rowToEvent(row) {
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = { raw: row.payload };
  }
  return {
    id: row.id,
    type: row.type,
    source: row.source ?? null,
    payload,
    createdAt: row.created_at,
  };
}

// ---- app ------------------------------------------------------------------
const app = express();
const allowedOrigins =
  CORS_ORIGIN === "*"
    ? true
    : CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // disabled when no token configured
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "events-backend" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Ingest a new event
app.post("/events", (req, res) => {
  const body = req.body || {};
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : null;
  if (!type) return res.status(400).json({ error: "type is required" });

  const source = typeof body.source === "string" ? body.source : null;
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const event = {
    id: randomUUID(),
    type,
    source,
    payload,
    createdAt: new Date().toISOString(),
  };

  insertStmt.run(event.id, event.type, event.source, JSON.stringify(event.payload), event.createdAt);
  io.to("admin").emit("event:new", event);
  res.status(201).json(event);
});

// List events (newest first)
app.get("/events", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const rows = listStmt.all(limit);
  res.json(rows.map(rowToEvent));
});

app.get("/events/:id", (req, res) => {
  const ev = rowToEvent(getStmt.get(req.params.id));
  if (!ev) return res.status(404).json({ error: "not found" });
  res.json(ev);
});

app.delete("/events/:id", requireAdmin, (req, res) => {
  const info = deleteStmt.run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "not found" });
  io.to("admin").emit("event:deleted", { id: req.params.id });
  res.json({ ok: true });
});

app.delete("/events", requireAdmin, (_req, res) => {
  clearStmt.run();
  io.to("admin").emit("event:cleared", {});
  res.json({ ok: true });
});

// ---- socket.io ------------------------------------------------------------
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: allowedOrigins },
});

io.on("connection", (socket) => {
  socket.on("join", (data) => {
    const role = data && typeof data === "object" ? data.role : null;
    if (role === "admin") socket.join("admin");
  });

  // Optional: allow clients to push events over the socket too.
  socket.on("event:push", (data, ack) => {
    try {
      const type = data?.type;
      if (typeof type !== "string" || !type.trim()) {
        if (typeof ack === "function") ack({ ok: false, error: "type required" });
        return;
      }
      const event = {
        id: randomUUID(),
        type: type.trim(),
        source: typeof data.source === "string" ? data.source : null,
        payload: data.payload && typeof data.payload === "object" ? data.payload : {},
        createdAt: new Date().toISOString(),
      };
      insertStmt.run(event.id, event.type, event.source, JSON.stringify(event.payload), event.createdAt);
      io.to("admin").emit("event:new", event);
      if (typeof ack === "function") ack({ ok: true, event });
    } catch (err) {
      if (typeof ack === "function") ack({ ok: false, error: String(err) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`events-backend listening on :${PORT}`);
});
