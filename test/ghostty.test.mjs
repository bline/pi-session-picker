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
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const clients = (tty, pid, pane = tmuxSource, readOnly = 0) =>
	ok(`${pane.serverPid}\t${tty}\t${pane.sessionId}\t${pane.windowId}\t${pane.paneId}\t${readOnly}\t${pid}\n`);
const paneLine = (p) => ok(`${p.serverPid}\t${p.sessionId}\t${p.windowId}\t${p.paneId}\t0\t${p.paneTty}\n`);
const existingTmux = "New window in an existing tmux session…";
const workspaces = "70\t$0\t8\t1\twork-engine\n70\t$2\t4\t1\tresearch\n70\t$3\t1\t0\texperiments\n";
const detachedPane = { ...tmuxSource, sessionId: "$3", windowId: "@7", paneId: "%8", paneTty: "/dev/pts/8" };
const launchedPane = { ...tmuxSource, windowId: "@12", paneId: "%12", paneTty: "/dev/pts/12" };

test("the launch menu has only the destinations available from the current terminal", async (t) => {
	const { registry, selected, options } = fixture(t);
	const tmux = (socket, [command]) => {
		if (socket === undefined) {
			assert.equal(command, "display-message");
			return { status: 1, stderr: "no server" };
		}
		assert.equal(socket, tmuxSource.socket);
		if (command === "list-sessions") return ok("70\t$2\t4\t1\tresearch\n");
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
		[tmuxSource, verified, ["Ghostty in new tmux", "New tmux window — research", "Ghostty without tmux"]],
		[tmuxSource, () => { throw new Error("not Ghostty"); }, ["New tmux window — research"]],
	]) {
		const router = new TerminalSessionRouter(location, registry, connect, tmux);
		await router.open(selected, undefined, {
			...options, selectLaunch: async (observed) => assert.deepEqual(observed, choices),
			selectTmuxWorkspace: () => assert.fail("no other workspace"),
		});
		const claim = registry.reserveLaunch(selected);
		assert.ok(claim, "cancelling the menu did not reserve the session");
		claim.release();
	}
});

test("a direct Ghostty tab lists even one workspace; Escape goes back without reserving", async (t) => {
	const { registry, selected, options } = fixture(t);
	const menus = [];
	const router = new TerminalSessionRouter(source, registry, () => assert.fail("cancelled before launch"), (socket, [command]) => {
		if (socket === undefined) return ok(`70\t${tmuxSource.socket}\n`);
		assert.equal(socket, tmuxSource.socket);
		assert.equal(command, "list-sessions");
		return ok("70\t$3\t1\t0\texperiments\n");
	});
	await router.open(selected, undefined, {
		...options,
		selectLaunch: async (items) => {
			menus.push(items);
			return menus.length === 1 ? existingTmux : undefined;
		},
		selectTmuxWorkspace: async (items) => { menus.push(items); },
	});
	assert.deepEqual(menus, [
		["Ghostty in new tmux", existingTmux, "Ghostty without tmux"],
		["experiments · 1 window · Detached"],
		["Ghostty in new tmux", existingTmux, "Ghostty without tmux"],
	]);
	const claim = registry.reserveLaunch(selected);
	assert.ok(claim);
	claim.release();
});

function openWorkspace(router, selected, options, name) {
	return router.open(selected, undefined, {
		...options,
		selectLaunch: async (items) => {
			assert.deepEqual(items, ["Ghostty in new tmux", existingTmux, "Ghostty without tmux"]);
			return existingTmux;
		},
		selectTmuxWorkspace: async (items) => {
			assert.deepEqual(items, ["work-engine · 8 windows · Attached", "research · 4 windows · Attached", "experiments · 1 window · Detached"]);
			return items.find((item) => item.startsWith(name));
		},
	});
}

