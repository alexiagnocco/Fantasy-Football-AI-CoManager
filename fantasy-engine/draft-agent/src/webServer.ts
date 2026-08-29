#!/usr/bin/env node
/**
 * Local draft-day web UI server. Fully offline: serves the static frontend,
 * the bulk-loaded snapshot, and the manual draft state, and computes pick
 * recommendations with the same engine the MCP tools use.
 *
 * Usage: npm run web   (default http://localhost:3210)
 */
import "./env.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRecommendation } from "./lib/recommend.js";
import { buildManualDraftContext } from "./manualContext.js";
import {
  ManualState,
  loadManualState,
  loadSnapshot,
  saveManualState,
  slotForOverallPick,
  STATE_PATH,
} from "./manualSession.js";
import { availabilityAtPick } from "./lib/strategy.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const PORT = Number(process.env.DRAFT_WEB_PORT || 3210);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Full payload the UI renders from: state + board + recommendation. */
function uiPayload() {
  const snapshot = loadSnapshot();
  if (!snapshot) {
    return { error: "No snapshot. Run `npm run snapshot` (with network + ESPN cookies) before draft day." };
  }
  const manual = loadManualState();
  if (!manual) {
    return { needsSetup: true, config: snapshot.config, totalRounds: snapshot.totalRounds, snapshotCreatedAt: snapshot.createdAt };
  }
  const ctx = buildManualDraftContext(snapshot, manual);
  const rec = ctx.state.completed ? null : buildRecommendation(ctx, 8);
  return {
    manual,
    config: ctx.state.config,
    snapshotCreatedAt: snapshot.createdAt,
    state: {
      currentOverallPick: ctx.state.currentOverallPick,
      currentRound: ctx.state.currentRound,
      totalRounds: ctx.state.totalRounds,
      totalPicks: ctx.state.totalPicks,
      completed: ctx.state.completed,
      onTheClockSlot: ctx.state.onTheClockTeamId,
      onTheClockName: ctx.state.onTheClockTeamName,
      myTurn: ctx.state.onTheClockTeamId === manual.mySlot,
      myUpcomingPicks: ctx.myPicks.filter((p) => p >= ctx.state.currentOverallPick).slice(0, 4),
    },
    myRoster: ctx.myPlayers,
    recentPicks: ctx.state.picks.slice(-12).reverse(),
    available: ctx.available.slice(0, 250).map((p) => ({
      ...p,
      availability: availabilityAtPick(p.adp, ctx.myNextPick === ctx.state.currentOverallPick ? ctx.myFollowingPick : ctx.myNextPick),
    })),
    recommendation: rec,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(WEB_DIR, "index.html")));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/board") {
      json(res, 200, uiPayload());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/setup") {
      const body = await readBody(req);
      const teamCount = Number(body.teamCount);
      const totalRounds = Number(body.totalRounds);
      const mySlot = Number(body.mySlot);
      if (!(teamCount >= 2 && teamCount <= 20) || !(totalRounds >= 1 && totalRounds <= 30) || !(mySlot >= 1 && mySlot <= teamCount)) {
        json(res, 400, { error: "Invalid setup: need 2-20 teams, 1-30 rounds, and your slot within team count." });
        return;
      }
      const state: ManualState = { active: true, teamCount, totalRounds, mySlot, pickedPlayerIds: [] };
      saveManualState(state);
      json(res, 200, uiPayload());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/pick") {
      const body = await readBody(req);
      const playerId = Number(body.playerId);
      const manual = loadManualState();
      const snapshot = loadSnapshot();
      if (!manual || !snapshot) {
        json(res, 400, { error: "No active draft session." });
        return;
      }
      if (!snapshot.players.some((p) => p.id === playerId)) {
        json(res, 400, { error: `Unknown player id ${playerId}.` });
        return;
      }
      if (manual.pickedPlayerIds.includes(playerId)) {
        json(res, 400, { error: "Player already drafted." });
        return;
      }
      manual.pickedPlayerIds.push(playerId);
      saveManualState(manual);
      json(res, 200, uiPayload());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/undo") {
      const manual = loadManualState();
      if (manual && manual.pickedPlayerIds.length > 0) {
        manual.pickedPlayerIds.pop();
        saveManualState(manual);
      }
      json(res, 200, uiPayload());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      const manual = loadManualState();
      if (manual) {
        saveManualState({ ...manual, active: false });
      }
      json(res, 200, uiPayload());
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  const snap = existsSync(STATE_PATH) ? "existing session found" : "fresh session";
  console.log(`Draft board: http://localhost:${PORT}  (${snap})`);
  console.log("Claude Desktop's MCP tools read the same state - both stay in sync.");
});

// Re-export so tsc treats this as a module even if imports change.
export { slotForOverallPick };
