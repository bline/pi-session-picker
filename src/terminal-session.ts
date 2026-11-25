import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { focusOrOpen, launchArgv, pickerEnvironment, type LaunchOptions } from "./focus-or-open.ts";
import { GhosttyBackend, type GhosttyLocation } from "./ghostty.ts";
import { LAUNCH_TOKEN_ENV, type ActiveSession, type ActiveSessionRegistry, type LaunchReservation, type TerminalLocation } from "./session-registry.ts";
import { runTmux, type TmuxLocation } from "./tmux-location.ts";
import {
	createTmuxWindow, defaultTmuxServer, sameTmuxServer, scopedPane, switchTmuxClient, TmuxBackend,
	tmuxClients, tmuxWorkspaces, verifyTmuxPane, verifyTmuxWorkspace, type TmuxClient, type TmuxWorkspace,
} from "./tmux-session.ts";

const GHOSTTY_REQUESTED = "Requested the exact Ghostty tab; the compositor controls whether its window is raised.";
const EXISTING_TMUX = "New window in an existing tmux session…";

type Registry = Pick<ActiveSessionRegistry, "snapshot" | "reserveLaunch">;
type GhosttySurface = { ghostty: GhosttyBackend; location: GhosttyLocation };
type GhosttyLaunch = "Ghostty in new tmux" | "Ghostty without tmux";
type LaunchDestination =
	| { kind: "ghostty"; flavor: GhosttyLaunch }
	| { kind: "tmux"; workspace?: TmuxWorkspace };
type LaunchPrompts = {
	selectLaunch: (choices: string[]) => Promise<string | undefined>;
	selectTmuxWorkspace: (choices: string[]) => Promise<string | undefined>;
};

