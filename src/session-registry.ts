import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isGhosttyLocation, type GhosttyLocation } from "./ghostty.ts";
import { inspectProcess, type ProcessStatus } from "./process-identity.ts";
import { isTmuxLocation, type TmuxLocation } from "./tmux-location.ts";

export type TerminalLocation = TmuxLocation | GhosttyLocation;

export type AgentState = "idle" | "working" | "waiting";

interface SessionDetails {
	sessionId: string;
	sessionFile: string;
	state: AgentState;
	location?: TerminalLocation;
}

export interface ActiveSession extends SessionDetails {
	host: string;
	pid: number;
	processStart: string;
}

interface RegistrySnapshot {
	active: ActiveSession[];
	stale: ActiveSession[];
	unverified: Array<{ file: string; record?: ActiveSession }>;
}

export interface Registration {
	setState(state: AgentState): void;
	close(): void;
}

export const LAUNCH_TOKEN_ENV = "PI_SESSION_PICKER_LAUNCH_TOKEN";

export interface LaunchReservation {
	readonly token: string;
	readonly claim: string;
	release(): void;
}

export function canonicalSessionFile(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (lstatSync(path, { throwIfNoEntry: false })) throw error;
		// Pi allocates the path before the transcript is first written.
		return join(realpathSync(dirname(path)), basename(path));
	}
}

function isActiveSession(data: unknown): data is ActiveSession {
	if (typeof data !== "object" || data === null) return false;
	const entry = data as Partial<ActiveSession>;
	return typeof entry.sessionId === "string" && entry.sessionId !== ""
		&& typeof entry.sessionFile === "string" && isAbsolute(entry.sessionFile)
		&& !entry.sessionFile.includes("\0")
		&& typeof entry.host === "string" && entry.host !== ""
		&& typeof entry.pid === "number" && Number.isSafeInteger(entry.pid) && entry.pid > 0 && entry.pid <= 0x7fffffff
		&& typeof entry.processStart === "string" && entry.processStart !== ""
		&& (entry.state === "idle" || entry.state === "working" || entry.state === "waiting")
		&& (entry.location === undefined || isTmuxLocation(entry.location) || isGhosttyLocation(entry.location));
}

export class ActiveSessionRegistry {
	readonly directory: string;
	private readonly probe: (pid: number) => ProcessStatus;
	private readonly host = hostname();

	constructor(
		directory = join(homedir(), ".cache", "pi-session-picker", "registry-v1"),
		probe = inspectProcess,
	) {
		this.directory = directory;
		this.probe = probe;
	}

	private checkDirectory(): boolean {
		const stat = lstatSync(this.directory, { throwIfNoEntry: false });
		if (!stat) return false;
		if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
			throw new Error(`Registry directory is not a private directory owned by this user: ${this.directory}`);
		}
		return true;
	}

	private ensureDirectory(): void {
		if (!this.checkDirectory()) {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			this.checkDirectory();
		}
	}

	private reservationDirectory(sessionFile: string): string {
		const key = createHash("sha256").update(sessionFile).digest("hex");
		return join(this.directory, `launch-${key}`);
	}

	// sessionFile is canonical. mkdir serializes launchers across processes,
	// including on different tmux servers. A timeout alone never unlocks it.
	reserveLaunch(sessionFile: string): LaunchReservation | undefined {
		this.ensureDirectory();
		const directory = this.reservationDirectory(sessionFile);
		try {
			mkdirSync(directory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
			throw error;
		}
		const token = randomUUID();
		const claim = join(directory, token);
		try {
			writeFileSync(claim, "", { mode: 0o600, flag: "wx" });
		} catch (error) {
			rmSync(claim, { force: true });
			rmdirSync(directory);
			throw error;
		}
		return { token, claim, release: () => this.removeClaim(sessionFile, token, "") };
	}

	acknowledgeLaunch(sessionFile: string, token: string): void {
		this.removeClaim(sessionFile, token, ".running");
	}

	private removeClaim(sessionFile: string, token: string, suffix: "" | ".running"): void {
		if (!/^[a-f0-9-]{36}$/.test(token)) return;
		const directory = this.reservationDirectory(sessionFile);
		try {
			// Only the actor that removes this unique claim may remove the
			// directory. A late cleanup cannot remove a newer launch's lock.
			unlinkSync(join(directory, token + suffix));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		rmdirSync(directory);
	}

	register(details: SessionDetails): Registration {
		const identity = this.probe(process.pid);
		if (identity.kind !== "running") throw new Error("Cannot verify this Pi process's start time.");
		const entry: ActiveSession = {
			...details,
			sessionFile: canonicalSessionFile(details.sessionFile),
			host: this.host,
			pid: process.pid,
			processStart: identity.started,
		};
		this.ensureDirectory();
		// Unique ownership means an outgoing runtime can only remove its own
		// record, even if another registration shares its PID or session file.
		const token = randomUUID();
		const file = join(this.directory, `${token}.json`);
		const write = (state: AgentState) => {
			const pending = join(this.directory, `.${token}.tmp`);
			try {
				writeFileSync(pending, JSON.stringify({ ...entry, state }) + "\n", { mode: 0o600, flag: "wx" });
				renameSync(pending, file);
			} finally {
				rmSync(pending, { force: true });
			}
			entry.state = state;
		};

		write(entry.state);
		let closed = false;
		return {
			setState: (state) => {
				if (!closed && state !== entry.state) write(state);
			},
			close: () => {
				rmSync(file, { force: true });
				closed = true;
			},
		};
	}

	snapshot(): RegistrySnapshot {
		const result: RegistrySnapshot = { active: [], stale: [], unverified: [] };
		if (!this.checkDirectory()) return result;

		for (const name of readdirSync(this.directory)) {
			if (!name.endsWith(".json")) continue; // Ignore temporary writes.
			const file = join(this.directory, name);
			let entry: unknown;
			try {
				const stat = lstatSync(file);
				if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0) {
					entry = JSON.parse(readFileSync(file, "utf8"));
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Clean shutdown won the race.
			}
			if (!isActiveSession(entry)) {
				result.unverified.push({ file });
				continue;
			}
			const observed: ProcessStatus = entry.host === this.host ? this.probe(entry.pid) : { kind: "unknown" };
			if (observed.kind === "unknown") {
				result.unverified.push({ file, record: entry });
			} else if (observed.kind === "running" && observed.started === entry.processStart) {
				result.active.push(entry);
			} else {
				result.stale.push(entry);
			}
		}
		return result;
	}
}
