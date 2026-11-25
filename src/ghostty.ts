import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { linuxProcess } from "./process-identity.ts";

const APP = "com.mitchellh.ghostty";
const OBJECT = "/com/mitchellh/ghostty";
const DBUS = "org.freedesktop.DBus";
const pidIsValid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
const isSurfaceId = (id: unknown): id is string => typeof id === "string" && /^0x[0-9a-f]{16}$/.test(id) && id !== "0x0000000000000000";

export interface GhosttyLocation {
	kind: "ghostty";
	surfaceId: string;
	ownerPid: number;
	ownerStart: string;
}

export function isGhosttyLocation(value: unknown): value is GhosttyLocation {
	if (!value || typeof value !== "object") return false;
	const loc = value as Partial<GhosttyLocation>;
	return loc.kind === "ghostty" && isSurfaceId(loc.surfaceId) && pidIsValid(loc.ownerPid)
		&& typeof loc.ownerStart === "string" && /^linux:[a-f0-9-]+:\d+$/.test(loc.ownerStart);
}

function runGdbus(args: string[], address?: string): string {
	const bus = address ? ["--address", address] : ["--session"];
	const result = spawnSync("gdbus", ["call", ...bus, "--timeout", "2", ...args], {
		encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		timeout: 2_500, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Ghostty's D-Bus call failed.");
	return result.stdout.trim();
}

function readEnvironment(pid: number, name: string): string | undefined {
	if (!pidIsValid(pid)) return;
	try {
		const key = `${name}=`;
		const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.startsWith(key));
		if (entries.length === 1) return entries[0].slice(key.length);
	} catch { /* An inaccessible process is not a verified surface. */ }
}

const surfaceEnv = (pid: number) => readEnvironment(pid, "GHOSTTY_SURFACE_ID");

// /proc contains the initial env, not a tmux server's current session env.
// Verify that this tty actually descends from the bus owner and that its
// original Ghostty child agrees on the surface ID. Inherited variables alone
// (e.g. inside a tmux pane, after reparenting, or copied to another tab) aren't proof.
export function findGhosttySurface(
	pid: number, owner: { pid: number; started: string }, expected?: { started?: string; tty?: string },
	probe = linuxProcess, readSurface = surfaceEnv, readTty = (p: number) => readlinkSync(`/proc/${p}/fd/0`),
): GhosttyLocation | undefined {
	try {
		const first = probe(pid);
		if (first.kind !== "running" || first.ttyDevice === "0" || pid === owner.pid
			|| (expected?.started !== undefined && first.started !== expected.started)
			|| (expected?.tty !== undefined && readTty(pid) !== expected.tty)) return;
		const surfaceId = readSurface(pid);
		if (!isSurfaceId(surfaceId)) return;
		let currentPid = pid;
		let current = first;
		for (let depth = 0; depth < 64; depth++) {
			if (current.parentPid === owner.pid) {
				if (readSurface(currentPid) !== surfaceId) return;
				const leafNow = probe(pid);
				const childNow = probe(currentPid);
				const ownerNow = probe(owner.pid);
				if (leafNow.kind === "running" && leafNow.started === first.started && leafNow.ttyDevice === first.ttyDevice
					&& childNow.kind === "running" && childNow.started === current.started && childNow.parentPid === owner.pid
					&& childNow.ttyDevice === first.ttyDevice && ownerNow.kind === "running" && ownerNow.started === owner.started) {
					return { kind: "ghostty", surfaceId, ownerPid: owner.pid, ownerStart: owner.started };
				}
				return;
			}
			currentPid = current.parentPid;
			if (currentPid <= 1) return;
			const parent = probe(currentPid);
			if (parent.kind !== "running" || parent.ttyDevice !== first.ttyDevice) return;
			current = parent;
		}
	} catch { /* Race or inaccessible /proc data: fail closed. */ }
}

export class GhosttyBackend {
	private readonly name: string;
	private readonly owner: { pid: number; started: string };
	private readonly call: typeof runGdbus;

	private constructor(name: string, owner: { pid: number; started: string }, call: typeof runGdbus) {
		this.name = name;
		this.owner = owner;
		this.call = call;
	}

	static connect(call = runGdbus, probe = linuxProcess): GhosttyBackend {
		if (process.platform !== "linux") throw new Error("Ghostty tab routing currently requires Linux GTK.");
		const dbus = (method: string, arg: string) => call([
			"--dest", DBUS, "--object-path", "/org/freedesktop/DBus", "--method", `${DBUS}.${method}`, arg,
		]);
		const name = /^\('(:\d+\.\d+)',\)$/.exec(dbus("GetNameOwner", APP))?.[1];
		if (!name) throw new Error("Could not verify the Ghostty D-Bus owner.");
		const pid = Number(/^\(uint32 (\d+),\)$/.exec(dbus("GetConnectionUnixProcessID", name))?.[1]);
		const identity = probe(pid);
		if (!pidIsValid(pid) || identity.kind !== "running") throw new Error("Could not verify the Ghostty process identity.");
		return new GhosttyBackend(name, { pid, started: identity.started }, call);
	}

	static forTerminalProcess(pid: number): GhosttyBackend {
		// A tmux pane may still carry a previous client's session bus too.
		// Use the terminal process's local Unix bus address when it has one.
		const address = readEnvironment(pid, "DBUS_SESSION_BUS_ADDRESS");
		if (address && !address.split(";").every((part) => part.startsWith("unix:"))) {
			throw new Error("Ghostty tab routing requires a local Unix D-Bus session.");
		}
		return GhosttyBackend.connect((args) => runGdbus(args, address));
	}

	locate(pid: number, expected?: { started?: string; tty?: string }): GhosttyLocation | undefined {
		return findGhosttySurface(pid, this.owner, expected);
	}

	private gtk(method: string, ...args: string[]): string {
		// Address the unique connection, not a well-known name that could
		// switch to a replacement Ghostty after our identity check.
		return this.call(["--dest", this.name, "--object-path", OBJECT, "--method", `org.gtk.Actions.${method}`, ...args]);
	}

	private activate(location: GhosttyLocation, action: "present-surface" | "new-tab", argv?: string[]) {
		if (!isGhosttyLocation(location) || location.ownerPid !== this.owner.pid || location.ownerStart !== this.owner.started) {
			throw new Error("The Ghostty surface does not belong to the current D-Bus owner.");
		}
		const signature = action === "present-surface" ? "t" : "(tas)";
		if (this.gtk("Describe", action) !== `((true, signature '${signature}', @av []),)`) {
			throw new Error(`Ghostty does not expose the expected ${action} action.`);
		}
		const id = BigInt(location.surfaceId).toString();
		// Pass one GVariant argument, not a shell command. JSON's quoted
		// strings are accepted by the GVariant parser for these argv values.
		const params = argv ? `[<(uint64 ${id}, ${JSON.stringify(["-e", ...argv])})>]` : `[<uint64 ${id}>]`;
		if (this.gtk("Activate", action, params, "{}") !== "()") throw new Error(`Could not confirm dispatch of Ghostty ${action}.`);
	}

	present(location: GhosttyLocation): void {
		this.activate(location, "present-surface");
	}

	newTab(location: GhosttyLocation, argv: string[]): void {
		if (!argv.length || argv.some((arg) => arg.includes("\0"))) throw new Error("Invalid Ghostty tab command.");
		this.activate(location, "new-tab", argv);
	}
}

export function detectGhosttyLocation(): GhosttyLocation | undefined {
	if (!isSurfaceId(process.env.GHOSTTY_SURFACE_ID) || !process.stdin.isTTY || !process.stdout.isTTY) return;
	try {
		return GhosttyBackend.forTerminalProcess(process.pid).locate(process.pid);
	} catch { /* Unsupported or unavailable Ghostty is not a verified location. */ }
}
