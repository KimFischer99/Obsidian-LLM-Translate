import { setIcon, type App } from "obsidian";
import type { PdfSelectionOverlayRect, PdfTextSelection } from "../types";
import type { HighlightColorConfig } from "./types";

const HOST_CLASS = "pdf-ollama-translator-highlight-host";
const LAYER_CLASS = "pdf-ollama-translator-highlight-layer";
const OVERLAY_CLASS = "pdf-ollama-translator-highlight-overlay";
const NOTE_ICON_CLASS = "pdf-ollama-translator-highlight-note-icon";
const PAGE_SELECTOR = "[data-page-number], .page, .pdf-page";
const PDF_VIEWER_SELECTOR = [
	".pdf-container",
	".pdf-viewer",
	".pdfViewer",
	".pdf-embed",
	".mod-pdf",
	".document-container",
	".workspace-leaf-content[data-type='pdf']",
].join(", ");

interface PdfViewLike {
	containerEl?: HTMLElement;
	file?: { path?: string } | null;
	getViewType?: () => string;
}

interface LeafLike {
	view?: PdfViewLike;
}

interface OverlayGroup {
	filePath?: string;
	rects: PdfSelectionOverlayRect[];
	elements: HTMLElement[];
	icon?: HTMLElement;
	note: string;
	color: HighlightColorConfig;
	onNoteChange: (note: string) => void;
}

export class HighlightOverlay {
	private groups = new Map<string, OverlayGroup>();
	private layers = new Map<HTMLElement, HTMLElement>();
	private observedDocuments = new WeakSet<Document>();
	private observers: MutationObserver[] = [];
	private renderFrame: number | undefined;
	private editorEl: HTMLElement | undefined;
	private textareaEl: HTMLTextAreaElement | undefined;
	private activeId = "";
	private activeAnchor: HTMLElement | undefined;
	private listenersRegistered = false;

	constructor(private app: App) {}

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

		this.registerGlobalListeners();
		const group: OverlayGroup = {
			filePath: selection.file?.path,
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
		this.pruneEmptyLayers();
	}

	refresh(): void {
		this.scheduleRerender();
	}

	destroy(): void {
		if (this.renderFrame !== undefined) {
			cancelAnimationFrame(this.renderFrame);
			this.renderFrame = undefined;
		}
		for (const observer of this.observers) {
			observer.disconnect();
		}
		this.observers = [];
		for (const group of this.groups.values()) {
			this.clearRenderedElements(group);
		}
		this.groups.clear();
		for (const layer of this.layers.values()) {
			layer.remove();
		}
		this.layers.clear();
		this.editorEl?.remove();
		this.editorEl = undefined;
		this.textareaEl = undefined;
		if (this.listenersRegistered) {
			activeDocument.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
			activeDocument.removeEventListener("scroll", this.handleViewportChange, true);
			window.removeEventListener("resize", this.handleViewportChange);
		}
		this.listenersRegistered = false;
	}

