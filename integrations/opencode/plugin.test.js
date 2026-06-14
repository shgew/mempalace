import { describe, it, expect, mock, beforeEach } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnCalls = [];
let hangNextSpawn = false;

mock.module("node:child_process", () => ({
  spawn: (_cmd, args, _opts) => {
    spawnCalls.push([...(args ?? [])]);
    const shouldHang = hangNextSpawn;
    return {
      unref: () => {},
      on: (event, cb) => {
        if (event === "close" && !shouldHang) {
          setTimeout(() => cb(0), 20);
        }
      },
    };
  },
}));

process.env.MEMPALACE_BIN = "fake-mempalace";

const { default: plugin } = await import("./plugin.js");

const makeMessages = (n = 20) =>
  Array.from({ length: n }, (_, i) => ({
    info: { role: i % 2 === 0 ? "user" : "assistant" },
    parts: [
      {
        type: "text",
        text: `message ${i} about the test project for mempalace capture`,
      },
    ],
  }));

const makeCtx = (dir = "/tmp/opencode-test/my-project") => ({
  client: { session: { messages: async () => ({ data: makeMessages() }) } },
  directory: dir,
  worktree: dir,
  serverUrl: new URL("http://localhost:3000"),
});

describe("mempalace-memory capture plugin", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    hangNextSpawn = false;
  });

  it("exports only the event hook (no inject hooks)", async () => {
    const hooks = await plugin(makeCtx());
    expect(typeof hooks.event).toBe("function");
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined();
    expect(hooks["chat.message"]).toBeUndefined();
  });

  it("fires mine after session.idle debounce with correct args", async () => {
    const hooks = await plugin(makeCtx("/home/user/projects/cool-app"));
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-idle-1" } },
    });
    await new Promise((r) => setTimeout(r, 3500));

    expect(spawnCalls.length).toBe(1);
    const args = spawnCalls[0];
    expect(args).toContain("mine");
    expect(args).toContain("--mode");
    expect(args).toContain("convos");
    expect(args).toContain("--wing");
    expect(args).toContain("cool_app");
    expect(args).toContain("--agent");
    expect(args).toContain("opencode");

    const sessionDir = join(tmpdir(), "mempalace-opencode", "s-idle-1");
    expect(existsSync(sessionDir)).toBe(true);
    const snapshots = readdirSync(sessionDir).filter((f) =>
      /^session-.*\.jsonl$/.test(f),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    const content = readFileSync(join(sessionDir, snapshots[0]), "utf8");
    expect(content.length).toBeGreaterThan(100);
    const firstLine = JSON.parse(content.split("\n")[0]);
    expect(firstLine.type).toMatch(/user|assistant/);
    expect(firstLine.cwd).toBe("/home/user/projects/cool-app");
    expect(firstLine.message.role).toMatch(/user|assistant/);
    expect(typeof firstLine.message.content).toBe("string");
  }, 10_000);

  it("normalizes wing name to match mempalace normalize_wing_name (lower, space/hyphen to _)", async () => {
    const hooks = await plugin(makeCtx("/home/user/Mixed Case-Name"));
    await hooks.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "s-normalize-1" },
      },
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(spawnCalls.length).toBe(1);
    const wingIdx = spawnCalls[0].indexOf("--wing");
    expect(wingIdx).toBeGreaterThanOrEqual(0);
    expect(spawnCalls[0][wingIdx + 1]).toBe("mixed_case_name");
  }, 10_000);

  it("fires on session.compacted too", async () => {
    const hooks = await plugin(makeCtx("/tmp/proj/alpha"));
    await hooks.event({
      event: {
        type: "session.compacted",
        properties: { sessionID: "s-compact-1" },
      },
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]).toContain("mine");
  }, 10_000);

  it("drops second capture when mine is in-flight", async () => {
    hangNextSpawn = true;
    const hooks = await plugin(makeCtx());
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-drop-1" } },
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(spawnCalls.length).toBe(1);

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-drop-1" } },
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(spawnCalls.length).toBe(1);
  }, 20_000);

  it("fails open when messages rejects", async () => {
    const ctx = {
      ...makeCtx(),
      client: {
        session: {
          messages: async () => {
            throw new Error("network failure");
          },
        },
      },
    };
    const hooks = await plugin(ctx);
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s-fail-1" } },
    });
    await expect(
      new Promise((r) => setTimeout(r, 3500)),
    ).resolves.toBeUndefined();
  }, 10_000);

  it("ignores unrelated events without scheduling a capture", async () => {
    const hooks = await plugin(makeCtx());
    await hooks.event({
      event: {
        type: "session.updated",
        properties: { sessionID: "s-ignore-1" },
      },
    });
    await new Promise((r) => setTimeout(r, 3500));
    expect(spawnCalls.length).toBe(0);
  }, 10_000);
});
