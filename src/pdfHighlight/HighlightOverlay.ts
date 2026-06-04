import { setIcon } from "obsidian";
import type { PdfSelectionOverlayRect, PdfTextSelection } from "../types";
import type { HighlightColorConfig } from "./types";

const OVERLAY_CLASS = "pdf-ollama-translator-highlight-overlay";
const NOTE_ICON_CLASS = "pdf-ollama-translator-highlight-note-icon";
const PAGE_SELECTOR = "[data-page-number], .page, .pdf-page";

interface OverlayGroup {
	rects: PdfSelectionOverlayRect[];
	elements: HTMLElement[];
	icon?: HTMLElement;
	note: string;
	color: HighlightColorConfig;
	onNoteChange: (note: string) => void;
}

export class HighlightOverlay {
	private groups = new Map<string, OverlayGroup>();
	private observedDocuments = new WeakSet<Document>();
	private observers: MutationObserver[] = [];
	private rerenderTimer: number | undefined;
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

		const group: OverlayGroup = {
			rects: selection.overlayRects,
			elements: [],
			note,
			color,
			onNoteChange,
		};
		this.groups.set(id, group);
		this.renderGroup(id, group);
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
		this.clearRenderedElements(group);
		this.groups.delete(id);
		if (this.activeId === id) {
			this.closeEditor();
		}
	}

	private renderGroup(id: string, group: OverlayGroup): void {
		this.clearRenderedElements(group);
		const elements: HTMLElement[] = [];

		for (const rect of group.rects) {
			const pageEl = this.resolvePageElement(rect);
			if (!pageEl) {
				continue;
			}

			this.observeDocument(pageEl.ownerDocument);
			const computed = getComputedStyle(pageEl);
			if (computed.position === "static") {
				pageEl.style.position = "relative";
			}

			const pageRect = pageEl.getBoundingClientRect();
			const left = rect.leftRatio * pageRect.width;
			const top = rect.topRatio * pageRect.height;
			const width = rect.widthRatio * pageRect.width;
			const height = rect.heightRatio * pageRect.height;

			const overlay = pageEl.ownerDocument.createElement("div");
			overlay.className = OVERLAY_CLASS;
			overlay.style.position = "absolute";
			overlay.style.left = `${left}px`;
			overlay.style.top = `${top}px`;
			overlay.style.width = `${width}px`;
			overlay.style.height = `${height}px`;
			overlay.style.background = group.color.css;
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

		group.elements = elements;
		if (group.note.trim()) {
			this.ensureIcon(id, group);
		}

		if (this.activeId === id) {
			const anchor = group.icon ?? group.elements[0];
			if (!anchor) {
				this.closeEditor();
				return;
			}
			this.activeAnchor = anchor;
			this.repositionEditor();
		}
	}

	private clearRenderedElements(group: OverlayGroup): void {
		for (const element of group.elements) {
			element.remove();
		}
		group.icon?.remove();
		group.elements = [];
		group.icon = undefined;
	}

	private resolvePageElement(rect: PdfSelectionOverlayRect): HTMLElement | null {
		if (rect.pageEl.isConnected) {
			return rect.pageEl;
		}

		if (!rect.pageNumber) {
			return null;
		}

		const doc = rect.pageEl.ownerDocument;
		return Array.from(doc.querySelectorAll<HTMLElement>(PAGE_SELECTOR))
			.find((pageEl) => getPageNumber(pageEl) === rect.pageNumber) ?? null;
	}

	private observeDocument(doc: Document): void {
		if (this.observedDocuments.has(doc) || !doc.body) {
			return;
		}

		this.observedDocuments.add(doc);
		const observer = new MutationObserver((mutations) => {
			if (!mutations.some((mutation) => this.shouldRerenderForMutation(mutation))) {
				return;
			}
			this.scheduleRerender();
		});
		observer.observe(doc.body, {
			attributes: true,
			attributeFilter: ["class", "style", "data-page-number"],
			childList: true,
			subtree: true,
		});
		this.observers.push(observer);
	}

	private shouldRerenderForMutation(mutation: MutationRecord): boolean {
		const target = mutation.target;
		const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
		if (changedNodes.length > 0 && changedNodes.every((node) => isManagedNode(node))) {
			return false;
		}

		if (target instanceof Element && isManagedElement(target)) {
			return false;
		}

		if (target instanceof Element && target.closest(PAGE_SELECTOR)) {
			return true;
		}

		return Array.from(mutation.addedNodes).some((node) => (
			node instanceof Element &&
			(Boolean(node.matches(PAGE_SELECTOR)) || Boolean(node.querySelector(PAGE_SELECTOR)))
		));
	}

	private scheduleRerender(): void {
		window.clearTimeout(this.rerenderTimer);
		this.rerenderTimer = window.setTimeout(() => this.rerenderAll(), 80);
	}

	private rerenderAll(): void {
		for (const [id, group] of this.groups) {
			this.renderGroup(id, group);
		}
	}

	private ensureIcon(id: string, group: OverlayGroup): void {
		if (group.icon || group.elements.length === 0) {
			return;
		}

		const anchor = group.elements[0];
		const iconEl = anchor.ownerDocument.createElement("button");
		iconEl.className = NOTE_ICON_CLASS;
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

		if (!this.activeAnchor.ownerDocument.body.contains(this.activeAnchor)) {
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

function isManagedNode(node: Node): boolean {
	return node instanceof Element && isManagedElement(node);
}

function isManagedElement(element: Element): boolean {
	return (
		element.classList.contains(OVERLAY_CLASS) ||
		element.classList.contains(NOTE_ICON_CLASS)
	);
}

function getPageNumber(pageEl: HTMLElement): number | undefined {
	const candidates = [
		pageEl.dataset.pageNumber,
		pageEl.getAttribute("data-page-number"),
		pageEl.getAttribute("aria-label"),
	].filter((value): value is string => Boolean(value));

	for (const candidate of candidates) {
		const match = candidate.match(/\d+/);
		if (!match) {
			continue;
		}
		const page = Number.parseInt(match[0], 10);
		if (Number.isFinite(page) && page > 0) {
			return page;
		}
	}

	return undefined;
}