test("from direct Ghostty, a new window in an attached workspace reuses only its exact Ghostty tab", async (t) => {
	const { registry, selected, options } = fixture(t);
	const effects = [];
	let switched = false;
	const tmux = (socket, [command, ...args]) => {
		if (socket === undefined) return ok(`70\t${tmuxSource.socket}\n`);
		assert.equal(socket, tmuxSource.socket);
		if (command === "list-sessions") return ok(workspaces);
		if (command === "display-message") {
			if (args[2] === "$2:") return ok("70\t$2\n");
			assert.equal(args[2], "$2:@12.%12");
			return paneLine(launchedPane);
		}
		if (command === "new-window") {
			assert.equal(args[args.indexOf("-t") + 1], "$2:");
			assert.ok(args.includes("-d"));
			assert.ok(args.includes(selected));
			effects.push("new window");
			return paneLine(launchedPane);
		}
		if (command === "switch-client") {
			assert.deepEqual(args, ["-E", "-c", "/dev/pts/21", "-t", "$2:@12.%12"]);
			switched = true;
			effects.push("switch target client");
			return ok();
		}
		assert.equal(command, "list-clients");
		return ok(clients("/dev/pts/20", 20, { ...tmuxSource, sessionId: "$0" }).stdout
			+ clients("/dev/pts/21", 21, switched ? launchedPane : tmuxSource).stdout);
	};
	const router = new TerminalSessionRouter(source, registry, (pid) => {
		assert.equal(pid, 21);
		return {
			locate: (leaf, expected) => {
				assert.equal(leaf, 21);
				assert.deepEqual(expected, { tty: "/dev/pts/21" });
				return destination;
			},
			present: (loc) => { assert.deepEqual(loc, destination); effects.push("present target tab"); },
			newTab: () => assert.fail("existing tab should be reused"),
		};
	}, tmux);
	assert.match(await openWorkspace(router, selected, options, "research"), /Requested the exact Ghostty tab/);
	assert.deepEqual(effects, ["new window", "switch target client", "present target tab"]);
});

test("from direct Ghostty, a detached workspace gets one new tab attached to the new pane", async (t) => {
	const { registry, selected, options } = fixture(t);
	const effects = [];
	let attached = false;
	const tmux = (socket, [command, ...args]) => {
		if (socket === undefined) return ok(`70\t${tmuxSource.socket}\n`);
		assert.equal(socket, tmuxSource.socket);
		if (command === "list-sessions") return ok(workspaces);
		if (command === "display-message") return args[2] === "$3:" ? ok("70\t$3\n") : paneLine(detachedPane);
		if (command === "new-window") {
			assert.equal(args[args.indexOf("-t") + 1], "$3:");
			effects.push("new window");
			return paneLine(detachedPane);
		}
		assert.equal(command, "list-clients", "no existing client should be switched");
		return attached ? clients("/dev/pts/22", 22, detachedPane) : ok();
	};
	const router = new TerminalSessionRouter(source, registry, (pid) => {
		assert.equal(pid, process.pid);
		return {
			locate: (leaf) => leaf === process.pid ? source : leaf === 22 ? destination : undefined,
			newTab: (loc, argv) => {
				assert.deepEqual(loc, source);
				assert.deepEqual(argv.slice(-3), [tmuxSource.socket, "$3:@7.%8", "70:$3:%8:/dev/pts/8:0"]);
				assert.match(argv[7], /exec tmux .* attach-session/);
				assert.ok(!argv.includes(selected), "the new tab attaches, not launches another copy");
				attached = true;
				effects.push("attach new tab");
			},
		};
	}, tmux);
	assert.match(await openWorkspace(router, selected, options, "experiments"), /attached to it in a new Ghostty tab/);
	assert.deepEqual(effects, ["new window", "attach new tab"]);
});

test("stale, ambiguous, and read-only workspaces do not create windows or leave claims", async (t) => {
	const { registry, selected, options } = fixture(t);
	for (const [workspaceNow, clientRows, expected] of [
		[ok("71\t$2\n"), ok(), /no longer available/],
		[ok("70\t$2\n"), ok(clients("/dev/pts/21", 21).stdout + clients("/dev/pts/22", 22).stdout), /Multiple tmux clients/],
		[ok("70\t$2\n"), clients("/dev/pts/21", 21, tmuxSource, 1), /not a writable terminal/],
	]) {
		const router = new TerminalSessionRouter(source, registry, () => assert.fail("no verified writable route"), (socket, [command]) => {
			if (socket === undefined) return ok(`70\t${tmuxSource.socket}\n`);
			if (command === "list-sessions") return ok(workspaces);
			if (command === "display-message") return workspaceNow;
			assert.equal(command, "list-clients", "no window creation");
			return clientRows;
		});
		await assert.rejects(openWorkspace(router, selected, options, "research"), expected);
		const claim = registry.reserveLaunch(selected);
		assert.ok(claim);
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
