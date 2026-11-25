import { focusOrOpen, launchArgv, pickerEnvironment, type LaunchOptions } from "./focus-or-open.ts";
import { LAUNCH_TOKEN_ENV, type ActiveSessionRegistry, type LaunchReservation } from "./session-registry.ts";
import { PANE_FORMAT, parseLivePane, runTmux, type TmuxLocation } from "./tmux-location.ts";

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

export function tmuxClients(location: TmuxLocation, run = runTmux): TmuxClient[] {
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

export class TmuxBackend {
	private readonly source: TmuxLocation;
	private readonly run: typeof runTmux;

	constructor(source: TmuxLocation, run = runTmux) {
		this.source = source;
		this.run = run;
	}

	private command(args: string[]) {
		return this.run(this.source.socket, args);
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
		if (location.socket !== this.source.socket || location.serverPid !== this.source.serverPid) {
			throw new Error("The selected session is already running on another tmux server.");
		}
		const pane = verifyTmuxPane(location, this.run);
		switchTmuxClient(this.viewingClient(), pane, this.run);
	}

	launch(sessionFile: string, reservation: LaunchReservation, options: LaunchOptions): void {
		let client: TmuxClient;
		try {
			client = this.viewingClient();
		} catch (error) {
			reservation.release();
			throw error;
		}
		const result = this.command(["new-window", "-d", "-P", "-F", PANE_FORMAT,
			"-t", `${client.sessionId}:`, "-n", "pi-session",
			"-e", `${LAUNCH_TOKEN_ENV}=${reservation.token}`, ...pickerEnvironment().flatMap((assignment) => ["-e", assignment]),
			"--", ...launchArgv(sessionFile, reservation, options),
		]);
		if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || result.status === 1) {
			reservation.release(); // tmux could not run or rejected new-window.
			output(result);
		}
		const pane = !result.error && result.status === 0 ? parseLivePane(this.source.socket, result.stdout) : undefined;
		if (pane?.serverPid !== this.source.serverPid || pane.sessionId !== client.sessionId) {
			// A timeout or unreadable receipt doesn't prove the window wasn't
			// created. Leave the claim to the launched Pi or pane launcher.
			throw new Error("Could not confirm tmux created the window; launch reservation kept until Pi registers or the launcher exits.");
		}
		const live = verifyTmuxPane(pane, this.run);
		const viewing = this.viewingClient();
		if (viewing.pid !== client.pid || viewing.tty !== client.tty || viewing.sessionId !== client.sessionId) {
			throw new Error("The new window was created, but the invoking tmux client changed before it could be focused.");
		}
		switchTmuxClient(client, live, this.run);
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
