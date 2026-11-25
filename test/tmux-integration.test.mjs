import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ActiveSessionRegistry, canonicalSessionFile } from "../src/session-registry.ts";
import { PANE_FORMAT, parseLivePane } from "../src/tmux-location.ts";
import { TmuxBackend } from "../src/tmux-session.ts";

const available = process.platform === "linux" && [ ["tmux", "-V"], ["script", "--version"] ]
	.every(([bin, arg]) => spawnSync(bin, [arg], { timeout: 1_000 }).status === 0);

test("real tmux: exact pane, launch handoff, and default focus mode", {
	skip: !available,
}, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-picker-tmux-"));
	const socket = join(dir, "socket");
	const bin = join(dir, "bin");
	const cwd = join(dir, "source directory #{literal};");
	const registryPath = join(dir, "registry");
	const trace = join(dir, "child.json");
	mkdirSync(bin);
	mkdirSync(cwd);
	const oldPath = process.env.PATH;
	const env = { ...process.env, HOME: dir, TERM: "xterm", PATH: bin + delimiter + oldPath, TEST_SOCKET: socket };
	process.env.PATH = env.PATH; // tmux takes PATH from the new-window command client.
	delete env.TMUX;
	delete env.TMUX_PANE;
	const tmux = (...args) => {
		const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", env, timeout: 3_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trimEnd();
	};
	let attached;
	t.after(async () => {
		spawnSync("tmux", ["-S", socket, "kill-server"], { env, timeout: 2_000 });
		if (attached) {
			attached.kill();
			await new Promise((resolve) => attached.exitCode !== null || attached.signalCode ? resolve() : attached.once("close", resolve));
		}
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	});

	writeFileSync(join(bin, "pi"), `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const tmux = (...args) => spawnSync("tmux", ["-S", ${JSON.stringify(socket)}, ...args], { timeout: 3000 }).status;
const args = process.argv.slice(2);
const file = args[1];
writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, cwd: process.cwd() }));
if (tmux("wait-for", "-S", "child-started") !== 0 || tmux("wait-for", "child-continue") !== 0) process.exit(2);
if (file.endsWith("failed.jsonl")) process.exit(1);
const { ActiveSessionRegistry } = await import(${JSON.stringify(new URL("../src/session-registry.ts", import.meta.url).href)});
const { trackSession } = await import(${JSON.stringify(new URL("../src/track-session.ts", import.meta.url).href)});
const registry = new ActiveSessionRegistry(${JSON.stringify(registryPath)});
const handlers = new Map();
trackSession({ on: (event, fn) => handlers.set(event, fn) }, registry);
const ctx = { mode: "tui", isIdle: () => true, sessionManager: {
  getSessionFile: () => file, getSessionId: () => "fake-child",
} };
handlers.get("session_start")({}, ctx);
if (tmux("wait-for", "-S", "registered") !== 0 || tmux("wait-for", "child-exit") !== 0) process.exit(2);
handlers.get("session_shutdown")({}, ctx);
`, { mode: 0o700 });

	const create = (name) => parseLivePane(socket, tmux("-f", "/dev/null", "new-session", "-d", "-P", "-F", PANE_FORMAT,
		"-s", name, "/bin/sh", "-i"));
	const source = create("source");
	const another = create("target");
	const target = parseLivePane(socket, tmux("split-window", "-d", "-P", "-F", PANE_FORMAT,
		"-t", another.paneId, "/bin/sh", "-i"));
	assert.notEqual(target.paneId, another.paneId);
	tmux("set-option", "-gw", "remain-on-exit", "on");
	tmux("set-hook", "-g", "client-attached", "wait-for -S client-ready");
	tmux("set-hook", "-g", "pane-died", "wait-for -S child-pane-exited");
	attached = spawn("script", ["-qefc", 'exec tmux -S "$TEST_SOCKET" attach -t source', "/dev/null"], {
		env, stdio: ["pipe", "ignore", "ignore"],
	});
	await new Promise((resolve, reject) => { attached.once("spawn", resolve); attached.once("error", reject); });
	tmux("wait-for", "client-ready");
	const view = () => tmux("list-clients", "-F", "#{session_id}:#{window_id}.#{pane_id}");
	const location = (pane) => `${pane.sessionId}:${pane.windowId}.${pane.paneId}`;
	assert.equal(view(), location(source));

	new TmuxBackend(source).focus(target);
	assert.equal(view(), location(target));
	new TmuxBackend(target).focus(source);
	assert.equal(view(), location(source));

	const registry = new ActiveSessionRegistry(registryPath);
	const backend = new TmuxBackend(source);
	const extensionFile = join(dir, "extension unusual path.ts;");
	const launch = (name) => {
		const file = canonicalSessionFile(join(dir, name));
		writeFileSync(file, "{}\n");
		const reservation = registry.reserveLaunch(file);
		backend.launch(file, reservation, { cwd: canonicalSessionFile(cwd), extensionFile });
		try {
			tmux("wait-for", "child-started");
			assert.ok(existsSync(trace), "child did not write its startup trace");
		} catch (error) {
			throw new Error(`${error.message}\n${tmux("capture-pane", "-p", "-S", "-", "-t", "source:pi-session").trim()}`, { cause: error });
		}
		assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
			args: ["--session", file, "--extension", extensionFile], cwd: canonicalSessionFile(cwd),
		});
		assert.ok(existsSync(`${reservation.claim}.running`));
		assert.equal(registry.reserveLaunch(file), undefined);
		return { file, reservation };
	};

	const { file, reservation } = launch("session ' \" $(echo not-a-command).jsonl");
	tmux("wait-for", "-S", "child-continue");
	tmux("wait-for", "registered");
	const [{ pid, sessionFile, location: launched }] = registry.snapshot().active;
	assert.notEqual(pid, process.pid);
	assert.equal(sessionFile, file);
	assert.equal(view(), location(launched));
	assert.equal(existsSync(`${reservation.claim}.running`), false);
	new TmuxBackend(launched).focus(source);
	tmux("wait-for", "-S", "child-exit");
	tmux("wait-for", "child-pane-exited");
	tmux("kill-window", "-t", `${launched.sessionId}:${launched.windowId}`);

	const failed = launch("failed.jsonl");
	tmux("wait-for", "-S", "child-continue");
	tmux("wait-for", "child-pane-exited");
	assert.equal(existsSync(`${failed.reservation.claim}.running`), false);
	assert.notEqual(registry.reserveLaunch(failed.file), undefined);

	const picker = join(bin, "pisessions");
	const check = join(dir, "check-command.mjs");
	const commandResult = join(dir, "command-result.json");
	writeFileSync(picker, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--help") console.log("--select --output");
else writeFileSync(process.argv[4], ${JSON.stringify(JSON.stringify(failed.file))});
`, { mode: 0o700 });
	writeFileSync(check, `
import { writeFileSync } from "node:fs";
import picker from ${JSON.stringify(new URL("../extensions/session-picker.ts", import.meta.url).href)};
process.env.PI_SESSION_PICKER_BIN = ${JSON.stringify(picker)};
let handler;
picker({ on() {}, registerCommand: (_name, command) => { handler = command.handler; } });
const choices = [];
const notices = [];
const switches = [];
let failRouting = false;
const ctx = { mode: "tui", cwd: process.cwd(), waitForIdle: async () => {},
  sessionManager: { getSessionFile: () => undefined },
  switchSession: async (file) => switches.push(file),
  ui: {
    select: async (title, items) => {
      choices.push(items);
      if (failRouting) throw new Error("fixture routing failure");
    },
    notify: (message) => notices.push(message),
    custom: (factory) => new Promise((resolve, reject) => {
      factory({ stop() {}, start() {}, requestRender() {}, terminal: { async drainInput() {}, write() {} } }, null, null, resolve).catch(reject);
    }),
  },
};
await handler("", ctx);
failRouting = true;
await handler("", ctx);
failRouting = false;
await handler("native", ctx);
writeFileSync(${JSON.stringify(commandResult)}, JSON.stringify({ choices, notices, switches }));
`);
	const checkPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "check-command", "-t", `${source.sessionId}:`,
		"--", process.execPath, check);
	tmux("wait-for", "child-pane-exited");
	assert.equal(tmux("display-message", "-p", "-t", checkPane, "#{pane_dead_status}"), "0",
		tmux("capture-pane", "-p", "-S", "-", "-t", checkPane));
	const command = JSON.parse(readFileSync(commandResult, "utf8"));
	assert.deepEqual(command.choices, [["New tmux window"], ["New tmux window"], ["Keep current session", "Switch in place"]]);
	assert.deepEqual(command.notices, ["Session picker: fixture routing failure"]);
	assert.deepEqual(command.switches, []);
});
