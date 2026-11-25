import { isAbsolute } from "node:path";
import { focusOrOpen, launchArgv, pickerEnvironment, type LaunchOptions } from "./focus-or-open.ts";
import { LAUNCH_TOKEN_ENV, type ActiveSessionRegistry, type LaunchReservation } from "./session-registry.ts";
import { PANE_FORMAT, parseLivePane, runTmux, type TmuxLocation, type TmuxServer } from "./tmux-location.ts";

export interface TmuxWorkspace extends TmuxServer {
	sessionId: string;
	name: string;
	windows: number;
	attached: number;
}

export function sameTmuxServer(a: TmuxServer, b: TmuxServer): boolean {
	return a.socket === b.socket && a.serverPid === b.serverPid;
}

export interface TmuxClient {
	pid: number;
	tty: string;
	sessionId: string;
	windowId: string;
	paneId: string;
	readOnly: boolean;
}

export function scopedPane(pane: TmuxLocation): string {
	return `${pane.sessionId}:${pane.windowId}.${pane.paneId}`;
}

function output(result: ReturnType<typeof runTmux>): string {
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `tmux exited with ${result.signal ?? result.status}.`);
	return result.stdout;
}

// Probe the default server without starting one; pin subsequent commands to
// its returned socket and PID instead of resolving the default again.
export function defaultTmuxServer(run = runTmux): TmuxServer | undefined {
	const result = run(undefined, ["display-message", "-p", "#{pid}\t#{socket_path}"]);
	if (result.error || result.status !== 0) return;
	const [pid, socket, extra] = result.stdout.replace(/\n$/, "").split("\t");
	const serverPid = Number(pid);
	if (!/^[1-9]\d*$/.test(pid) || serverPid > 0x7fffffff || !socket || !isAbsolute(socket)
		|| /[\0\r\n]/.test(socket) || extra !== undefined) return;
	return { socket, serverPid };
}

export function tmuxWorkspaces(server: TmuxServer, run = runTmux): TmuxWorkspace[] {
	const format = "#{pid}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_name}";
	const raw = output(run(server.socket, ["list-sessions", "-F", format])).replace(/\n$/, "");
	const seen = new Set<string>();
	return raw ? raw.split("\n").map((line) => {
		const [pid, sessionId, windows, attached, name, extra] = line.split("\t");
		if (pid !== String(server.serverPid) || !/^\$\d+$/.test(sessionId) || seen.has(sessionId)
			|| !/^\d+$/.test(windows) || !Number.isSafeInteger(Number(windows))
			|| !/^\d+$/.test(attached) || !Number.isSafeInteger(Number(attached)) || !name || extra !== undefined) {
			throw new Error("Could not verify the tmux workspace list.");
		}
		seen.add(sessionId);
		return { socket: server.socket, serverPid: server.serverPid, sessionId, windows: Number(windows),
			attached: Number(attached), name: name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "�") };
	}) : [];
}

export function verifyTmuxWorkspace(workspace: TmuxWorkspace, run = runTmux): void {
	if (!/^\$\d+$/.test(workspace.sessionId)) throw new Error("Invalid tmux session ID.");
	const result = run(workspace.socket, ["display-message", "-p", "-t", `${workspace.sessionId}:`, "#{pid}\t#{session_id}"]);
	if (result.error || result.status !== 0
		|| result.stdout.trimEnd() !== `${workspace.serverPid}\t${workspace.sessionId}`) {
		throw new Error("The chosen tmux session is no longer available on the verified server.");
	}
}

export function tmuxClients(location: TmuxServer, run = runTmux): TmuxClient[] {
	const format = "#{pid}\t#{client_tty}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{client_readonly}\t#{client_pid}";
	const raw = output(run(location.socket, ["list-clients", "-F", format])).trimEnd();
	return raw ? raw.split("\n").map((line) => {
		const [serverPid, tty, sessionId, windowId, paneId, readOnly, pid, extra] = line.split("\t");
		if (Number(serverPid) !== location.serverPid || !/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(windowId)
			|| !/^%\d+$/.test(paneId) || !/^[01]$/.test(readOnly) || !/^[1-9]\d*$/.test(pid)
			|| Number(pid) > 0x7fffffff || extra !== undefined || /[\r\0]/.test(tty ?? "")) {
			throw new Error("Could not verify tmux client state.");
		}
		return { pid: Number(pid), tty, sessionId, windowId, paneId, readOnly: readOnly === "1" };
	}) : [];
}

