import { basename } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const MEMPALACE_BIN = process.env.MEMPALACE_BIN ?? "mempalace";
const debounceMs = 3000;

const timers = new Map();
const inFlight = new Set();

export default async function plugin(ctx) {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle" && event.type !== "session.compacted") {
        return;
      }
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;

      if (timers.has(sessionID)) {
        clearTimeout(timers.get(sessionID));
      }
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID);
          void capture(ctx, sessionID).catch((err) => {
            process.stderr.write(`[mempalace-memory] capture error: ${err}\n`);
          });
        }, debounceMs),
      );
    },
  };
}

function serializePart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "reasoning") {
    const reasoning = part.text ?? part.thinking ?? "";
    return reasoning ? `[reasoning]\n${reasoning}` : null;
  }
  if (part.type === "tool" || part.type === "tool_use") {
    const name = part.name ?? part.tool ?? "tool";
    const input = part.state?.input ?? part.input ?? part.arguments;
    const output = part.state?.output ?? part.output ?? part.result;
    const segments = [`[tool:${name}]`];
    if (input !== undefined) {
      try {
        segments.push(`input: ${JSON.stringify(input)}`);
      } catch {
        segments.push(`input: ${String(input)}`);
      }
    }
    if (output !== undefined) {
      const out = typeof output === "string" ? output : JSON.stringify(output);
      segments.push(`output: ${out}`);
    }
    return segments.join("\n");
  }
  if (part.type === "tool_result") {
    const content =
      typeof part.content === "string"
        ? part.content
        : JSON.stringify(part.content ?? part.output ?? "");
    return `[tool_result]\n${content}`;
  }
  if (part.type === "file") {
    const filename = part.filename ?? part.path ?? "file";
    return `[file:${filename}]`;
  }
  return null;
}

async function capture(ctx, sessionID) {
  if (inFlight.has(sessionID)) return;
  inFlight.add(sessionID);
  try {
    const res = await ctx.client.session.messages({
      path: { id: sessionID },
    });
    const messages = (res.data ?? []).flatMap(({ info, parts }) =>
      (parts ?? [])
        .map(serializePart)
        .filter((text) => typeof text === "string" && text.length > 0)
        .map((text) => ({ role: info.role, text })),
    );
    if (messages.length === 0) return;

    const dir = `${tmpdir()}/mempalace-opencode/${sessionID}`;
    mkdirSync(dir, { recursive: true });

    const cwd = ctx.directory ?? "";
    const lines = messages
      .map(({ role, text }) =>
        JSON.stringify({
          type: role,
          message: { role, content: text },
          cwd,
        }),
      )
      .join("\n");

    if (!lines || lines.length < 100) return;

    // Per-fire filename: every capture produces a NEW file inside the
    // session directory. mempalace mine deduplicates by source_file path
    // (miner.py:842, convo_miner.py:436), so reusing one path means only
    // the first fire ever lands drawers. Timestamping the filename keeps
    // each snapshot independent.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`${dir}/session-${stamp}.jsonl`, lines + "\n", "utf8");

    const wing = (basename(cwd) || "sessions")
      .toLowerCase()
      .replace(/ /g, "_")
      .replace(/-/g, "_");
    const proc = spawn(
      MEMPALACE_BIN,
      ["mine", dir, "--mode", "convos", "--wing", wing, "--agent", "opencode"],
      { stdio: "ignore", detached: true },
    );
    proc.unref();
    proc.on("close", () => inFlight.delete(sessionID));
    proc.on("error", (err) => {
      inFlight.delete(sessionID);
      process.stderr.write(`[mempalace-memory] mine error: ${err}\n`);
    });
    return;
  } catch (err) {
    process.stderr.write(`[mempalace-memory] capture error: ${err}\n`);
  }
  inFlight.delete(sessionID);
}
