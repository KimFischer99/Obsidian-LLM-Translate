import type { App, TFile } from "obsidian";
import type { PdfOllamaTranslatorSettings, PdfTextSelection } from "./types";

interface PdfLikeView {
	containerEl: HTMLElement;
	file?: TFile | null;
	getViewType(): string;
}

interface MarkdownLikeView {
	containerEl: HTMLElement;
	file?: TFile | null;
	getViewType(): string;
	editor?: {
		getSelection(): string;
		somethingSelected(): boolean;
	};
}

interface SelectionWithContext {
	selection: Selection;
	rectOffset?: DOMRect;
}

const PDF_CONTAINER_SELECTORS = [
	".pdf-viewer",
	".pdfViewer",
	".pdf-container",
	".pdf-embed",
	".mod-pdf",
	".document-container",
	".textLayer",
];

export class PdfSelectionReader {
	constructor(
		private app: App,
		private getSettings: () => PdfOllamaTranslatorSettings,
		private debug: (message: string, detail?: unknown) => void,
	) {}

	readSelection(): PdfTextSelection | null {
		const settings = this.getSettings();
		const container = settings.translationScope === "global"
			? this.getActiveContainer()
			: this.getActivePdfContainer();
		if (!container) {
			return null;
		}

		const selectionContext = this.getSelectionContext(container);
		if (!selectionContext) {
			return null;
		}

		const selection = selectionContext.selection;
		if (selection.rangeCount === 0 || selection.isCollapsed) {
			return null;
		}

		const text = normalizeSelectionText(selection.toString());
		if (!text) {
			return null;
		}

		if (text.length > settings.maxSelectionChars) {
			const rect = this.getSelectionRect(selection, selectionContext.rectOffset);
			return rect ? { text, rect } : null;
		}

		if (settings.restrictSourceLanguages && !isLikelySupportedSourceText(text, settings.sourceLanguage)) {
			this.debug("Selection skipped because it does not look like a supported source language.");
			return null;
		}

		const rect = this.getSelectionRect(selection, selectionContext.rectOffset);
		return rect ? { text, rect } : null;
	}

	isSelectionTooLong(selection: PdfTextSelection): boolean {
		return selection.text.length > this.getSettings().maxSelectionChars;
	}

	private getActivePdfContainer(): HTMLElement | null {
		const activeLeaf = this.app.workspace.activeLeaf;
		const view = activeLeaf?.view as PdfLikeView | undefined;
		if (!view?.containerEl || !this.isPdfView(view)) {
			return null;
		}

		const innerPdfContainer = PDF_CONTAINER_SELECTORS
			.map((selector) => view.containerEl.querySelector<HTMLElement>(selector))
			.find((element): element is HTMLElement => Boolean(element));

		return innerPdfContainer ?? view.containerEl;
	}

	private getActiveContainer(): HTMLElement | null {
		// Try PDF first
		const pdfContainer = this.getActivePdfContainer();
		if (pdfContainer) {
			return pdfContainer;
		}

		// Then try Markdown
		return this.getActiveMarkdownContainer();
	}

	private getActiveMarkdownContainer(): HTMLElement | null {
		const activeLeaf = this.app.workspace.activeLeaf;
		const view = activeLeaf?.view as MarkdownLikeView | undefined;
		if (!view?.containerEl || view.getViewType() !== "markdown") {
			return null;
		}

		// Return the view's content element which contains the editor
		return view.containerEl;
	}

	private isPdfView(view: PdfLikeView): boolean {
		const viewType = view.getViewType();
		if (viewType === "pdf") {
			return true;
		}

		const filePath = view.file?.path?.toLowerCase() ?? "";
		if (filePath.endsWith(".pdf")) {
			return true;
		}

		return PDF_CONTAINER_SELECTORS.some((selector) => view.containerEl.querySelector(selector));
	}

	private getSelectionContext(container: HTMLElement): SelectionWithContext | null {
		const documentSelection = document.getSelection();
		if (
			documentSelection &&
			documentSelection.rangeCount > 0 &&
			this.selectionBelongsToContainer(documentSelection, container)
		) {
			return { selection: documentSelection };
		}

		const iframeSelection = this.getIframeSelection(container);
		return iframeSelection;
	}

	private selectionBelongsToContainer(selection: Selection, container: HTMLElement): boolean {
		if (selection.rangeCount === 0) {
			return false;
		}

		const range = selection.getRangeAt(0);
		const ancestor = range.commonAncestorContainer;
		return container.contains(ancestor);
	}

	private getIframeSelection(container: HTMLElement): SelectionWithContext | null {
		const frames = Array.from(container.querySelectorAll("iframe"));
		for (const frame of frames) {
			try {
				const frameWindow = frame.contentWindow;
				const frameSelection = frameWindow?.getSelection();
				if (!frameWindow || !frameSelection || frameSelection.rangeCount === 0 || frameSelection.isCollapsed) {
					continue;
				}
				return {
					selection: frameSelection,
					rectOffset: frame.getBoundingClientRect(),
				};
			} catch (error) {
				this.debug("Could not inspect PDF iframe selection.", error);
			}
		}

		return null;
	}

	private getSelectionRect(selection: Selection, offset?: DOMRect): DOMRect | null {
		if (selection.rangeCount === 0) {
			return null;
		}

		const range = selection.getRangeAt(0);
		const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
		const baseRect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
		if (baseRect.width === 0 && baseRect.height === 0) {
			return null;
		}

		if (!offset) {
			return baseRect;
		}

		return new DOMRect(
			baseRect.x + offset.x,
			baseRect.y + offset.y,
			baseRect.width,
			baseRect.height,
		);
	}
}

function normalizeSelectionText(value: string): string {
	const normalized = value
		.replace(/\r\n?/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/([A-Za-zÀ-ÖØ-öø-ÿ])-\n(?=[A-Za-zÀ-ÖØ-öø-ÿ])/g, "$1")
		.replace(/([\u3040-\u30ff\u3400-\u9fff])\n(?=[\u3040-\u30ff\u3400-\u9fff])/g, "$1")
		.replace(/\n{2,}/g, "\n\n")
		.trim();

	return normalized
		.split(/\n\n+/)
		.map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim())
		.filter(Boolean)
		.join("\n\n");
}

function isLikelySupportedSourceText(value: string, sourceLanguage: PdfOllamaTranslatorSettings["sourceLanguage"]): boolean {
	const withoutWhitespace = value.replace(/\s/g, "");
	if (!withoutWhitespace) {
		return false;
	}

	if (sourceLanguage === "zh-Hans") {
		return /[\u3400-\u9fff]/.test(value);
	}

	if (sourceLanguage === "ja") {
		return /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
	}

	if (sourceLanguage === "en" || sourceLanguage === "de" || sourceLanguage === "fr") {
		return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value);
	}

	return /[A-Za-zÀ-ÖØ-öø-ÿ\u3040-\u30ff\u3400-\u9fff]/.test(value);
}
