import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActiveSessionRegistry, canonicalSessionFile, LAUNCH_TOKEN_ENV } from "../src/session-registry.ts";
import { openTmuxSession, TmuxBackend } from "../src/tmux-session.ts";
import { trackSession } from "../src/track-session.ts";

const source = {
	kind: "tmux", socket: "/tmp/tmux,example", serverPid: 42,
	sessionId: "$0", windowId: "@1", paneId: "%2", paneTty: "/dev/pts/2",
};
const target = { ...source, sessionId: "$1", windowId: "@5", paneId: "%6", paneTty: "/dev/pts/6" };

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tmux-unit-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	let identity = { kind: "running", started: "test" };
	const directory = join(cwd, "registry");
	const registry = new ActiveSessionRegistry(directory, () => identity);
	const selected = canonicalSessionFile(join(cwd, "selected.jsonl"));
	writeFileSync(selected, "{}\n");
	const actions = [];
	const open = (options = {}, current) => openTmuxSession(selected, current, registry, {
		focus: (location) => actions.push(["focus", location]),
		launch: (file, reservation) => actions.push(["launch", file, reservation]),
	}, {
		cwd, extensionFile: "/test/extension.ts", confirmLaunch: async () => { actions.push(["confirm"]); return true; },
		...options,
	});
	const register = (location, sessionFile = selected) => registry.register({ sessionId: "test", sessionFile, location, state: "working" });
	return { actions, cwd, open, register, registry, selected, setIdentity: (value) => { identity = value; } };
}

test("a canonical alias of the current session does nothing", async (t) => {
	const { cwd, open, selected, actions } = fixture(t);
	const alias = join(cwd, "alias.jsonl");
	symlinkSync(selected, alias);
	await open({}, alias);
	assert.deepEqual(actions, []);
});

test("focuses a live target even when it is working, cancel needs no reservation", async (t) => {
	const { open, register, registry, selected, actions } = fixture(t);
	const active = register(target);
	await open();
	assert.deepEqual(actions, [["focus", target]]);
	active.close();
	await open({ confirmLaunch: async () => false });
	assert.deepEqual(actions, [["focus", target]]);
	assert.ok(registry.reserveLaunch(selected));
});

test("never offers a launch for an unknown pid, ambiguous live target, or non-tmux Pi", async (t) => {
	const { open, register, setIdentity, actions } = fixture(t);
	const one = register(undefined);
	await assert.rejects(open(), /already running.*without a verified tmux pane/);
	const two = register(target);
	await assert.rejects(open(), /Multiple Pi processes/);
	two.close();
	setIdentity({ kind: "unknown" });
	await assert.rejects(open(), /cannot verify/);
	assert.deepEqual(actions, []);
	one.close();
});

test("an opaque registry record blocks a launch even when no target can be read from it", async (t) => {
	const { open, register, registry, actions } = fixture(t);
	register(target).close();
	writeFileSync(join(registry.directory, "corrupt.json"), "{", { mode: 0o600 });
	await assert.rejects(open(), /cannot verify/);
	assert.deepEqual(actions, []);
});

test("rechecks after confirmation and releases the claim if a target appeared", async (t) => {
	const { open, register, registry, selected, actions } = fixture(t);
	await open({ confirmLaunch: async () => { register(target); return true; } });
	assert.deepEqual(actions, [["focus", target]]);
	assert.ok(registry.reserveLaunch(selected));
});

test("concurrent requests share one reservation until the child has published registration", async (t) => {
	const { open, registry, selected, cwd, actions } = fixture(t);
	const results = await Promise.allSettled([open(), open()]);
	assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "rejected"]);
	assert.match(results[1].reason.message, /already reserved/);
	assert.deepEqual(actions.map(([name]) => name), ["confirm", "confirm", "launch"]);
	const [, file, held] = actions[2];
	assert.equal(file, selected);
	assert.ok(existsSync(held.claim));
	assert.equal(registry.reserveLaunch(selected), undefined);
	const running = `${held.claim}.running`;
	renameSync(held.claim, running);
	held.release(); // Only the launcher or child can release a running claim.
	assert.ok(existsSync(running));
	assert.equal(registry.reserveLaunch(selected), undefined);

	const handlers = new Map();
	trackSession({ on: (event, fn) => handlers.set(event, fn) }, registry, () => target);
	const ctx = (path) => ({
		mode: "tui", isIdle: () => true,
		sessionManager: { getSessionFile: () => path, getSessionId: () => "child" },
	});
	const previous = process.env[LAUNCH_TOKEN_ENV];
	t.after(() => {
		if (previous === undefined) delete process.env[LAUNCH_TOKEN_ENV];
		else process.env[LAUNCH_TOKEN_ENV] = previous;
	});
	process.env[LAUNCH_TOKEN_ENV] = held.token;
	handlers.get("session_start")({}, ctx(join(cwd, "other.jsonl")));
	assert.ok(existsSync(running));
	assert.equal(process.env[LAUNCH_TOKEN_ENV], undefined);

	process.env[LAUNCH_TOKEN_ENV] = held.token;
	handlers.get("session_start")({}, ctx(selected));
	assert.equal(registry.snapshot().active[0].sessionFile, selected);
	assert.equal(existsSync(running), false);
	await open();
	assert.deepEqual(actions.at(-1), ["focus", target]);

	const newer = registry.reserveLaunch(selected);
	held.release();
	assert.ok(existsSync(newer.claim), "a late exit cannot remove a new launch's claim");
});

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const paneLine = (p, dead = "0") => [p.serverPid, p.sessionId, p.windowId, p.paneId, dead, p.paneTty].join("\t") + "\n";
const clientLine = (tty) => `${source.serverPid}\t${tty}\t${source.sessionId}\t${source.windowId}\t${source.paneId}\t0\t999\n`;

test("refuses foreign server, dead pane, wrong tty, and ambiguous client without side effects", () => {
	for (const [entry, observed, clients, error] of [
		[{ ...target, serverPid: 43 }, paneLine(target), "", /another tmux server/],
		[target, paneLine(target, "1"), "", /Could not verify/],
		[target, paneLine({ ...target, paneTty: "/dev/pts/9" }), "", /Could not verify/],
		[target, paneLine(target), "", /No writable tmux client/],
		[target, paneLine(target), clientLine("/dev/pts/10") + clientLine("/dev/pts/11"), /Multiple tmux clients/],
	]) {
		const backend = new TmuxBackend(source, (_socket, [cmd]) => {
			if (cmd === "display-message") return ok(observed);
			if (cmd === "list-clients") return ok(clients);
			assert.fail(`unsafe side effect: ${cmd}`);
		});
		assert.throws(() => backend.focus(entry), error);
	}
});

test("failed tmux command releases claim, but an uncertain receipt does not", (t) => {
	const { cwd, registry, selected } = fixture(t);
	for (const [response, released, error] of [
		[{ status: 1, stderr: "can't create window" }, true, /can't create/],
		[{ status: null, error: { code: "ETIMEDOUT" } }, false, /reservation kept/],
		[ok("malformed"), false, /reservation kept/],
	]) {
		const backend = new TmuxBackend(source, (_socket, [cmd]) => {
			if (cmd === "list-clients") return ok(clientLine("/dev/pts/10"));
			assert.equal(cmd, "new-window");
			return response;
		});
		const reservation = registry.reserveLaunch(selected);
		assert.throws(() => backend.launch(selected, reservation, { cwd, extensionFile: "/test/extension.ts" }), error);
		assert.equal(existsSync(reservation.claim), !released);
		reservation.release();
	}
});
