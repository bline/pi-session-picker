import { canonicalSessionFile, type ActiveSession, type ActiveSessionRegistry, type LaunchReservation } from "./session-registry.ts";

export interface LaunchOptions {
	cwd: string;
	extensionFile: string;
}

export function launchArgv(sessionFile: string, reservation: LaunchReservation, options: LaunchOptions): string[] {
	// Only this fixed script is interpreted by the shell. Atomically take over
	// the unique claim before launching Pi. The source can safely withdraw a
	// pending claim without racing a child that already took ownership.
	return ["/bin/sh", "-c", `
claim=$1
cwd=$2
shift 2
/bin/mv "$claim" "$claim.running" 2>/dev/null || exit 1
claim=$claim.running
if cd "$cwd"; then "$@"; else false; fi
status=$?
if /bin/rm "$claim" 2>/dev/null; then /bin/rmdir "\${claim%/*}"; fi
exit "$status"
`, "pi-session-picker", reservation.claim, options.cwd, "pi", "--session", sessionFile, "--extension", options.extensionFile];
}

export function pickerEnvironment(): string[] {
	return ["PI_SESSION_PICKER_BIN", "PI_SESSIONS_ROOT", "PI_SESSION_PICKER_LEFT_MODE"].flatMap((key) => {
		const value = process.env[key];
		return value === undefined ? [] : [`${key}=${value}`];
	});
}

export async function focusOrOpen<Destination, Result>(
	selected: string,
	current: string | undefined,
	registry: Pick<ActiveSessionRegistry, "snapshot" | "reserveLaunch">,
	focus: (entry: ActiveSession) => Result | Promise<Result>,
	launch: (file: string, reservation: LaunchReservation, destination: Destination) => Result | Promise<Result>,
	chooseLaunch: () => Promise<Destination | undefined>,
): Promise<Result | undefined> {
	const sessionFile = canonicalSessionFile(selected);
	if (current && canonicalSessionFile(current) === sessionFile) return;

	const findActive = () => {
		const { active, unverified } = registry.snapshot();
		const matches = active.filter((entry) => entry.sessionFile === sessionFile);
		if (matches.length > 1) throw new Error("Multiple Pi processes are using the selected session; not switching.");
		if (matches.length === 1) return matches[0];
		if (unverified.some(({ record }) => !record || record.sessionFile === sessionFile)) {
			throw new Error("The registry cannot verify whether the selected session is already running; not opening another Pi.");
		}
	};

	const active = findActive();
	if (active) return focus(active);
	const destination = await chooseLaunch();
	if (destination === undefined) return;
	const reservation = registry.reserveLaunch(sessionFile);
	if (!reservation) throw new Error("A launch is already reserved for this session; not opening another Pi.");
	let handingOff = false;
	try {
		const appeared = findActive();
		if (appeared) return focus(appeared); // It may have opened while we were confirming.
		handingOff = true;
		return await launch(sessionFile, reservation, destination);
	} finally {
		if (!handingOff) reservation.release();
	}
}
