import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ActiveSessionRegistry, canonicalSessionFile } from "../src/session-registry.ts";
import { PANE_FORMAT, parseLivePane } from "../src/tmux-location.ts";
import { TerminalSessionRouter } from "../src/terminal-session.ts";
import { TmuxBackend, defaultTmuxServer, tmuxClients } from "../src/tmux-session.ts";

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
	const shutdown = join(dir, "child-shutdown");
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
	const waitForFixture = async (ready, description, paneId) => {
		// The fixture's own result or cleanup is authoritative, not tmux's pane-died notification.
		const deadline = performance.now() + 10_000;
		do {
			if (ready()) return;
			await delay(50);
		} while (performance.now() < deadline);
		assert.fail(`Timed out waiting for ${description} in pane ${paneId}:\n${tmux("capture-pane", "-p", "-S", "-", "-t", paneId)}`);
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
writeFileSync(${JSON.stringify(shutdown)}, "");
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
	const launch = (name, workspace) => {
		const file = canonicalSessionFile(join(dir, name));
		writeFileSync(file, "{}\n");
		const reservation = registry.reserveLaunch(file);
		backend.launch(file, reservation, { cwd: canonicalSessionFile(cwd), extensionFile }, workspace);
		try {
			tmux("wait-for", "child-started");
			assert.ok(existsSync(trace), "child did not write its startup trace");
		} catch (error) {
			throw new Error(`${error.message}\n${tmux("capture-pane", "-p", "-S", "-", "-t", `${workspace?.sessionId ?? source.sessionId}:pi-session`).trim()}`, { cause: error });
		}
		assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
			args: ["--session", file, "--extension", extensionFile], cwd: canonicalSessionFile(cwd),
		});
		assert.ok(existsSync(`${reservation.claim}.running`));
		assert.equal(registry.reserveLaunch(file), undefined);
		return { file, reservation };
	};

	const { file, reservation } = launch("session ' \" $(echo not-a-command).jsonl",
		{ socket, serverPid: another.serverPid, sessionId: another.sessionId, name: "target", windows: 1, attached: 0 });
	tmux("wait-for", "-S", "child-continue");
	tmux("wait-for", "registered");
	const [{ pid, sessionFile, location: launched }] = registry.snapshot().active;
	assert.notEqual(pid, process.pid);
	assert.equal(sessionFile, file);
	assert.equal(launched.sessionId, target.sessionId, "the new Pi belongs to the chosen workspace");
	assert.equal(view(), location(launched));
	assert.equal(existsSync(`${reservation.claim}.running`), false);
	new TmuxBackend(launched).focus(source);
	tmux("wait-for", "-S", "child-exit");
	await waitForFixture(() => existsSync(shutdown), "Pi shutdown", launched.paneId);
	assert.deepEqual(registry.snapshot().active, []);
	tmux("kill-window", "-t", `${launched.sessionId}:${launched.windowId}`);

	const failed = launch("failed.jsonl");
	const failedPane = tmux("display-message", "-p", "-t", `${source.sessionId}:=pi-session`, "#{pane_id}");
	tmux("wait-for", "-S", "child-continue");
	await waitForFixture(() => !existsSync(`${failed.reservation.claim}.running`), "failed-launch reservation cleanup", failedPane);
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
import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import picker from ${JSON.stringify(new URL("../extensions/session-picker.ts", import.meta.url).href)};
process.env.PI_SESSION_PICKER_BIN = ${JSON.stringify(picker)};
let handler;
picker({ on() {}, registerCommand: (_name, command) => { handler = command.handler; } });
const choices = [];
const notices = [];
const switches = [];
let failRouting = false;
let openSubmenu = true;
const ctx = { mode: "tui", cwd: process.cwd(), waitForIdle: async () => {},
  sessionManager: { getSessionFile: () => undefined },
  switchSession: async (file) => switches.push(file),
  ui: {
    select: async (title, items) => {
      choices.push(items);
      if (failRouting) throw new Error("fixture routing failure");
      const item = "New window in an existing tmux session…";
      if (openSubmenu && items.includes(item)) {
        openSubmenu = false;
        return item;
      }
    },
    notify: (message) => notices.push(message),
    custom: (factory) => new Promise((resolve, reject) => {
      factory({ stop() {}, start() {}, requestRender() {}, terminal: { async drainInput() {}, write() {} } }, null, null, resolve).catch(reject);
    }),
  },
};
const wait = spawnSync("tmux", ["-S", process.env.TEST_SOCKET, "wait-for", "check-ready"], {timeout: 3000});
if (wait.status !== 0) throw new Error("waiting for client focus failed");
await handler("", ctx);
failRouting = true;
await handler("", ctx);
failRouting = false;
await handler("native", ctx);
const output = ${JSON.stringify(commandResult)};
writeFileSync(output + ".tmp", JSON.stringify({ choices, notices, switches }));
renameSync(output + ".tmp", output);
`);
	const checkLocation = parseLivePane(socket, tmux("new-window", "-d", "-P", "-F", PANE_FORMAT, "-n", "check-command",
		"-t", `${source.sessionId}:`, "--", process.execPath, check));
	const checkPane = checkLocation.paneId;
	const [onlyClient] = tmuxClients(source);
	tmux("switch-client", "-c", onlyClient.tty, "-t", location(checkLocation));
	tmux("wait-for", "-S", "check-ready");
	await waitForFixture(() => existsSync(commandResult), "session picker command result", checkPane);
	const command = JSON.parse(readFileSync(commandResult, "utf8"));
	const destinations = ["New tmux window — source", "New window in an existing tmux session…"];
	assert.deepEqual(command.choices, [destinations, ["target · 1 window · Detached"], destinations, destinations,
		["Keep current session", "Switch in place"]]);
	assert.deepEqual(command.notices, ["Session picker: fixture routing failure"]);
	assert.deepEqual(command.switches, []);
});

test("real tmux: from a direct Ghostty surface, reuse an attached workspace or attach to a detached one", {
	skip: !available,
}, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-picker-default-tmux-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const saved = Object.fromEntries(["PATH", "TMUX_TMPDIR", "TMUX", "TMUX_PANE"].map((key) => [key, process.env[key]]));
	process.env.PATH = bin + delimiter + saved.PATH;
	process.env.TMUX_TMPDIR = dir; // -L default resolves to this private directory only.
	process.env.TMUX = `${join(dir, "unrelated-socket")},1,0`;
	process.env.TMUX_PANE = "%900";
	const env = { ...process.env, HOME: dir, TERM: "xterm" };
	delete env.TMUX;
	delete env.TMUX_PANE;
	const processes = [];
	const tmux = (...args) => {
		const result = spawnSync("tmux", ["-L", "default", ...args], { env, encoding: "utf8", timeout: 3_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trimEnd();
	};
	t.after(async () => {
		spawnSync("tmux", ["-L", "default", "kill-server"], { env, timeout: 2_000 });
		await Promise.all(processes.map((child) => {
			if (child.exitCode !== null || child.signalCode) return;
			child.kill();
			return new Promise((resolve) => child.once("close", resolve));
		}));
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	writeFileSync(join(bin, "pi"), "#!/bin/sh\nexec /bin/sh -i\n", { mode: 0o700 });
	const create = (name) => tmux("-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "/bin/sh", "-i");
	const research = create("research");
	const work = create("work-engine");
	const detached = create("experiments");
	const server = defaultTmuxServer();
	assert.equal(server.socket, tmux("display-message", "-p", "#{socket_path}"));
	const launchPty = (argv) => {
		const script = join(dir, `pty-launch-${processes.length}`);
		const quote = (arg) => "'" + arg.replaceAll("'", "'\\''") + "'";
		writeFileSync(script, `#!/bin/sh\nexec ${argv.map(quote).join(" ")}\n`, { mode: 0o700 });
		processes.push(spawn("script", ["-qefc", 'exec "$PT_COMMAND"', "/dev/null"], {
			env: { ...env, PT_COMMAND: script }, stdio: ["pipe", "ignore", "ignore"],
		}));
	};
	tmux("set-hook", "-g", "client-attached", "wait-for -S client-ready");
	for (const id of [research, work]) {
		launchPty(["tmux", "-S", server.socket, "attach-session", "-t", id]);
		tmux("wait-for", "client-ready");
	}
	const initial = tmuxClients(server);
	const researchClient = initial.find(({ sessionId }) => sessionId === research);
	const workClient = initial.find(({ sessionId }) => sessionId === work);
	const source = { kind: "ghostty", ownerPid: 10, ownerStart: "linux:ab12:1000", surfaceId: "0xae0f012345678901" };
	const targetTab = { ...source, surfaceId: "0xae0f012345678902" };
	const newTab = { ...source, surfaceId: "0xae0f012345678903" };
	const dispatch = [];
	const router = new TerminalSessionRouter(source, new ActiveSessionRegistry(join(dir, "registry")), (pid) => {
		if (pid === researchClient.pid) return {
			locate: (leaf, expected) => leaf === pid && expected.tty === researchClient.tty ? targetTab : undefined,
			present: (surface) => dispatch.push(["present", surface]),
		};
		assert.equal(pid, process.pid, "only the chosen client's surface or the invoking surface is needed");
		return {
			locate: (leaf) => leaf === process.pid ? source : newTab,
			newTab: (surface, argv) => { dispatch.push(["attach", surface]); launchPty(argv); },
		};
	});
	const open = (name) => {
		const file = join(dir, `${name}.jsonl`);
		writeFileSync(file, "{}\n");
		return router.open(file, undefined, {
			cwd: dir, extensionFile: "/test/extension.ts",
			selectLaunch: async (items) => items.find((item) => item.startsWith("New window in an existing tmux")),
			selectTmuxWorkspace: async (items) => {
				assert.deepEqual(items.map((item) => item.split(" · ")[0]).sort(), ["experiments", "research", "work-engine"]);
				return items.find((item) => item.startsWith(name));
			},
		});
	};
	assert.match(await open("research"), /Requested the exact Ghostty tab/);
	assert.deepEqual(dispatch, [["present", targetTab]]);
	const after = tmuxClients(server);
	assert.equal(after.length, 2, "no extra tmux client for the already attached workspace");
	assert.deepEqual(after.find(({ pid }) => pid === workClient.pid), workClient);
	assert.equal(after.find(({ pid }) => pid === researchClient.pid).paneId,
		tmux("display-message", "-p", "-t", `${research}:pi-session`, "#{pane_id}"));
	assert.match(await open("experiments"), /attached to it in a new Ghostty tab/);
	assert.deepEqual(dispatch, [["present", targetTab], ["attach", source]]);
	const newlyAttached = tmuxClients(server).filter(({ sessionId }) => sessionId === detached);
	assert.equal(newlyAttached.length, 1);
	assert.equal(newlyAttached[0].paneId, tmux("display-message", "-p", "-t", `${detached}:pi-session`, "#{pane_id}"));
});
