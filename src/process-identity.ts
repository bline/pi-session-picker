import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ProcessStatus =
	| { kind: "running"; started: string }
	| { kind: "exited" | "unknown" };

function inaccessible(pid: number): ProcessStatus {
	try {
		process.kill(pid, 0); // Check existence without sending a signal.
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return { kind: "exited" };
	}
	return { kind: "unknown" };
}

function linuxProcess(pid: number): ProcessStatus {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The process name is parenthesized and can itself contain spaces and ')'.
		const end = stat.lastIndexOf(")");
		if (end < 0) return { kind: "unknown" };
		const fields = stat.slice(end + 1).trim().split(/\s+/);
		if (["Z", "X", "x"].includes(fields[0])) return { kind: "exited" };
		const ticks = fields[19]; // Field 22 (starttime), after the PID and name.
		if (!ticks || !/^\d+$/.test(ticks)) return { kind: "unknown" };
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (!boot) return { kind: "unknown" };
		return { kind: "running", started: `linux:${boot}:${ticks}` };
	} catch {
		return inaccessible(pid);
	}
}

function macProcess(pid: number): ProcessStatus {
	const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "state=", "-o", "lstart="], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1_000,
		killSignal: "SIGKILL",
	});
	if (result.status !== 0) return inaccessible(pid);
	const match = /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
	if (!match) return { kind: "unknown" };
	if (match[1].startsWith("Z")) return { kind: "exited" };
	return { kind: "running", started: `darwin:${match[2]}` };
}

export function inspectProcess(pid: number): ProcessStatus {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return { kind: "unknown" };
	if (process.platform === "linux") return linuxProcess(pid);
	if (process.platform === "darwin") return macProcess(pid);
	return { kind: "unknown" };
}
