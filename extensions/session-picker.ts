import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerLeftArrow } from "../src/left-arrow.ts";
import { ActiveSessionRegistry, canonicalSessionFile } from "../src/session-registry.ts";
import { TerminalSessionRouter } from "../src/terminal-session.ts";
import { detectTmuxLocation } from "../src/tmux-location.ts";
import { openTmuxSession, TmuxBackend } from "../src/tmux-session.ts";
import { detectTerminalLocation, trackSession } from "../src/track-session.ts";

function requirePicker(executable: string, cwd: string): void {
	// Older pisessions releases ignore arguments and would open the normal
	// resume UI. Probe without terminal access before handing it the terminal.
	const probe = spawnSync(executable, ["--help"], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 5_000,
		killSignal: "SIGKILL",
		maxBuffer: 64 * 1024,
	});
	if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		throw new Error("pisessions was not found. Install it or set PI_SESSION_PICKER_BIN.");
	}
	if (
		probe.status !== 0 ||
		!probe.stdout.includes("--select") ||
		!probe.stdout.includes("--output")
	) {
		throw new Error("Could not verify picker support. Use a pisessions build with --select and --output.");
	}
}

function readSelection(outputPath: string): string | undefined {
	let data: string;
	try {
		data = readFileSync(outputPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	let path: unknown;
	try {
		path = JSON.parse(data);
	} catch {
		throw new Error("pisessions returned invalid selection JSON.");
	}
	if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl") || path.includes("\0")) {
		throw new Error("pisessions did not return an absolute .jsonl session path.");
	}
	const file = statSync(path, { throwIfNoEntry: false });
	if (!file?.isFile() || file.size === 0) {
		throw new Error("The selected session file is missing, empty, or not a regular file.");
	}
	return path;
}

async function pickSession(ctx: ExtensionCommandContext, executable: string): Promise<string | undefined> {
	const cwd = ctx.cwd;
	requirePicker(executable, cwd);
	const directory = mkdtempSync(join(tmpdir(), "pi-session-picker-"));
	try {
		const outputPath = join(directory, "selection.json");
		const child = await ctx.ui.custom<ReturnType<typeof spawnSync>>(async (tui, _theme, _keys, done) => {
			// Pop Pi's keyboard modes and discard pending input before the child
			// takes over, including the release of the key that opened it.
			await tui.terminal.drainInput(250);
			tui.stop();
			let result;
			try {
				tui.terminal.write("\x1b[2J\x1b[H");
				result = spawnSync(executable, ["--select", "--output", outputPath], {
					cwd,
					stdio: "inherit",
					// Textual 8.2.8 can throw on late Kitty repeat/release events.
					// The picker uses ordinary terminal keys; don't enable that parser.
					env: { ...process.env, TEXTUAL_DISABLE_KITTY_KEY: "1" },
				});
			} finally {
				tui.start();
				tui.requestRender(true);
			}
			done(result);
			return { render: () => [], invalidate: () => {} };
		});

		if (child.error) throw child.error;
		if (child.signal === "SIGINT" || child.status === 130) return undefined;
		if (child.status !== 0) {
			throw new Error(`pisessions exited with ${child.signal ?? `status ${child.status}`}.`);
		}
		return readSelection(outputPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const SESSION_MODES = ["focus", "tmux", "native"];

export default function sessionPicker(pi: ExtensionAPI): void {
	const registry = new ActiveSessionRegistry();
	const extensionFile = fileURLToPath(import.meta.url);
	let pickerRunning = false;
	trackSession(pi, registry);
	registerLeftArrow(pi, extensionFile, () => pickerRunning);
	pi.registerCommand("sessions", {
		description: "Browse Pi sessions; keep this session open when possible",
		getArgumentCompletions: (prefix) => {
			const modes = SESSION_MODES.filter((mode) => mode !== prefix && mode.startsWith(prefix));
			return modes.length ? modes.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/sessions requires Pi's terminal UI.", "warning");
				return;
			}

			const mode = args.trim();
			if (mode !== "" && !SESSION_MODES.includes(mode)) {
				ctx.ui.notify("Usage: /sessions [focus|tmux|native]", "warning");
				return;
			}

			if (pickerRunning) return;
			pickerRunning = true;
			try {
				await ctx.waitForIdle();
				const source = mode === "native" ? undefined : mode === "tmux" ? detectTmuxLocation() : detectTerminalLocation();
				if (mode === "tmux" && !source) throw new Error("/sessions tmux requires a verified tmux pane.");
				if (mode === "focus" && !source) throw new Error("/sessions focus requires a verified tmux pane or Linux Ghostty tab.");
				const executable = process.env.PI_SESSION_PICKER_BIN || "pisessions";
				const selected = await pickSession(ctx, executable);
				if (selected === undefined) return;
				const current = ctx.sessionManager.getSessionFile();
				if (!source) {
					if (current && canonicalSessionFile(current) === canonicalSessionFile(selected)) return;
					const replace = "Switch in place";
					const reason = mode === "native" ? "" : "No supported tmux pane or Ghostty tab could be verified.\n";
					const choice = await ctx.ui.select(`${reason}Switching in place closes the current session in this Pi instance. Saved history is not deleted.`,
						["Keep current session", replace]);
					// Pi owns session replacement, including cwd, trust, and vetoes.
					if (choice === replace) await ctx.switchSession(selected);
					return;
				}

				const options = { cwd: ctx.cwd, extensionFile };
				if (mode === "tmux" && source.kind === "tmux") {
					await openTmuxSession(selected, current, registry, new TmuxBackend(source), {
						...options,
						confirmLaunch: () => ctx.ui.confirm("Open a new tmux window?",
							"No registered Pi is using this session. Pi instances without the session picker are not tracked."),
					});
				} else {
					const notice = await new TerminalSessionRouter(source, registry).open(selected, current, {
						...options,
						selectLaunch: (choices) => ctx.ui.select("Open the session where? (Pi instances without this extension are not tracked.)", choices),
						selectTmuxWorkspace: (choices) => ctx.ui.select("Open a new window in which tmux session?", choices),
					});
					if (notice) ctx.ui.notify(notice, "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Session picker: ${message}`, "error");
			} finally {
				pickerRunning = false;
			}
		},
	});
}
