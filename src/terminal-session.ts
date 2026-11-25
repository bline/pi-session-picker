import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { focusOrOpen, launchArgv, pickerEnvironment, type LaunchOptions } from "./focus-or-open.ts";
import { GhosttyBackend, type GhosttyLocation } from "./ghostty.ts";
import { LAUNCH_TOKEN_ENV, type ActiveSession, type ActiveSessionRegistry, type LaunchReservation, type TerminalLocation } from "./session-registry.ts";
import { runTmux, type TmuxLocation } from "./tmux-location.ts";
import { scopedPane, switchTmuxClient, TmuxBackend, tmuxClients, verifyTmuxPane, type TmuxClient } from "./tmux-session.ts";

const GHOSTTY_REQUESTED = "Requested the exact Ghostty tab; the compositor controls whether its window is raised.";

type Registry = Pick<ActiveSessionRegistry, "snapshot" | "reserveLaunch">;

export type LaunchDestination = "Ghostty in new tmux" | "New tmux window" | "Ghostty without tmux";

function ghosttyLaunchArgv(destination: Exclude<LaunchDestination, "New tmux window">, source: TerminalLocation,
	file: string, reservation: LaunchReservation, options: LaunchOptions): string[] {
	const path = process.env.PATH === undefined ? [] : [`PATH=${process.env.PATH}`];
	const env = [...path, `${LAUNCH_TOKEN_ENV}=${reservation.token}`, ...pickerEnvironment()];
	const launcher = launchArgv(file, reservation, options);
	const cleanEnv = ["/usr/bin/env", "-u", "TMUX", "-u", "TMUX_PANE"];
	if (destination === "Ghostty without tmux") return [...cleanEnv, ...env, ...launcher];
	const socket = source.kind === "tmux" ? ["-S", source.socket] : [];
	return [...cleanEnv, ...path, "tmux", ...socket, "new-session", "-s", `pi-${reservation.token.slice(0, 13)}`,
		...env.flatMap((assignment) => ["-e", assignment]), "--", ...launcher];
}

function sameGhosttySurface(a: GhosttyLocation | undefined, b: GhosttyLocation): boolean {
	return a?.surfaceId === b.surfaceId && a.ownerPid === b.ownerPid && a.ownerStart === b.ownerStart;
}

function sameTmuxServer(a: TmuxLocation, b: TmuxLocation): boolean {
	return a.socket === b.socket && a.serverPid === b.serverPid;
}

function showsPane(client: TmuxClient, pane: TmuxLocation): boolean {
	return client.sessionId === pane.sessionId && client.windowId === pane.windowId && client.paneId === pane.paneId;
}

async function observe(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	do {
		if (predicate()) return true;
		await delay(100);
	} while (performance.now() < deadline);
	return false;
}

export class TerminalSessionRouter {
	private readonly source: TerminalLocation;
	private readonly registry: Registry;
	private readonly connect: typeof GhosttyBackend.forTerminalProcess;
	private readonly tmux: typeof runTmux;

	constructor(source: TerminalLocation, registry: Registry, connect = GhosttyBackend.forTerminalProcess, tmux = runTmux) {
		this.source = source;
		this.registry = registry;
		this.connect = connect;
		this.tmux = tmux;
	}

	private ghosttySource(): { ghostty: GhosttyBackend; location: GhosttyLocation } {
		if (this.source.kind === "tmux") {
			const client = new TmuxBackend(this.source, this.tmux).viewingClient();
			const ghostty = this.connect(client.pid);
			const location = ghostty.locate(client.pid, { tty: client.tty });
			if (location) return { ghostty, location };
		} else {
			const ghostty = this.connect(process.pid);
			if (sameGhosttySurface(ghostty.locate(process.pid), this.source)) return { ghostty, location: this.source };
		}
		throw new Error("Could not verify a Ghostty surface for the invoking terminal.");
	}

