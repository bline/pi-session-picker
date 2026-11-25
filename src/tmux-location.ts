import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export interface TmuxLocation {
	kind: "tmux";
	socket: string;
	serverPid: number;
	sessionId: string;
	windowId: string;
	paneId: string;
}

export function isTmuxLocation(value: unknown): value is TmuxLocation {
	if (typeof value !== "object" || value === null) return false;
	const tmux = value as Partial<TmuxLocation>;
	return tmux.kind === "tmux"
		&& typeof tmux.socket === "string" && isAbsolute(tmux.socket) && !tmux.socket.includes("\0")
		&& typeof tmux.serverPid === "number" && Number.isSafeInteger(tmux.serverPid) && tmux.serverPid > 0
		&& typeof tmux.sessionId === "string" && /^\$\d+$/.test(tmux.sessionId)
		&& typeof tmux.windowId === "string" && /^@\d+$/.test(tmux.windowId)
		&& typeof tmux.paneId === "string" && /^%\d+$/.test(tmux.paneId);
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
	if (tty.status !== 0) return;
	const result = spawnSync("tmux", ["-S", tmux[1], "display-message", "-p", "-t", paneId,
		"#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_tty}"], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
		timeout: 1_000, killSignal: "SIGKILL",
	});
	if (result.status !== 0) return;

	const [pid, sessionId, windowId, resolvedPane, dead, terminal] = result.stdout.trimEnd().split("\t");
	// Inherited tmux variables are not enough: check the server, the exact
	// live pane and its tty, not a pane that happens to have the same ID.
	if (pid !== tmux[2] || resolvedPane !== paneId || dead !== "0" || terminal !== tty.stdout.trimEnd()) return;
	const location = { kind: "tmux", socket: tmux[1], serverPid: Number(pid), sessionId, windowId, paneId };
	if (isTmuxLocation(location)) return location;
}
