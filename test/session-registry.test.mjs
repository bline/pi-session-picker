import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProcess } from "../src/process-identity.ts";
import { ActiveSessionRegistry, canonicalSessionFile } from "../src/session-registry.ts";
import { isTmuxLocation } from "../src/tmux-location.ts";
import { trackSession } from "../src/track-session.ts";

const tmux = {
	kind: "tmux",
	socket: "/tmp/tmux,example",
	serverPid: 42,
	sessionId: "$2",
	windowId: "@3",
	paneId: "%7",
};

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-registry-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const directory = join(dir, "registry");
	let identity = { kind: "running", started: "start-1" };
	const registry = new ActiveSessionRegistry(directory, () => identity);
	const sessionFile = join(realpathSync(dir), "session.jsonl");
	return {
		dir, registry, sessionFile, directory,
		setIdentity: (status) => { identity = status; },
		register: (details = {}) => registry.register({
			sessionId: "session-1", sessionFile, state: "idle", ...details,
		}),
	};
}

test("uses the real JSONL path, including a session Pi hasn't flushed", (t) => {
	const { dir, sessionFile } = fixture(t);
	const alias = join(dir, "alias");
	symlinkSync(dir, alias, "dir");
	assert.equal(canonicalSessionFile(join(alias, "session.jsonl")), sessionFile);
	assert.throws(() => canonicalSessionFile(join(dir, "missing", "session.jsonl")), /ENOENT/);
	writeFileSync(sessionFile, "");
	const link = join(dir, "link.jsonl");
	symlinkSync(sessionFile, link);
	assert.equal(canonicalSessionFile(link), sessionFile);
});

test("writes a private record with process identity and location, then removes it", (t) => {
	const { register, registry, directory, sessionFile } = fixture(t);
	assert.deepEqual(registry.snapshot(), { active: [], stale: [], unverified: [] });
	const lease = register({ location: tmux });
	const [{ pid, processStart, state, location, sessionId, sessionFile: path }] = registry.snapshot().active;
	assert.equal(path, sessionFile);
	assert.equal(sessionId, "session-1");
	assert.equal(pid, process.pid);
	assert.equal(processStart, "start-1");
	assert.equal(state, "idle");
	assert.deepEqual(location, tmux);
	assert.equal(lstatSync(directory).mode & 0o777, 0o700);
	const [name] = readdirSync(directory);
	assert.equal(lstatSync(join(directory, name)).mode & 0o777, 0o600);

	lease.setState("working");
	assert.deepEqual(readdirSync(directory), [name]);
	assert.equal(registry.snapshot().active[0].state, "working");
	lease.close();
	lease.setState("waiting");
	lease.close();
	assert.deepEqual(readdirSync(directory), []);
});

test("closing one registration cannot remove another for the same file or PID", (t) => {
	const { register, registry } = fixture(t);
	const first = register();
	const second = register();
	assert.equal(registry.snapshot().active.length, 2);
	first.close();
	assert.equal(registry.snapshot().active.length, 1);
	second.close();
	assert.deepEqual(registry.snapshot().active, []);
});

test("distinguishes a live process, a reused PID, and an unverifiable process", (t) => {
	const { register, registry, setIdentity } = fixture(t);
	register();
	assert.equal(registry.snapshot().active.length, 1);
	setIdentity({ kind: "running", started: "start-2" });
	assert.equal(registry.snapshot().stale.length, 1);
	assert.deepEqual(registry.snapshot().active, []);
	setIdentity({ kind: "exited" });
	assert.equal(registry.snapshot().stale.length, 1);
	setIdentity({ kind: "unknown" });
	const { active, stale, unverified } = registry.snapshot();
	assert.deepEqual(active, []);
	assert.deepEqual(stale, []);
	assert.equal(unverified[0].record.sessionId, "session-1");
});

