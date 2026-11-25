import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActiveSessionRegistry, type Registration } from "./session-registry.ts";
import { detectTmuxLocation } from "./tmux-location.ts";

export function trackSession(
	pi: ExtensionAPI,
	registry = new ActiveSessionRegistry(),
	locate = detectTmuxLocation,
): void {
	let registration: Registration | undefined;
	let working = false;
	let waiting = false;
	let warned = false;

	const report = (ctx: ExtensionContext, error: unknown) => {
		if (!ctx.hasUI || warned) return;
		warned = true;
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Session registry: ${message}`, "warning");
	};

	const state = () => waiting ? "waiting" : working ? "working" : "idle";

	const update = (ctx: ExtensionContext) => {
		try {
			registration?.setState(state());
		} catch (error) {
			report(ctx, error);
		}
	};

	const close = (ctx: ExtensionContext) => {
		const previous = registration;
		registration = undefined;
		try {
			previous?.close();
		} catch (error) {
			report(ctx, error);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		close(ctx);
		warned = false;
		working = !ctx.isIdle();
		waiting = false;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return; // In-memory sessions have no file to match.
		try {
			registration = registry.register({
				sessionFile,
				sessionId: ctx.sessionManager.getSessionId(),
				state: state(),
				// A verified tmux pane is the target even inside another terminal.
				location: ctx.mode === "tui" ? locate() : undefined,
			});
		} catch (error) {
			report(ctx, error);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => close(ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		working = true;
		update(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		working = true;
		update(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		working = false;
		update(ctx);
	});
	pi.on("ui_prompt_start", (_event, ctx) => {
		waiting = true;
		update(ctx);
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		waiting = false;
		working = !ctx.isIdle();
		update(ctx);
	});
}
