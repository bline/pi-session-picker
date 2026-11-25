import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import sessionPicker from "../extensions/session-picker.ts";

const expectedHandoff = ["idle", "drain", "stop", "clear", "start", "render", "done"];

function fixture(t, options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "picker-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const executable = join(cwd, "fake pisessions.mjs");
	const session = join(cwd, 'a session "é".jsonl');
	const alias = join(cwd, "alias.jsonl");
	const trace = join(cwd, "trace.json");
	const selected = Object.hasOwn(options, "selected") ? options.selected : JSON.stringify(options.alias ? alias : session);
	writeFileSync(session, '{"type":"session","id":"selected"}\n');
	if (options.alias) symlinkSync(session, alias);
	if (!options.missingPicker) {
		writeFileSync(executable, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
if (args[0] === "--help") {
	console.log(${JSON.stringify(options.help ?? "options: --select --output FILE")});
} else {
	assert.deepEqual(args.slice(0, 2), [${JSON.stringify(options.expectedFlag ?? "--select")}, "--output"]);
	assert.equal(args.length, 3);
	assert.equal(process.env.TEXTUAL_DISABLE_KITTY_KEY, "1");
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
	const prompts = [];
	const switches = [];
	const tui = {
		stop: () => lifecycle.push("stop"),
		start: () => lifecycle.push("start"),
		requestRender: (force) => {
			assert.equal(force, true);
			lifecycle.push("render");
		},
		terminal: { drainInput: async () => lifecycle.push("drain"), write: () => lifecycle.push("clear") },
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
			select: async (title, choices) => {
				const { output } = JSON.parse(readFileSync(trace, "utf8"));
				assert.equal(existsSync(dirname(output)), false, "handoff is cleaned up before prompting");
				lifecycle.push("select");
				prompts.push({ title, choices });
				return options.choice;
			},
			custom: async (factory) => {
				let result;
				await factory(tui, null, null, (value) => {
					lifecycle.push("done");
					result = value;
				});
				return result;
			},
		},
	};
	let command;
	sessionPicker({ on() {}, registerCommand: (name, registered) => {
		assert.equal(name, "sessions");
		command = registered;
	} });
	return {
		cwd, lifecycle, notifications, prompts, session, switches, trace,
		open: (args = "") => command.handler(args, ctx),
		complete: (prefix) => command.getArgumentCompletions(prefix),
	};
}

test("an explicit tmux request outside a verified pane never falls back to native", async (t) => {
	const run = fixture(t);
	await run.open("tmux");
	assert.deepEqual(run.lifecycle, ["idle"]);
	assert.deepEqual(run.switches, []);
	assert.equal(existsSync(run.trace), false);
	assert.match(run.notifications[0].message, /requires a verified tmux pane/);
});

test("focus without a verified backend does not open the picker or switch natively", async (t) => {
	const run = fixture(t);
	await run.open("focus");
	assert.deepEqual(run.lifecycle, ["idle"]);
	assert.deepEqual(run.switches, []);
	assert.equal(existsSync(run.trace), false);
	assert.match(run.notifications[0].message, /requires a verified tmux pane or Linux Ghostty tab/);
});

test("an unknown mode shows usage instead of switching natively", async (t) => {
	const run = fixture(t);
	await run.open("ghostty");
	assert.deepEqual(run.lifecycle, []);
	assert.match(run.notifications[0].message, /Usage/);
});

for (const mode of ["", "native"]) {
	test(`${mode || "default outside supported terminals"} switches only after the terminal is restored and the user opts in`, async (t) => {
		const run = fixture(t, { choice: "Switch in place" });
		await run.open(mode);
		assert.deepEqual(run.lifecycle, [...expectedHandoff, "select", "switch"]);
		assert.deepEqual(run.switches, [run.session]);
		assert.deepEqual(run.notifications, []);
		assert.equal(JSON.parse(readFileSync(run.trace, "utf8")).cwd, run.cwd);
		assert.deepEqual(run.prompts[0].choices, ["Keep current session", "Switch in place"]);
		assert.match(run.prompts[0].title, /closes the current session.*Saved history is not deleted/);
		assert.equal(run.prompts[0].title.includes("could be verified"), !mode.endsWith("native"));
	});
}

test("only terminal routes are offered as arguments", (t) => {
	const { complete } = fixture(t);
	const values = (prefix) => complete(prefix)?.map(({ value }) => value);
	assert.deepEqual(values(""), ["focus", "tmux", "native"]);
	assert.deepEqual(values("  tm"), ["tmux"]);
	assert.equal(values("tmux"), undefined);
	assert.equal(values("adv"), undefined);
});

test("extra arguments are rejected before opening the picker", async (t) => {
	const run = fixture(t);
	for (const args of ["native tmux", "advanced"]) await run.open(args);
	assert.deepEqual(run.lifecycle, []);
	assert.equal(existsSync(run.trace), false);
	assert.deepEqual(run.notifications.map(({ message }) => message), [
		"Usage: /sessions [focus|tmux|native]", "Usage: /sessions [focus|tmux|native]",
	]);
});

test("the old two-flag fork opens its management-enabled picker by default", async (t) => {
	const run = fixture(t, {
		help: "--select --advanced-select --output FILE",
		expectedFlag: "--advanced-select",
		selected: null,
	});
	await run.open();
	assert.deepEqual(run.lifecycle, expectedHandoff);
	assert.deepEqual(run.notifications, []);
});

test("a similarly named flag does not change the picker mode", async (t) => {
	const run = fixture(t, { help: "--select --advanced-select-like --output FILE", selected: null });
	await run.open();
	assert.deepEqual(run.lifecycle, expectedHandoff);
	assert.deepEqual(run.notifications, []);
});

for (const help of ["--select --output-dir DIR", "--advanced-select --output FILE"]) {
	test(`picker needs the exact public flags when help advertises ${help}`, async (t) => {
		const run = fixture(t, { help });
		await run.open();
		assert.deepEqual(run.lifecycle, ["idle"]);
		assert.equal(existsSync(run.trace), false);
		assert.match(run.notifications[0].message, /with --select and --output/);
	});
}

for (const choice of [undefined, "Keep current session"]) {
	test(`${choice ?? "dismissing the warning"} does not switch`, async (t) => {
		const run = fixture(t, { choice });
		await run.open();
		assert.deepEqual(run.lifecycle, [...expectedHandoff, "select"]);
		assert.deepEqual(run.switches, []);
	});
}

for (const [name, options] of [
	["a cancelled picker", { selected: null }],
	["an interrupted picker", { status: 130 }],
	["the already-open session", { alreadyOpen: true }],
	["an alias of the already-open session", { alreadyOpen: true, alias: true }],
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
