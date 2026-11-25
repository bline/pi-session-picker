import assert from "node:assert/strict";
import test from "node:test";
import { parseLeftMode, wrapPickerEditor } from "../src/left-arrow.ts";

const left = "\x1b[D";

test("Left Arrow uses auto by default and accepts only supported overrides", () => {
	assert.equal(parseLeftMode(undefined), "auto");
	for (const mode of ["auto", "focus", "tmux", "native", "off"]) assert.equal(parseLeftMode(mode), mode);
	for (const mode of ["", "typo", "ghostty"]) assert.equal(parseLeftMode(mode), undefined);
});

test("the picker wraps the existing editor and consumes only an eligible Left Arrow", () => {
	const received = [];
	let allowed = true;
	let autocomplete = false;
	let opened = 0;
	let dispatched = true;
	const editor = {
		focused: true,
		disableSubmit: false,
		isShowingAutocomplete() { return autocomplete; },
		handleInput(data) { assert.equal(this, editor); received.push(data); },
	};
	const wrapped = wrapPickerEditor(editor, (data) => data === left, () => allowed, () => { opened++; return dispatched; });
	assert.notEqual(wrapped, editor);
	wrapped.handleInput(left);
	assert.equal(opened, 1);
	assert.deepEqual(received, []);

	wrapped.handleInput("text");
	wrapped.handleInput("\x1b[1;5D"); // Ctrl+Left
	editor.focused = false;
	wrapped.handleInput(left);
	editor.focused = true;
	autocomplete = true;
	wrapped.handleInput(left);
	autocomplete = false;
	editor.disableSubmit = true;
	wrapped.handleInput(left);
	editor.disableSubmit = false;
	allowed = false;
	wrapped.handleInput(left);
	assert.equal(opened, 1);
	assert.deepEqual(received, ["text", "\x1b[1;5D", left, left, left, left]);

	allowed = true;
	dispatched = false; // e.g. command could not be verified
	wrapped.handleInput(left);
	assert.equal(received.length, 7);
});

test("navigator-style forwarding proxies compose without changing the underlying input handler", () => {
	const sharedNavigator = (editor, keys) => new Proxy(editor, {
		get(target, property) {
			if (property === "handleInput") return (data) => { keys.push(data); target.handleInput(data); };
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) { return Reflect.set(target, property, value); },
	});
	for (const navigatorFirst of [true, false]) {
		const keys = [];
		const forwarded = [];
		const original = (key) => keys.push(key);
		const editor = { focused: false, disableSubmit: false, isShowingAutocomplete: () => false, handleInput: original };
		let opened = 0;
		const picker = (inner) => wrapPickerEditor(inner, (data) => data === left, () => true, () => { opened++; return true; });
		const wrapped = navigatorFirst ? picker(sharedNavigator(editor, forwarded)) : sharedNavigator(picker(editor), forwarded);
		wrapped.focused = true;
		assert.equal(editor.focused, true);
		wrapped.handleInput("a");
		wrapped.handleInput(left);
		assert.equal(editor.handleInput, original);
		assert.deepEqual(keys, ["a"]);
		assert.deepEqual(forwarded, navigatorFirst ? ["a"] : ["a", left]);
		assert.equal(opened, 1);
	}
});

test("editors without focus, submission, or autocomplete state are left untouched", () => {
	for (const missing of ["focused", "disableSubmit", "isShowingAutocomplete", "handleInput"]) {
		const editor = { focused: true, disableSubmit: false, isShowingAutocomplete: () => false, handleInput() {} };
		delete editor[missing];
		const original = editor.handleInput;
		assert.equal(wrapPickerEditor(editor, () => true, () => true, () => assert.fail("unsupported editor")), editor);
		assert.equal(editor.handleInput, original);
	}
});
