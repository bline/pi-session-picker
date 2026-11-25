import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sessionPicker from "../extensions/session-picker.ts";

const expectedHandoff = ["idle", "stop", "clear", "start", "render", "done"];

function fixture(t, options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "picker-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const executable = join(cwd, "fake pisessions.mjs");
	const session = join(cwd, 'a session "é".jsonl');
	const trace = join(cwd, "trace.json");
	const selected = Object.hasOwn(options, "selected") ? options.selected : JSON.stringify(session);
	writeFileSync(session, '{"type":"session","id":"selected"}\n');
	if (!options.missingPicker) {
		writeFileSync(executable, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
if (args[0] === "--help") {
	console.log(${JSON.stringify(options.help ?? "options: --select --output FILE")});
} else {
	assert.deepEqual(args.slice(0, 2), ["--select", "--output"]);
	assert.equal(args.length, 3);
	assert.equal(existsSync(args[2]), false);
	writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ cwd: process.cwd(), output: args[2] }));
	const selected = ${JSON.stringify(selected)};
	if (selected !== null) writeFileSync(args[2], selected);
	process.exitCode = ${options.status ?? 0};
}
`, { mode: 0o700 });
	}

	const oldBin = process.env.PI_SESSION_PICKER_BIN;
	process.env.PI_SESSION_PICKER_BIN = executable;
	t.after(() => {
		if (oldBin === undefined) delete process.env.PI_SESSION_PICKER_BIN;
		else process.env.PI_SESSION_PICKER_BIN = oldBin;
	});

	const lifecycle = [];
	const notifications = [];
	const switches = [];
	const tui = {
		stop: () => lifecycle.push("stop"),
		start: () => lifecycle.push("start"),
		requestRender: (force) => {
			assert.equal(force, true);
			lifecycle.push("render");
		},
		terminal: { write: () => lifecycle.push("clear") },
	};
	const ctx = {
		cwd,
		mode: options.mode ?? "tui",
		waitForIdle: async () => lifecycle.push("idle"),
		sessionManager: {
			getSessionFile: () => options.alreadyOpen ? session : join(cwd, "original.jsonl"),
		},
		switchSession: async (path) => {
			const run = JSON.parse(readFileSync(trace, "utf8"));
			assert.equal(existsSync(dirname(run.output)), false, "handoff is cleaned up before switching");
			lifecycle.push("switch");
			switches.push(path);
			return { cancelled: false };
		},
		ui: {
			notify: (message, kind) => notifications.push({ message, kind }),
			custom: async (factory) => {
				let result;
				factory(tui, null, null, (value) => {
					lifecycle.push("done");
					result = value;
				});
				return result;
			},
		},
	};
	let handler;
	sessionPicker({ on() {}, registerCommand: (name, command) => {
		assert.equal(name, "sessions");
		handler = command.handler;
	} });
	return {
		cwd, lifecycle, notifications, session, switches, trace,
		open: () => handler("", ctx),
	};
}

test("passes the returned path to Pi only after restoring the terminal", async (t) => {
	const run = fixture(t);
	await run.open();
	assert.deepEqual(run.lifecycle, [...expectedHandoff, "switch"]);
	assert.deepEqual(run.switches, [run.session]);
	assert.deepEqual(run.notifications, []);
	assert.equal(JSON.parse(readFileSync(run.trace, "utf8")).cwd, run.cwd);
});

for (const [name, options] of [
	["a cancelled picker", { selected: null }],
	["an interrupted picker", { status: 130 }],
	["the already-open session", { alreadyOpen: true }],
]) {
	test(`${name} restores the terminal without switching`, async (t) => {
		const run = fixture(t, options);
		await run.open();
		assert.deepEqual(run.lifecycle, expectedHandoff);
		assert.deepEqual(run.switches, []);
		assert.deepEqual(run.notifications, []);
		const { output } = JSON.parse(readFileSync(run.trace, "utf8"));
		assert.equal(existsSync(dirname(output)), false);
	});
}

for (const [name, options, message] of [
	["a failed picker", { status: 1 }, /exited with status 1/],
	["malformed selection JSON", { selected: "not JSON" }, /invalid selection JSON/],
	["a relative selection", { selected: '"relative.jsonl"' }, /absolute .jsonl/],
	["a missing session file", { selected: '"/path/that/does/not/exist.jsonl"' }, /file is missing/],
]) {
	test(`${name} is reported without switching`, async (t) => {
		const run = fixture(t, options);
		await run.open();
		assert.deepEqual(run.lifecycle, expectedHandoff);
		assert.deepEqual(run.switches, []);
		assert.equal(run.notifications.length, 1);
		assert.equal(run.notifications[0].kind, "error");
		assert.match(run.notifications[0].message, message);
		const { output } = JSON.parse(readFileSync(run.trace, "utf8"));
		assert.equal(existsSync(dirname(output)), false);
	});
}

for (const [name, options, lifecycle, message] of [
	["an old picker", { help: "Browse your sessions" }, ["idle"], /verify picker support/],
	["a missing picker", { missingPicker: true }, ["idle"], /pisessions was not found/],
	["an RPC session", { mode: "rpc" }, [], /requires Pi's terminal UI/],
]) {
	test(`${name} never takes over the terminal`, async (t) => {
		const run = fixture(t, options);
		await run.open();
		assert.deepEqual(run.lifecycle, lifecycle);
		assert.equal(existsSync(run.trace), false);
		assert.deepEqual(run.switches, []);
		assert.equal(run.notifications.length, 1);
		assert.match(run.notifications[0].message, message);
	});
}
