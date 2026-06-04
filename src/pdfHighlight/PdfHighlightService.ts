import { Notice, type App } from "obsidian";
import type { PdfTextSelection, HighlightColorId } from "../types";
import { t } from "../i18n";
import { getHighlightColor } from "./colors";
import { HighlightOverlay } from "./HighlightOverlay";
import { PdfAnnotationWriter } from "./PdfAnnotationWriter";
import { PdfTextLocator } from "./PdfTextLocator";
import { normalizeSelectionTextForPdf } from "./normalize";
import type { HighlightColorConfig, LocatedPdfHighlight } from "./types";

interface HighlightEntry {
	key: string;
	location: LocatedPdfHighlight;
	color: HighlightColorConfig;
	selection: PdfTextSelection;
	note: string;
	persisted: boolean;
}

export class PdfHighlightService {
	private locator: PdfTextLocator;
	private writer: PdfAnnotationWriter;
	private overlay: HighlightOverlay;
	private entries = new Map<string, HighlightEntry>();
	private pendingRemovals = new Map<string, HighlightEntry>();
	private lastEntryKey = "";

	constructor(
		private app: App,
		private debug: (message: string, detail?: unknown) => void,
	) {
		this.locator = new PdfTextLocator(app, debug);
		this.writer = new PdfAnnotationWriter(app);
		this.overlay = new HighlightOverlay(app);
	}

	async toggleSelectionHighlight(selection: PdfTextSelection, colorId: HighlightColorId): Promise<void> {
		if (!selection.file || !selection.file.path.toLowerCase().endsWith(".pdf")) {
			new Notice(t("notice.highlightPdfOnly"));
			return;
		}

		const color = getHighlightColor(colorId);
		const location = await this.locator.locate(selection.file, selection.text, selection.pageHint);
		if (!location || location.quads.length === 0) {
			new Notice(t("notice.highlightNotFound"));
			return;
		}

		const key = getLocationKey(location);
		const existing = this.entries.get(key);
		if (existing && existing.color.id === color.id) {
			this.removeEntry(existing, true);
			return;
		}

		if (existing) {
			this.removeEntry(existing, false);
		}

		const entry: HighlightEntry = {
			key,
			location,
			color,
			selection,
			note: "",
			persisted: false,
		};
		this.entries.set(key, entry);
		this.pendingRemovals.delete(key);
		this.lastEntryKey = key;
		this.overlay.render(key, selection, color, entry.note, (note) => this.updateNote(key, note));
	}

	canUndoSelection(selection: PdfTextSelection | null): boolean {
		const entry = this.entries.get(this.lastEntryKey);
		if (!entry || !selection?.file || !entry.selection.file) {
			return false;
		}
		return (
			entry.selection.file.path === selection.file.path &&
			normalizeSelectionTextForPdf(entry.selection.text) === normalizeSelectionTextForPdf(selection.text)
		);
	}

	undoLastHighlight(): boolean {
		const entry = this.entries.get(this.lastEntryKey);
		if (!entry) {
			return false;
		}
		this.removeEntry(entry, true);
		return true;
	}

	flushPendingForInactiveViews(): void {
		for (const entry of this.entries.values()) {
			if (!entry.persisted && !this.isFileOpen(entry.location.file.path)) {
				void this.persist(entry);
			}
		}

		for (const [key, entry] of this.pendingRemovals) {
			if (!this.isFileOpen(entry.location.file.path)) {
				void this.removePersisted(key, entry);
			}
		}
	}

	flushAllPending(): void {
		for (const entry of this.entries.values()) {
			if (!entry.persisted) {
				void this.persist(entry);
			}
		}

		for (const [key, entry] of this.pendingRemovals) {
			void this.removePersisted(key, entry);
		}
	}

	refreshOverlays(): void {
		this.overlay.refresh();
	}

	destroy(): void {
		this.overlay.destroy();
	}

	private removeEntry(entry: HighlightEntry, persistRemoval: boolean): void {
		this.overlay.remove(entry.key);
		this.entries.delete(entry.key);
		if (this.lastEntryKey === entry.key) {
			this.lastEntryKey = "";
		}

		if (entry.persisted && persistRemoval) {
			this.pendingRemovals.set(entry.key, entry);
		}
	}

	private async persist(entry: HighlightEntry): Promise<void> {
		try {
			await this.writer.applyHighlight(entry.location, entry.color, entry.note);
			const current = this.entries.get(entry.key);
			if (current) {
				current.persisted = true;
				if (!this.isFileOpen(current.location.file.path)) {
					this.overlay.remove(current.key);
					this.entries.delete(current.key);
				}
			}
		} catch (error) {
			this.debug("PDF highlight persistence failed.", error);
		}
	}

	private async removePersisted(key: string, entry: HighlightEntry): Promise<void> {
		try {
			await this.writer.removeHighlight(entry.location);
			this.pendingRemovals.delete(key);
		} catch (error) {
			this.debug("PDF highlight removal failed.", error);
		}
	}

	private updateNote(key: string, note: string): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		entry.note = note;
		entry.persisted = false;
		this.overlay.updateNote(key, note);
	}

	private isFileOpen(path: string): boolean {
		const leaves: Array<{ view?: { file?: { path?: string } | null } }> = [];
		const workspace = this.app.workspace as unknown as {
			iterateAllLeaves?: (callback: (leaf: { view?: { file?: { path?: string } | null } }) => void) => void;
		};
		workspace.iterateAllLeaves?.((leaf) => leaves.push(leaf));
		if (leaves.length === 0) {
			leaves.push(...this.app.workspace.getLeavesOfType("pdf") as unknown as Array<{ view?: { file?: { path?: string } | null } }>);
		}

		return leaves.some((leaf) => leaf.view?.file?.path === path);
	}
}

function getLocationKey(location: LocatedPdfHighlight): string {
	const quads = location.quads
		.map((quad) => `${quad.pageIndex}:${quad.quadPoints.map((value) => Math.round(value * 10)).join(",")}`)
		.join("|");
	return `${location.file.path}:${quads}`;
}