test("unverified registry data is surfaced, not treated as proof of absence", (t) => {
	const { registry, directory, register } = fixture(t);
	register();
	const [name] = readdirSync(directory);
	const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
	writeFileSync(join(directory, "bad.json"), "{", { mode: 0o600 });
	writeFileSync(join(directory, "foreign.json"), JSON.stringify({ ...record, host: `${record.host}.other` }), {
		mode: 0o600,
	});
	writeFileSync(join(directory, ".write-in-progress.tmp"), "{", { mode: 0o600 });
	const { active, stale, unverified } = registry.snapshot();
	assert.equal(active.length, 1);
	assert.equal(stale.length, 0);
	assert.deepEqual(unverified.map(({ file }) => file).sort(), ["bad.json", "foreign.json"].map((p) => join(directory, p)));
});

test("only a valid, scoped tmux locator can round-trip in a record", () => {
	assert.equal(isTmuxLocation(tmux), true);
	for (const entry of [
		{ ...tmux, paneId: "9" },
		{ ...tmux, windowId: "reviewer" },
		{ ...tmux, sessionId: "main" },
		{ ...tmux, socket: "tmux,example" },
		{ ...tmux, serverPid: 0 },
	]) assert.equal(isTmuxLocation(entry), false);
});

test("observes the current real process's stable start identity", {
	skip: !["linux", "darwin"].includes(process.platform),
}, () => {
	const observed = inspectProcess(process.pid);
	assert.equal(observed.kind, "running");
	assert.deepEqual(inspectProcess(process.pid), observed);
	assert.deepEqual(inspectProcess(0), { kind: "unknown" });
});

test("tracks waiting and settled states independently and replaces the session record", (t) => {
	const { registry, sessionFile, dir } = fixture(t);
	const handlers = new Map();
	trackSession({ on: (event, fn) => handlers.set(event, fn) }, registry, () => tmux);
	let idle = true;
	let file = sessionFile;
	let id = "original";
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		sessionManager: { getSessionFile: () => file, getSessionId: () => id },
	};
	const fire = (event) => handlers.get(event)({}, ctx);
	const entry = () => {
		const { active } = registry.snapshot();
		assert.equal(active.length, 1);
		return active[0];
	};
	fire("session_start");
	assert.equal(entry().state, "idle");
	assert.deepEqual(entry().location, tmux);

	idle = false;
	fire("before_agent_start");
	assert.equal(entry().state, "working");
	fire("ui_prompt_start");
	fire("agent_start");
	assert.equal(entry().state, "waiting");
	fire("ui_prompt_end");
	assert.equal(entry().state, "working");
	assert.equal(handlers.has("agent_end"), false, "a low-level end is not final idle");
	idle = true;
	fire("agent_settled");
	assert.equal(entry().state, "idle");

	fire("session_shutdown");
	assert.deepEqual(registry.snapshot().active, []);
	file = join(realpathSync(dir), "replacement.jsonl");
	id = "replacement";
	fire("session_start");
	assert.equal(entry().sessionId, "replacement");
	assert.equal(entry().sessionFile, file);
	fire("session_shutdown");
	assert.deepEqual(registry.snapshot().active, []);
});

test("registers file-backed non-TUI sessions without a pane and skips in-memory sessions", (t) => {
	const { registry, sessionFile } = fixture(t);
	const handlers = new Map();
	trackSession({ on: (event, fn) => handlers.set(event, fn) }, registry, () => {
		assert.fail("non-TUI processes do not own a focusable pane");
	});
	let file = sessionFile;
	const ctx = {
		mode: "rpc",
		isIdle: () => true,
		sessionManager: { getSessionFile: () => file, getSessionId: () => "rpc-session" },
	};
	handlers.get("session_start")({}, ctx);
	assert.equal(registry.snapshot().active.length, 1);
	assert.equal(registry.snapshot().active[0].location, undefined);
	handlers.get("session_shutdown")({}, ctx);
	file = undefined;
	handlers.get("session_start")({}, ctx);
	assert.deepEqual(registry.snapshot().active, []);
});
