import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findGhosttySurface, GhosttyBackend } from "../src/ghostty.ts";
import { ActiveSessionRegistry } from "../src/session-registry.ts";
import { TerminalSessionRouter } from "../src/terminal-session.ts";

const source = { kind: "ghostty", surfaceId: "0xae0f012345678901", ownerPid: 10, ownerStart: "linux:ab12:1000" };
const destination = { ...source, surfaceId: "0xae0f012345678902" };
const owner = { pid: source.ownerPid, started: source.ownerStart };
const running = (parentPid, ttyDevice, started = "linux:ab12:1001") => ({ kind: "running", started, parentPid, ttyDevice });

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-picker-ghostty-unit-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const selected = join(cwd, "selected.jsonl");
	writeFileSync(selected, "{}\n");
	const registry = new ActiveSessionRegistry(join(cwd, "registry"), () => ({ kind: "running", started: "test" }));
	return { registry, selected, options: { cwd, extensionFile: "/tmp/extension.ts" } };
}

test("a Ghostty anchor requires an unchanged tty, ancestor, original child env and process start", () => {
	const chain = new Map([[10, running(1, "0", owner.started)], [11, running(10, "200")], [12, running(11, "200")]]);
	const env = new Map([[11, source.surfaceId], [12, source.surfaceId]]);
	const locate = (expected = { started: "linux:ab12:1001", tty: "/dev/pts/2" }) => findGhosttySurface(12, owner, expected,
		(pid) => chain.get(pid), (pid) => env.get(pid), () => "/dev/pts/2");
	assert.deepEqual(locate(), source);
	assert.equal(locate({ started: "linux:ab12:1" }), undefined);
	assert.equal(locate({ tty: "/dev/pts/3" }), undefined);
	env.set(11, destination.surfaceId);
	assert.equal(locate(), undefined, "copied or stale leaf environment");
	env.set(11, source.surfaceId);
	chain.set(11, running(10, "201"));
	assert.equal(locate(), undefined, "different tty through a multiplexer");
	chain.set(11, running(10, "200"));
	chain.set(10, running(1, "0", "linux:ab12:9001"));
	assert.equal(locate(), undefined, "reused owner PID");
});

test("Ghostty dispatch pins the unique owner and keeps exact uint64 and argv", { skip: process.platform !== "linux" }, () => {
	const calls = [];
	const backend = GhosttyBackend.connect((args) => {
		calls.push(args);
		const method = args[5];
		if (method.endsWith("GetNameOwner")) return "(':1.10',)";
		if (method.endsWith("GetConnectionUnixProcessID")) return "(uint32 10,)";
		if (method.endsWith("Describe")) return `((true, signature '${args[6] === "new-tab" ? "(tas)" : "t"}', @av []),)`;
		return "()";
	}, () => running(1, "0", owner.started));
	assert.throws(() => backend.present({ ...source, ownerStart: "linux:ab12:9999" }), /does not belong/);
	assert.equal(calls.length, 2);
	const argv = ['/tmp/with spaces".jsonl', "$(literal);\nthere", "--flag"];
	backend.newTab(source, argv);
	backend.present(destination);
	assert.deepEqual(calls.slice(2).map((args) => args.slice(0, 4)), Array(4).fill([
		"--dest", ":1.10", "--object-path", "/com/mitchellh/ghostty",
	]));
	assert.equal(calls[3][7], `[<(uint64 ${BigInt(source.surfaceId)}, ${JSON.stringify(["-e", ...argv])})>]`);
	assert.equal(calls[5][7], `[<uint64 ${BigInt(destination.surfaceId)}>]`);
});

test("a live Ghostty target is used before the launch menu; a stale surface never opens a duplicate", async (t) => {
	const { registry, selected, options } = fixture(t);
	registry.register({ state: "working", sessionId: "target", sessionFile: selected, location: destination });
	const presented = [];
	let observed = destination;
	const router = new TerminalSessionRouter(source, registry, () => ({
		locate: (pid, identity) => {
			assert.equal(pid, process.pid);
			assert.deepEqual(identity, { started: "test" });
			return observed;
		},
		present: (location) => presented.push(location),
	}));
	const request = { ...options, selectLaunch: () => assert.fail("already registered") };
	assert.match(await router.open(selected, undefined, request), /Requested the exact Ghostty tab/);
	assert.deepEqual(presented, [destination]);
	observed = source;
	await assert.rejects(router.open(selected, undefined, request), /Could not reverify/);
	assert.deepEqual(presented, [destination]);
});

const tmuxSource = {
	kind: "tmux", socket: "/tmp/mock-tmux", serverPid: 70, sessionId: "$2", windowId: "@5", paneId: "%6", paneTty: "/dev/pts/6",
};
const clients = (tty, pid) => ({ status: 0, stdout: `70\t${tty}\t$2\t@5\t%6\t0\t${pid}\n`, stderr: "" });

test("the launch menu has only the destinations available from the current terminal", async (t) => {
	const { registry, selected, options } = fixture(t);
	const tmux = (socket, [command]) => {
		assert.equal(socket, tmuxSource.socket);
		assert.equal(command, "list-clients");
		return clients("/dev/pts/21", 21);
	};
	const verified = () => ({ locate: (pid, expected) => {
		assert.equal(pid, 21);
		assert.deepEqual(expected, { tty: "/dev/pts/21" });
		return source;
	} });
	for (const [location, connect, choices] of [
		[source, () => assert.fail("no D-Bus call is needed until selection"), ["Ghostty in new tmux", "Ghostty without tmux"]],
		[tmuxSource, verified, ["Ghostty in new tmux", "New tmux window", "Ghostty without tmux"]],
		[tmuxSource, () => { throw new Error("not Ghostty"); }, ["New tmux window"]],
	]) {
		const router = new TerminalSessionRouter(location, registry, connect, tmux);
		await router.open(selected, undefined, { ...options, selectLaunch: async (observed) => assert.deepEqual(observed, choices) });
		const claim = registry.reserveLaunch(selected);
		assert.ok(claim, "cancelling the menu did not reserve the session");
		claim.release();
	}
});

test("a Ghostty-to-tmux jump resolves the outer surface from the selected client's PID and tty", async (t) => {
	const { registry, selected, options } = fixture(t);
	registry.register({ state: "idle", sessionId: "target", sessionFile: selected, location: tmuxSource });
	const locate = (pid, expected) => {
		assert.equal(pid, 21);
		assert.deepEqual(expected, { tty: "/dev/pts/21" });
		return destination;
	};
	const presented = [];
	const tmux = (_socket, [command]) => {
		if (command === "display-message") return { status: 0, stdout: "70\t$2\t@5\t%6\t0\t/dev/pts/6\n" };
		assert.equal(command, "list-clients");
		return clients("/dev/pts/21", 21);
	};
	const router = new TerminalSessionRouter(source, registry, (busPid) => {
		assert.equal(busPid, 21, "choose the bus from the client too, not the invoking Pi");
		return { locate, present: (loc) => presented.push(loc) };
	}, tmux);
	await router.open(selected, undefined, { ...options, selectLaunch: () => assert.fail("already registered") });
	assert.deepEqual(presented, [destination]);
});