	private async focusTmux(location: TmuxLocation): Promise<string | undefined> {
		if (this.source.kind === "tmux" && sameTmuxServer(this.source, location)) {
			// We already have a local client on this server. No GUI dependency.
			new TmuxBackend(this.source, this.tmux).focus(location);
			return;
		}
		const pane = verifyTmuxPane(location, this.tmux);
		const clients = tmuxClients(pane, this.tmux);
		const viewing = clients.filter((client) => client.windowId === pane.windowId && client.paneId === pane.paneId);
		const attached = clients.filter((client) => client.sessionId === pane.sessionId);
		const candidates = viewing.length ? viewing : attached;
		if (candidates.length > 1) throw new Error("Multiple tmux clients can show the target; not choosing a terminal arbitrarily.");
		if (candidates.length === 1) {
			const [client] = candidates;
			if (client.readOnly || !client.tty.startsWith("/dev/")) throw new Error("The target tmux client is not a writable terminal.");
			const ghostty = this.connect(client.pid);
			const outer = ghostty.locate(client.pid, { tty: client.tty });
			if (!outer) throw new Error("The target tmux client does not have a verified writable Ghostty surface.");
			if (!viewing.length) switchTmuxClient(client, pane, this.tmux);
			const current = tmuxClients(pane, this.tmux).find((entry) => entry.pid === client.pid && entry.tty === client.tty);
			if (!current || current.readOnly || current.windowId !== pane.windowId || current.paneId !== pane.paneId
				|| (!viewing.length && current.sessionId !== pane.sessionId)) {
				throw new Error("Could not verify the tmux client selected the target pane.");
			}
			if (!sameGhosttySurface(ghostty.locate(client.pid, { tty: client.tty }), outer)) {
				throw new Error("The tmux client's Ghostty surface changed before it could be focused.");
			}
			ghostty.present(outer);
			return GHOSTTY_REQUESTED;
		}

		const { ghostty, location: outer } = this.ghosttySource();
		const target = scopedPane(pane);
		const expected = `${pane.serverPid}:${pane.paneId}:${pane.paneTty}:0`;
		// Recheck the server and pane in the new tab before attaching. This
		// path starts a tmux client only; it does not start a second Pi.
		ghostty.newTab(outer, ["/usr/bin/env", "-u", "TMUX", "-u", "TMUX_PANE", "/bin/sh", "-c", `
observed=$(tmux -S "$1" display-message -p -t "$2" '#{pid}:#{pane_id}:#{pane_tty}:#{pane_dead}') || exit 1
[ "$observed" = "$3" ] || exit 1
exec tmux -S "$1" attach-session -E -t "$2"
`, "pi-session-picker", pane.socket, target, expected]);
		const existing = new Set(clients.map(({ pid }) => pid));
		const attachedNow = await observe(() => tmuxClients(pane, this.tmux).some((client) => {
			if (existing.has(client.pid) || client.readOnly || !showsPane(client, pane)) return false;
			const surface = ghostty.locate(client.pid, { tty: client.tty });
			return !!surface && !sameGhosttySurface(surface, outer);
		}), 5_000);
		if (!attachedNow) throw new Error("Ghostty received the new-tab request, but attachment to the exact tmux pane could not be verified.");
		return "Attached to the existing tmux pane in a new Ghostty tab.";
	}

	private focus(entry: ActiveSession): string | Promise<string | undefined> {
		const { location, pid } = entry;
		if (!location) throw new Error(`The selected session is already running (Pi PID ${pid}) without a verified terminal location.`);
		if (location.kind === "tmux") return this.focusTmux(location);
		const ghostty = this.connect(pid);
		if (!sameGhosttySurface(ghostty.locate(pid, { started: entry.processStart }), location)) {
			throw new Error("Could not reverify the selected Pi's Ghostty surface.");
		}
		ghostty.present(location);
		return GHOSTTY_REQUESTED;
	}

	private launchChoices(): LaunchDestination[] {
		let hasGhostty = this.source.kind === "ghostty";
		if (this.source.kind === "tmux") {
			try {
				this.ghosttySource();
				hasGhostty = true;
			} catch { /* tmux can be used without a verified outer Ghostty tab. */ }
		}
		const choices: LaunchDestination[] = [];
		if (hasGhostty) choices.push("Ghostty in new tmux");
		if (this.source.kind === "tmux") choices.push("New tmux window");
		if (hasGhostty) choices.push("Ghostty without tmux");
		return choices;
	}

	private async launch(file: string, reservation: LaunchReservation, destination: LaunchDestination, options: LaunchOptions): Promise<string | undefined> {
		if (destination === "New tmux window" && this.source.kind === "tmux") {
			new TmuxBackend(this.source, this.tmux).launch(file, reservation, options);
			return;
		}
		try {
			if (destination === "New tmux window") throw new Error("A new tmux window requires a verified source pane.");
			const { ghostty, location: source } = this.ghosttySource();
			ghostty.newTab(source, ghosttyLaunchArgv(destination, this.source, file, reservation, options));
			const kind = destination === "Ghostty in new tmux" ? "tmux" : "ghostty";
			const registered = await observe(() => !existsSync(reservation.claim) && !existsSync(`${reservation.claim}.running`)
				&& this.registry.snapshot().active.some((entry) => entry.sessionFile === file && entry.location?.kind === kind), 8_000);
			if (!registered) throw new Error("Could not verify that Pi registered in the new Ghostty tab; check the tab before trying again.");
			return kind === "tmux" ? "Pi registered in a new tmux session in Ghostty." : "Pi registered in a new Ghostty tab.";
		} finally {
			// This only removes the pending claim. A launcher that already took
			// it keeps exclusive ownership until its Pi registers or it exits.
			reservation.release();
		}
	}

	open(selected: string, current: string | undefined, options: LaunchOptions & {
		selectLaunch: (choices: LaunchDestination[]) => Promise<string | undefined>;
	}) {
		return focusOrOpen(selected, current, this.registry, (entry) => this.focus(entry),
			(file, reservation, destination: LaunchDestination) => this.launch(file, reservation, destination, options), async () => {
				const choices = this.launchChoices();
				const selection = await options.selectLaunch(choices);
				return choices.find((choice) => choice === selection);
			});
	}
}
