import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export interface TmuxLocation {
	kind: "tmux";
	socket: string;
	serverPid: number;
	sessionId: string;
	windowId: string;
	paneId: string;
	paneTty?: string; // Older records did not record the tty.
}

export function isTmuxLocation(value: unknown): value is TmuxLocation {
	if (typeof value !== "object" || value === null) return false;
	const tmux = value as Partial<TmuxLocation>;
	return tmux.kind === "tmux"
		&& typeof tmux.socket === "string" && isAbsolute(tmux.socket) && !tmux.socket.includes("\0")
		&& typeof tmux.serverPid === "number" && Number.isSafeInteger(tmux.serverPid) && tmux.serverPid > 0
		&& typeof tmux.sessionId === "string" && /^\$\d+$/.test(tmux.sessionId)
		&& typeof tmux.windowId === "string" && /^@\d+$/.test(tmux.windowId)
		&& typeof tmux.paneId === "string" && /^%\d+$/.test(tmux.paneId)
		&& (tmux.paneTty === undefined || (typeof tmux.paneTty === "string" && isAbsolute(tmux.paneTty)
			&& !/[\t\r\n\0]/.test(tmux.paneTty)));
}

export function runTmux(socket: string, args: string[]) {
	// tmux's argv parser treats a trailing semicolon as a command separator
	// even without a shell. Escape it before passing paths or other values.
	return spawnSync("tmux", ["-S", socket, ...args.map((arg) => arg.endsWith(";") ? arg.slice(0, -1) + "\\;" : arg)], {
		encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
	});
}

export const PANE_FORMAT = "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_tty}";

export function parseLivePane(socket: string, output: string): TmuxLocation | undefined {
	const [pid, sessionId, windowId, paneId, dead, paneTty, extra] = output.trimEnd().split("\t");
	if (dead !== "0" || !paneTty || extra !== undefined) return;
	const location = { kind: "tmux", socket, serverPid: Number(pid), sessionId, windowId, paneId, paneTty };
	if (isTmuxLocation(location)) return location;
}

export function detectTmuxLocation(): TmuxLocation | undefined {
	// TMUX contains the socket path, server PID, and session number. The
	// socket path itself can contain commas, so parse from the right.
	const tmux = /^(.+),(\d+),\d+$/.exec(process.env.TMUX ?? "");
	const paneId = process.env.TMUX_PANE;
	if (!tmux || !isAbsolute(tmux[1]) || !paneId || !/^%\d+$/.test(paneId)) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return;

	const tty = spawnSync("tty", [], {
		encoding: "utf8", stdio: ["inherit", "pipe", "ignore"],
		timeout: 1_000, killSignal: "SIGKILL",
	});
	if (tty.error || tty.status !== 0) return;
	const result = runTmux(tmux[1], ["display-message", "-p", "-t", paneId, PANE_FORMAT]);
	if (result.error || result.status !== 0) return;

	// Inherited tmux variables are not enough: check the server, the exact
	// live pane and its tty, not a pane that happens to have the same ID.
	const location = parseLivePane(tmux[1], result.stdout);
	if (location?.serverPid === Number(tmux[2]) && location.paneId === paneId
		&& location.paneTty === tty.stdout.trimEnd()) return location;
}
