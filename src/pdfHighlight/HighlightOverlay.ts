import { setIcon } from "obsidian";
import type { PdfTextSelection } from "../types";
import type { HighlightColorConfig } from "./types";

const OVERLAY_CLASS = "pdf-ollama-translator-highlight-overlay";

interface OverlayGroup {
	elements: HTMLElement[];
	icon?: HTMLElement;
	note: string;
	color: HighlightColorConfig;
	onNoteChange: (note: string) => void;
}

export class HighlightOverlay {
	private groups = new Map<string, OverlayGroup>();
	private editorEl: HTMLElement | undefined;
	private textareaEl: HTMLTextAreaElement | undefined;
	private activeId = "";
	private activeAnchor: HTMLElement | undefined;
	private listenersRegistered = false;

	render(
		id: string,
		selection: PdfTextSelection,
		color: HighlightColorConfig,
		note: string,
		onNoteChange: (note: string) => void,
	): void {
		this.remove(id);
		if (!selection.overlayRects?.length) {
			return;
		}

		const elements: HTMLElement[] = [];
		for (const rect of selection.overlayRects) {
			const pageEl = rect.pageEl;
			const computed = getComputedStyle(pageEl);
			if (computed.position === "static") {
				pageEl.style.position = "relative";
			}

			const overlay = pageEl.ownerDocument.createElement("div");
			overlay.className = OVERLAY_CLASS;
			overlay.style.position = "absolute";
			overlay.style.left = `${rect.left}px`;
			overlay.style.top = `${rect.top}px`;
			overlay.style.width = `${rect.width}px`;
			overlay.style.height = `${rect.height}px`;
			overlay.style.background = color.css;
			overlay.style.opacity = "0.38";
			overlay.style.mixBlendMode = "multiply";
			overlay.style.borderRadius = "2px";
			overlay.style.pointerEvents = "auto";
			overlay.style.cursor = "text";
			overlay.style.zIndex = "4";
			overlay.dataset.highlightId = id;
			overlay.onpointerdown = (event) => {
				event.preventDefault();
				event.stopPropagation();
			};
			overlay.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.openEditor(id, overlay);
			};
			pageEl.appendChild(overlay);
			elements.push(overlay);
		}

		const group: OverlayGroup = { elements, note, color, onNoteChange };
		this.groups.set(id, group);
		this.updateNote(id, note);
	}

	updateNote(id: string, note: string): void {
		const group = this.groups.get(id);
		if (!group) {
			return;
		}

		group.note = note;
		if (this.activeId === id && this.textareaEl && this.textareaEl.value !== note) {
			this.textareaEl.value = note;
		}

		if (note.trim()) {
			this.ensureIcon(id, group);
		} else {
			group.icon?.remove();
			group.icon = undefined;
		}
	}

	remove(id: string): void {
		const group = this.groups.get(id);
		if (!group) {
			return;
		}
		for (const element of group.elements) {
			element.remove();
		}
		group.icon?.remove();
		this.groups.delete(id);
		if (this.activeId === id) {
			this.closeEditor();
		}
	}

	private ensureIcon(id: string, group: OverlayGroup): void {
		if (group.icon || group.elements.length === 0) {
			return;
		}

		const anchor = group.elements[0];
		const iconEl = anchor.ownerDocument.createElement("button");
		iconEl.className = "pdf-ollama-translator-highlight-note-icon";
		iconEl.type = "button";
		iconEl.style.setProperty("--pdf-ollama-translator-highlight-color", group.color.css);
		iconEl.setAttribute("aria-label", "Highlight note");
		setIcon(iconEl, "message-square");
		iconEl.onpointerdown = (event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		iconEl.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openEditor(id, iconEl);
		};
		anchor.appendChild(iconEl);
		group.icon = iconEl;
	}

	private openEditor(id: string, anchorEl: HTMLElement): void {
		const group = this.groups.get(id);
		if (!group) {
			return;
		}

		this.activeId = id;
		this.activeAnchor = anchorEl;
		this.ensureEditor();
		if (!this.editorEl || !this.textareaEl) {
			return;
		}

		this.textareaEl.value = group.note;
		this.textareaEl.style.borderColor = group.color.css;
		this.editorEl.style.display = "block";
		this.repositionEditor();
		this.textareaEl.focus();
	}

	private closeEditor(): void {
		this.activeId = "";
		this.activeAnchor = undefined;
		this.editorEl?.hide();
	}

	private repositionEditor(): void {
		if (!this.editorEl || !this.activeAnchor || this.editorEl.style.display === "none") {
			return;
		}

		if (!document.body.contains(this.activeAnchor)) {
			this.closeEditor();
			return;
		}

		const anchorRect = this.activeAnchor.getBoundingClientRect();
		const editorRect = this.editorEl.getBoundingClientRect();
		const margin = 12;
		const rightSideLeft = anchorRect.right + 8;
		const leftSideLeft = anchorRect.left - editorRect.width - 8;
		const preferredLeft = rightSideLeft + editorRect.width + margin <= window.innerWidth
			? rightSideLeft
			: leftSideLeft;
		const left = clamp(preferredLeft, margin, window.innerWidth - editorRect.width - margin);
		const top = clamp(anchorRect.top, margin, window.innerHeight - editorRect.height - margin);
		this.editorEl.style.left = `${left}px`;
		this.editorEl.style.top = `${top}px`;
	}

	private ensureEditor(): void {
		if (this.editorEl && this.textareaEl) {
			return;
		}

		this.editorEl = document.body.createDiv({ cls: "pdf-ollama-translator-highlight-note-editor" });
		this.editorEl.hide();
		this.textareaEl = this.editorEl.createEl("textarea", {
			cls: "pdf-ollama-translator-highlight-note-editor__textarea",
			attr: { placeholder: "Add note" },
		});
		this.textareaEl.oninput = () => {
			const group = this.groups.get(this.activeId);
			if (!group || !this.textareaEl) {
				return;
			}
			group.onNoteChange(this.textareaEl.value);
		};
		this.textareaEl.onkeydown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeEditor();
			}
		};
		this.registerGlobalListeners();
	}

	private registerGlobalListeners(): void {
		if (this.listenersRegistered) {
			return;
		}
		this.listenersRegistered = true;
		document.addEventListener("pointerdown", (event) => this.handleDocumentPointerDown(event), true);
		document.addEventListener("scroll", () => this.repositionEditor(), true);
		window.addEventListener("resize", () => this.repositionEditor());
	}

	private handleDocumentPointerDown(event: PointerEvent): void {
		if (!this.editorEl || this.editorEl.style.display === "none") {
			return;
		}

		const target = event.target;
		if (
			target instanceof Node &&
			(this.editorEl.contains(target) || this.activeAnchor?.contains(target))
		) {
			return;
		}

		this.closeEditor();
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
