import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { trackSession } from "../src/track-session.ts";

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
		const child = await ctx.ui.custom<ReturnType<typeof spawnSync>>((tui, _theme, _keys, done) => {
			tui.stop();
			let result;
			try {
				tui.terminal.write("\x1b[2J\x1b[H");
				result = spawnSync(executable, ["--select", "--output", outputPath], {
					cwd,
					stdio: "inherit",
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

export default function sessionPicker(pi: ExtensionAPI): void {
	trackSession(pi);
	pi.registerCommand("sessions", {
		description: "Browse and switch sessions with pisessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/sessions requires Pi's terminal UI.", "warning");
				return;
			}

			let selected: string | undefined;
			try {
				await ctx.waitForIdle();
				const executable = process.env.PI_SESSION_PICKER_BIN || "pisessions";
				selected = await pickSession(ctx, executable);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Session picker: ${message}`, "error");
				return;
			}

			if (selected !== undefined && selected !== ctx.sessionManager.getSessionFile()) {
				// Pi owns session replacement, including cwd, trust, and vetoes.
				await ctx.switchSession(selected);
			}
		},
	});
}
