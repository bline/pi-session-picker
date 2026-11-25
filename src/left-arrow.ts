import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "auto" | "focus" | "tmux" | "native" | "off";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type PickerEditor = ReturnType<EditorFactory>;

export function parseLeftMode(value: string | undefined): Mode | undefined {
	switch (value) {
		case undefined: return "auto";
		case "auto": case "focus": case "tmux": case "native": case "off": return value;
	}
}

export function wrapPickerEditor(
	editor: PickerEditor,
	isLeftPress: (data: string) => boolean,
	canOpen: () => boolean,
	open: () => boolean,
): PickerEditor {
	// Custom editors may cross loader boundaries (instanceof is unreliable).
	// Leave editors that can't tell us about focus/autocomplete alone.
	if (typeof editor.handleInput !== "function" || !("focused" in editor) || !("disableSubmit" in editor)
		|| !("isShowingAutocomplete" in editor) || typeof editor.isShowingAutocomplete !== "function") return editor;
	const isShowingAutocomplete = editor.isShowingAutocomplete.bind(editor);
	const input = (data: string) => {
		if (isLeftPress(data) && editor.focused === true && editor.disableSubmit === false
			&& !isShowingAutocomplete() && canOpen() && open()) return;
		editor.handleInput?.(data);
	};
	// Do not assign to the inner editor: an existing Proxy can forward a write
	// to its target while its own handler still calls that same target method.
	return new Proxy(editor, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (descriptor?.configurable === false && "value" in descriptor && descriptor.writable === false) return value;
			if (key === "handleInput") return input;
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, key, value) {
			return Reflect.set(target, key, value, target);
		},
	});
}

export function registerLeftArrow(pi: ExtensionAPI, extensionPath: string, pickerIsRunning: () => boolean): void {
	let installed: EditorFactory | undefined;
	let base: EditorFactory | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const mode = parseLeftMode(process.env.PI_SESSION_PICKER_LEFT_MODE);
		if (mode === undefined) {
			ctx.ui.notify("Session picker: PI_SESSION_PICKER_LEFT_MODE must be auto, focus, tmux, native, or off; Left Arrow disabled.", "warning");
		}
		const current = ctx.ui.getEditorComponent();
		if (mode === undefined || mode === "off") {
			if (installed && current === installed) ctx.ui.setEditorComponent(base);
			return;
		}

		// Pi supplies these packages. Load them only when installing the TUI
		// shortcut; the command and its headless tests do not need them.
		const [{ CustomEditor }, { matchesKey, isKeyRepeat, isKeyRelease }] = await Promise.all([
			import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-tui"),
		]);
		const previous = ctx.ui.getEditorComponent();
		base = previous === installed ? base : previous;
		const previousFactory = base;
		const canOpen = () => !pickerIsRunning() && ctx.isIdle() && !ctx.hasPendingMessages() && ctx.ui.getEditorText() === "";
		const invoke = () => {
			// Never turn the shortcut into a model prompt, or dispatch another
			// extension's /sessions if Pi has disambiguated duplicate names.
			const command = pi.getCommands().find(({ name, source, sourceInfo }) => source === "extension"
				&& /^sessions(?::\d+)?$/.test(name) && sourceInfo.path === extensionPath);
			if (!command) return false;
			pi.sendUserMessage(`/${command.name}${mode === "auto" ? "" : ` ${mode}`}`, { expandPromptTemplates: true });
			return true;
		};
		installed = (tui, theme, keybindings) => wrapPickerEditor(
			previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true }),
			(data) => matchesKey(data, "left") && !isKeyRepeat(data) && !isKeyRelease(data), canOpen, invoke,
		);
		ctx.ui.setEditorComponent(installed);
	});
}