export function verifyTmuxPane(expected: TmuxLocation, run = runTmux): TmuxLocation {
	if (!expected.paneTty) throw new Error("The registered tmux pane lacks a verified tty.");
	const inspect = (target: string) => {
		const result = run(expected.socket, ["display-message", "-p", "-t", target, PANE_FORMAT]);
		const pane = !result.error && result.status === 0 ? parseLivePane(expected.socket, result.stdout) : undefined;
		if (pane?.serverPid === expected.serverPid && pane.paneId === expected.paneId && pane.paneTty === expected.paneTty) {
			return pane;
		}
	};
	// Prefer the original session/window for linked windows. A pane may have
	// moved; its server-scoped ID and tty must still match.
	const pane = inspect(scopedPane(expected)) ?? inspect(expected.paneId);
	if (!pane) throw new Error(`Could not verify the live tmux pane ${expected.paneId}.`);
	return pane;
}

export function switchTmuxClient(client: TmuxClient, pane: TmuxLocation, run = runTmux): void {
	output(run(pane.socket, ["switch-client", "-E", "-c", client.tty, "-t", scopedPane(pane)]));
}

// Ownership of the reservation transfers here. Only a definitive rejection
// may release it: a timeout or an invalid receipt could still have launched Pi.
export function createTmuxWindow(server: TmuxServer, sessionId: string, sessionFile: string, reservation: LaunchReservation,
	options: LaunchOptions, run = runTmux): TmuxLocation {
	const result = run(server.socket, ["new-window", "-d", "-P", "-F", PANE_FORMAT,
		"-t", `${sessionId}:`, "-n", "pi-session",
		"-e", `${LAUNCH_TOKEN_ENV}=${reservation.token}`, ...pickerEnvironment().flatMap((assignment) => ["-e", assignment]),
		"--", ...launchArgv(sessionFile, reservation, options),
	]);
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || result.status === 1) {
		reservation.release();
		output(result);
	}
	const pane = !result.error && result.status === 0 ? parseLivePane(server.socket, result.stdout) : undefined;
	if (pane?.serverPid !== server.serverPid || pane.sessionId !== sessionId) {
		throw new Error("Could not confirm tmux created the window; launch reservation kept until Pi registers or the launcher exits.");
	}
	return pane;
}

export class TmuxBackend {
	private readonly source: TmuxLocation;
	private readonly run: typeof runTmux;

	constructor(source: TmuxLocation, run = runTmux) {
		this.source = source;
		this.run = run;
	}

	viewingClient(): TmuxClient {
		// Multiple writable clients showing this pane are indistinguishable
		// from inside it. Never switch an arbitrary client in that case.
		const clients = tmuxClients(this.source, this.run).filter(({ tty, windowId, paneId, readOnly }) =>
			tty.startsWith("/dev/") && windowId === this.source.windowId && paneId === this.source.paneId && !readOnly);
		if (clients.length !== 1) {
			throw new Error(clients.length ? "Multiple tmux clients are viewing this pane; cannot identify which to switch."
				: "No writable tmux client is viewing this pane.");
		}
		return clients[0];
	}

	focus(location: TmuxLocation): void {
		if (!sameTmuxServer(this.source, location)) {
			throw new Error("The selected session is already running on another tmux server.");
		}
		const pane = verifyTmuxPane(location, this.run);
		switchTmuxClient(this.viewingClient(), pane, this.run);
	}

	launch(sessionFile: string, reservation: LaunchReservation, options: LaunchOptions, workspace?: TmuxWorkspace): void {
		let client: TmuxClient;
		try {
			client = this.viewingClient();
			if (workspace) {
				if (!sameTmuxServer(this.source, workspace)) throw new Error("The chosen tmux session is on another server.");
				verifyTmuxWorkspace(workspace, this.run);
			}
		} catch (error) {
			reservation.release();
			throw error;
		}
		const pane = createTmuxWindow(this.source, workspace?.sessionId ?? client.sessionId, sessionFile, reservation, options, this.run);
		try {
			const live = verifyTmuxPane(pane, this.run);
			if (live.sessionId !== pane.sessionId) throw new Error("The new pane moved to another session.");
			const viewing = this.viewingClient();
			if (viewing.pid !== client.pid || viewing.tty !== client.tty || viewing.sessionId !== client.sessionId) {
				throw new Error("The invoking tmux client changed.");
			}
			switchTmuxClient(client, live, this.run);
		} catch (error) {
			throw new Error("The tmux window was created, but it could not be shown on the invoking client.", { cause: error });
		}
	}
}

export async function openTmuxSession(
	selected: string,
	current: string | undefined,
	registry: Pick<ActiveSessionRegistry, "snapshot" | "reserveLaunch">,
	backend: Pick<TmuxBackend, "focus" | "launch">,
	options: LaunchOptions & { confirmLaunch: () => Promise<boolean> },
): Promise<void> {
	await focusOrOpen(selected, current, registry, ({ location, pid }) => {
		if (location?.kind !== "tmux") throw new Error(`The selected session is already running (Pi PID ${pid}) without a verified tmux pane.`);
		backend.focus(location);
	}, (file, reservation) => backend.launch(file, reservation, options), async () => await options.confirmLaunch() ? true : undefined);
}