function ghosttyLaunchArgv(destination: GhosttyLaunch, source: TerminalLocation,
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

function sameClient(client: TmuxClient, expected: TmuxClient): boolean {
	return client.pid === expected.pid && client.tty === expected.tty && !client.readOnly;
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

	private ghosttyForClient(client: TmuxClient): GhosttySurface {
		if (client.readOnly || !client.tty.startsWith("/dev/")) throw new Error("The target tmux client is not a writable terminal.");
		const ghostty = this.connect(client.pid);
		const location = ghostty.locate(client.pid, { tty: client.tty });
		if (!location) throw new Error("The target tmux client does not have a verified writable Ghostty surface.");
		return { ghostty, location };
	}

	private ghosttySource(): GhosttySurface {
		if (this.source.kind === "tmux") return this.ghosttyForClient(new TmuxBackend(this.source, this.tmux).viewingClient());
		const ghostty = this.connect(process.pid);
		if (sameGhosttySurface(ghostty.locate(process.pid), this.source)) return { ghostty, location: this.source };
		throw new Error("Could not verify a Ghostty surface for the invoking terminal.");
	}

	private presentTmuxPane(pane: TmuxLocation, client: TmuxClient, surface: GhosttySurface, alreadyViewing: boolean): string {
		const { ghostty, location } = surface;
		if (!alreadyViewing) {
			if (!sameGhosttySurface(ghostty.locate(client.pid, { tty: client.tty }), location)) {
				throw new Error("The tmux client's Ghostty surface changed before it could be selected.");
			}
			switchTmuxClient(client, pane, this.tmux);
		}
		const current = tmuxClients(pane, this.tmux).find((entry) => sameClient(entry, client));
		if (!current || current.windowId !== pane.windowId || current.paneId !== pane.paneId
			|| (!alreadyViewing && current.sessionId !== pane.sessionId)) {
			throw new Error("Could not verify the tmux client selected the target pane.");
		}
		if (!sameGhosttySurface(ghostty.locate(client.pid, { tty: client.tty }), location)) {
			throw new Error("The tmux client's Ghostty surface changed before it could be focused.");
		}
		ghostty.present(location);
		return GHOSTTY_REQUESTED;
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
			return this.presentTmuxPane(pane, client, this.ghosttyForClient(client), viewing.length > 0);
		}
		await this.attachTmuxPane(pane, clients, this.ghosttySource());
		return "Attached to the existing tmux pane in a new Ghostty tab.";
	}

	private async attachTmuxPane(pane: TmuxLocation, clients: TmuxClient[], { ghostty, location }: GhosttySurface): Promise<void> {
		const expected = `${pane.serverPid}:${pane.sessionId}:${pane.paneId}:${pane.paneTty}:0`;
		// Recheck the server, session, and pane in the new tab. This command
		// starts a tmux client only; it never starts another Pi.
		ghostty.newTab(location, ["/usr/bin/env", "-u", "TMUX", "-u", "TMUX_PANE", "/bin/sh", "-c", `
observed=$(tmux -S "$1" display-message -p -t "$2" '#{pid}:#{session_id}:#{pane_id}:#{pane_tty}:#{pane_dead}') || exit 1
[ "$observed" = "$3" ] || exit 1
exec tmux -S "$1" attach-session -E -t "$2"
`, "pi-session-picker", pane.socket, scopedPane(pane), expected]);
		const existing = new Set(clients.map(({ pid }) => pid));
		const attachedNow = await observe(() => tmuxClients(pane, this.tmux).some((client) => {
			if (existing.has(client.pid) || client.readOnly || !showsPane(client, pane)) return false;
			const surface = ghostty.locate(client.pid, { tty: client.tty });
			return !!surface && !sameGhosttySurface(surface, location);
		}), 5_000);
		if (!attachedNow) throw new Error("Ghostty received the new-tab request, but attachment to the exact tmux pane could not be verified.");
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

	private async chooseLaunch(options: LaunchPrompts): Promise<LaunchDestination | undefined> {
		let hasGhostty = this.source.kind === "ghostty";
		let currentId: string | undefined;
		if (this.source.kind === "tmux") {
			try {
				const client = new TmuxBackend(this.source, this.tmux).viewingClient();
				currentId = client.sessionId; // The source pane might be in linked windows.
				this.ghosttyForClient(client);
				hasGhostty = true;
			} catch { /* Keep the tmux-only choice without a verified Ghostty client. */ }
		}
		let workspaces: TmuxWorkspace[] = [];
		try {
			const server = this.source.kind === "ghostty" ? defaultTmuxServer(this.tmux) : currentId ? this.source : undefined;
			if (server) workspaces = tmuxWorkspaces(server, this.tmux);
		} catch { /* Discovery is optional; preserve the existing destinations. */ }

		const current = workspaces.find(({ sessionId }) => sessionId === currentId);
		const currentLabel = current ? `New tmux window — ${current.name}` : "New tmux window";
		const alternatives = workspaces.filter(({ sessionId }) => sessionId !== currentId);
		let labels = alternatives.map(({ name, windows, attached }) => `${name} · ${windows} ${windows === 1 ? "window" : "windows"} · ${attached ? "Attached" : "Detached"}`);
		if (new Set(labels).size !== labels.length) labels = labels.map((label, index) => `${label} [${alternatives[index].sessionId}]`);
		const choices = [
			...(hasGhostty ? ["Ghostty in new tmux"] : []),
			...(this.source.kind === "tmux" ? [currentLabel] : []),
			...(alternatives.length ? [EXISTING_TMUX] : []),
			...(hasGhostty ? ["Ghostty without tmux"] : []),
		];
		for (;;) {
			const choice = await options.selectLaunch(choices);
			if (choice === undefined || !choices.includes(choice)) return;
			if (choice === EXISTING_TMUX) {
				const label = await options.selectTmuxWorkspace(labels);
				if (label === undefined) continue; // Escape returns to the destination menu.
				const workspace = alternatives[labels.indexOf(label)];
				return workspace && { kind: "tmux", workspace };
			}
			if (choice === currentLabel) return { kind: "tmux" };
			if (choice === "Ghostty in new tmux" || choice === "Ghostty without tmux") return { kind: "ghostty", flavor: choice };
		}
	}

	private async launchTmuxFromGhostty(file: string, reservation: LaunchReservation, workspace: TmuxWorkspace, options: LaunchOptions): Promise<string> {
		let client: TmuxClient | undefined;
		let surface: GhosttySurface;
		try {
			verifyTmuxWorkspace(workspace, this.tmux);
			const attached = tmuxClients(workspace, this.tmux).filter(({ sessionId }) => sessionId === workspace.sessionId);
			if (attached.length > 1) throw new Error("Multiple tmux clients are attached to the chosen session; not choosing a tab arbitrarily. Try from inside tmux.");
			[client] = attached;
			surface = client ? this.ghosttyForClient(client) : this.ghosttySource();
		} catch (error) {
			reservation.release();
			throw error;
		}
		const pane = createTmuxWindow(workspace, workspace.sessionId, file, reservation, options, this.tmux);
		try {
			const live = verifyTmuxPane(pane, this.tmux);
			if (live.sessionId !== workspace.sessionId) throw new Error("The new pane moved to another session.");
			const clients = tmuxClients(workspace, this.tmux);
			const attached = clients.filter(({ sessionId }) => sessionId === workspace.sessionId);
			if (client) {
				if (attached.length !== 1 || !sameClient(attached[0], client)) throw new Error("The chosen tmux session's clients changed.");
				return this.presentTmuxPane(live, client, surface, false);
			}
			if (attached.length !== 0) throw new Error("A client attached to the chosen tmux session during launch.");
			if (!sameGhosttySurface(surface.ghostty.locate(process.pid), surface.location)) throw new Error("The invoking Ghostty surface changed.");
			await this.attachTmuxPane(live, clients, surface);
			return "Created the tmux window and attached to it in a new Ghostty tab.";
		} catch (error) {
			throw new Error(`The tmux window was created, but it could not be shown: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	private async launch(file: string, reservation: LaunchReservation, destination: LaunchDestination, options: LaunchOptions): Promise<string | undefined> {
		if (destination.kind === "tmux") {
			if (this.source.kind === "tmux") {
				new TmuxBackend(this.source, this.tmux).launch(file, reservation, options, destination.workspace);
				return;
			}
			if (destination.workspace) return this.launchTmuxFromGhostty(file, reservation, destination.workspace, options);
			reservation.release();
			throw new Error("A new tmux window requires a verified destination session.");
		}
		try {
			const { ghostty, location: source } = this.ghosttySource();
			ghostty.newTab(source, ghosttyLaunchArgv(destination.flavor, this.source, file, reservation, options));
			const kind = destination.flavor === "Ghostty in new tmux" ? "tmux" : "ghostty";
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

	open(selected: string, current: string | undefined, options: LaunchOptions & LaunchPrompts) {
		return focusOrOpen(selected, current, this.registry, (entry) => this.focus(entry),
			(file, reservation, destination: LaunchDestination) => this.launch(file, reservation, destination, options), () => this.chooseLaunch(options));
	}
}