	private renderGroup(id: string, group: OverlayGroup): void {
		this.clearRenderedElements(group);
		const host = this.resolveHost(group);
		if (!host) {
			if (this.activeId === id) {
				this.closeEditor();
			}
			return;
		}

		this.observeDocument(host.ownerDocument);
		const layer = this.ensureLayer(host);
		const hostRect = host.getBoundingClientRect();
		const elements: HTMLElement[] = [];

		for (const rect of group.rects) {
			const pageEl = this.resolvePageElement(rect, host);
			if (!pageEl) {
				continue;
			}

			const pageRect = pageEl.getBoundingClientRect();
			if (pageRect.width <= 0 || pageRect.height <= 0) {
				continue;
			}

			const left = pageRect.left - hostRect.left + rect.leftRatio * pageRect.width;
			const top = pageRect.top - hostRect.top + rect.topRatio * pageRect.height;
			const width = rect.widthRatio * pageRect.width;
			const height = rect.heightRatio * pageRect.height;

			const overlay = layer.ownerDocument.createElement("div");
			overlay.className = OVERLAY_CLASS;
			overlay.style.left = `${left}px`;
			overlay.style.top = `${top}px`;
			overlay.style.width = `${width}px`;
			overlay.style.height = `${height}px`;
			overlay.style.background = group.color.css;
			overlay.dataset.highlightId = id;
			overlay.onpointerdown = (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.openEditor(id, overlay);
			};
			overlay.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.openEditor(id, overlay);
			};
			layer.appendChild(overlay);
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

	private resolveHost(group: OverlayGroup): HTMLElement | null {
		const host = this.findOpenPdfHost(group.filePath);
		if (host) {
			return host;
		}

		for (const rect of group.rects) {
			if (!rect.pageEl.isConnected) {
				continue;
			}
			const fallbackHost = rect.pageEl.closest<HTMLElement>(".workspace-leaf-content") ?? this.hostFromViewer(rect.pageEl);
			if (fallbackHost) {
				return fallbackHost;
			}
		}

		return null;
	}

	private findOpenPdfHost(filePath?: string): HTMLElement | null {
		const leaves: LeafLike[] = [];
		const workspace = this.app.workspace as typeof this.app.workspace & {
			iterateAllLeaves?: (callback: (leaf: LeafLike) => void) => void;
		};
		workspace.iterateAllLeaves?.((leaf) => leaves.push(leaf));
		if (leaves.length === 0) {
			leaves.push(...this.app.workspace.getLeavesOfType("pdf") as LeafLike[]);
		}

		for (const leaf of leaves) {
			const view = leaf.view;
			if (!view?.containerEl || !this.isPdfView(view)) {
				continue;
			}
			if (filePath && view.file?.path !== filePath) {
				continue;
			}
			const host = this.hostFromViewer(view.containerEl);
			if (host) {
				return host;
			}
		}

		const activeView = this.app.workspace.getLeaf()?.view as PdfViewLike | undefined;
		if (activeView?.containerEl && (!filePath || activeView.file?.path === filePath)) {
			return this.hostFromViewer(activeView.containerEl);
		}

		return null;
	}

	private isPdfView(view: PdfViewLike): boolean {
		const viewType = view.getViewType?.();
		const filePath = view.file?.path?.toLowerCase() ?? "";
		return viewType === "pdf" || filePath.endsWith(".pdf") || Boolean(view.containerEl?.querySelector(PDF_VIEWER_SELECTOR));
	}

	private hostFromViewer(container: HTMLElement): HTMLElement | null {
		const viewer = container.matches(PDF_VIEWER_SELECTOR)
			? container
			: container.querySelector<HTMLElement>(PDF_VIEWER_SELECTOR);
		return viewer?.closest<HTMLElement>(".workspace-leaf-content") ?? viewer ?? null;
	}

	private resolvePageElement(rect: PdfSelectionOverlayRect, host: HTMLElement): HTMLElement | null {
		const pages = Array.from(host.querySelectorAll<HTMLElement>(PAGE_SELECTOR));
		if (rect.pageNumber) {
			const page = pages.find((pageEl) => getPageNumber(pageEl) === rect.pageNumber);
			if (page) {
				return page;
			}
		}

		return rect.pageEl.isConnected && host.contains(rect.pageEl) ? rect.pageEl : null;
	}

	private ensureLayer(host: HTMLElement): HTMLElement {
		host.classList.add(HOST_CLASS);

		const existing = this.layers.get(host);
		if (existing?.isConnected) {
			return existing;
		}

		const layer = Array.from(host.children)
			.find((child): child is HTMLElement => child.instanceOf(HTMLElement) && child.classList.contains(LAYER_CLASS));
		if (layer) {
			this.layers.set(host, layer);
			return layer;
		}

		const next = host.ownerDocument.createElement("div");
		next.className = LAYER_CLASS;
		host.appendChild(next);
		this.layers.set(host, next);
		return next;
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

		if (target.instanceOf(Element) && isManagedElement(target)) {
			return false;
		}

		if (
			target.instanceOf(Element) &&
			(target.closest(PAGE_SELECTOR) || target.closest(PDF_VIEWER_SELECTOR) || target.closest(".workspace-leaf-content"))
		) {
			return true;
		}

		return changedNodes.some((node) => (
			node.instanceOf(Element) &&
			(
				node.matches(PAGE_SELECTOR) ||
				node.matches(PDF_VIEWER_SELECTOR) ||
				node.matches(".workspace-leaf-content") ||
				Boolean(node.querySelector(`${PAGE_SELECTOR}, ${PDF_VIEWER_SELECTOR}`))
			)
		));
	}

	private scheduleRerender(): void {
		if (this.renderFrame !== undefined) {
			return;
		}
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = undefined;
			this.rerenderAll();
		});
	}

	private rerenderAll(): void {
		for (const [id, group] of this.groups) {
			this.renderGroup(id, group);
		}
		this.pruneEmptyLayers();
	}

	private pruneEmptyLayers(): void {
		for (const [host, layer] of this.layers) {
			if (!host.isConnected || layer.childElementCount === 0) {
				layer.remove();
				this.layers.delete(host);
			}
		}
	}

	private ensureIcon(id: string, group: OverlayGroup): void {
		if (group.icon || group.elements.length === 0) {
			return;
		}

		const anchor = group.elements[0];
		const layer = anchor.parentElement;
		if (!layer) {
			return;
		}

		const layerRect = layer.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		const iconEl = anchor.ownerDocument.createElement("button");
		iconEl.className = NOTE_ICON_CLASS;
		iconEl.type = "button";
		iconEl.style.left = `${anchorRect.right - layerRect.left - 4}px`;
		iconEl.style.top = `${anchorRect.top - layerRect.top - 12}px`;
		iconEl.style.setProperty("--pdf-ollama-translator-highlight-color", group.color.css);
		iconEl.setAttribute("aria-label", "Highlight note");
		setIcon(iconEl, "message-square");
		iconEl.onpointerdown = (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openEditor(id, iconEl);
		};
		iconEl.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openEditor(id, iconEl);
		};
		layer.appendChild(iconEl);
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
		this.editorEl.show();
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

		this.editorEl = activeDocument.body.createDiv({ cls: "pdf-ollama-translator-highlight-note-editor" });
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
		activeDocument.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
		activeDocument.addEventListener("scroll", this.handleViewportChange, true);
		window.addEventListener("resize", this.handleViewportChange);
	}

	private handleViewportChange = (): void => {
		this.scheduleRerender();
		this.repositionEditor();
	};

	private handleDocumentPointerDown = (event: PointerEvent): void => {
		if (!this.editorEl || this.editorEl.style.display === "none") {
			return;
		}

		const target = event.target;
		const targetNode = target instanceof Node ? target : null;
		if (
			targetNode &&
			(this.editorEl.contains(targetNode) || this.activeAnchor?.contains(targetNode))
		) {
			return;
		}

		this.closeEditor();
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

function isManagedNode(node: Node): boolean {
	return node.instanceOf(Element) && isManagedElement(node);
}

function isManagedElement(element: Element): boolean {
	return (
		element.classList.contains(OVERLAY_CLASS) ||
		element.classList.contains(NOTE_ICON_CLASS) ||
		element.classList.contains(LAYER_CLASS)
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
