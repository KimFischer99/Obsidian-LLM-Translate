import { Notice, type App } from "obsidian";
import type { PdfTextSelection, HighlightColorId } from "../types";
import { t } from "../i18n";
import { getHighlightColor } from "./colors";
import { HighlightOverlay } from "./HighlightOverlay";
import { PdfAnnotationWriter } from "./PdfAnnotationWriter";
import { PdfTextLocator } from "./PdfTextLocator";
import { normalizeSelectionTextForPdf } from "./normalize";
import type { HighlightColorConfig, LocatedPdfHighlight } from "./types";

const PERSIST_DELAY_MS = 5000;
const INACTIVE_RETRY_MS = 15000;

interface HighlightEntry {
	key: string;
	location: LocatedPdfHighlight;
	color: HighlightColorConfig;
	selection: PdfTextSelection;
	note: string;
	persisted: boolean;
	timer: number | undefined;
}

export class PdfHighlightService {
	private locator: PdfTextLocator;
	private writer: PdfAnnotationWriter;
	private overlay = new HighlightOverlay();
	private entries = new Map<string, HighlightEntry>();
	private lastEntryKey = "";

	constructor(
		private app: App,
		private debug: (message: string, detail?: unknown) => void,
	) {
		this.locator = new PdfTextLocator(app, debug);
		this.writer = new PdfAnnotationWriter(app);
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
			timer: undefined,
		};
		this.entries.set(key, entry);
		this.lastEntryKey = key;
		this.overlay.render(key, selection, color, entry.note, (note) => this.updateNote(key, note));
		this.schedulePersist(entry);
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
			if (!entry.persisted && !this.isFileActive(entry.location.file.path)) {
				window.clearTimeout(entry.timer);
				void this.persist(entry);
			}
		}
	}

	flushAllPending(): void {
		for (const entry of this.entries.values()) {
			if (!entry.persisted) {
				window.clearTimeout(entry.timer);
				void this.persist(entry);
			}
		}
	}

	private removeEntry(entry: HighlightEntry, persistRemoval: boolean): void {
		window.clearTimeout(entry.timer);
		this.overlay.remove(entry.key);
		this.entries.delete(entry.key);
		if (this.lastEntryKey === entry.key) {
			this.lastEntryKey = "";
		}

		if (entry.persisted && persistRemoval) {
			this.scheduleRemoval({ ...entry, timer: undefined });
		}
	}

	private schedulePersist(entry: HighlightEntry): void {
		window.clearTimeout(entry.timer);
		entry.timer = window.setTimeout(() => {
			if (this.isFileActive(entry.location.file.path)) {
				this.scheduleInactiveRetry(entry);
				return;
			}
			void this.persist(entry);
		}, PERSIST_DELAY_MS);
	}

	private scheduleRemoval(entry: HighlightEntry): void {
		window.clearTimeout(entry.timer);
		entry.timer = window.setTimeout(() => {
			if (this.isFileActive(entry.location.file.path)) {
				this.scheduleRemovalRetry(entry);
				return;
			}
			void this.removePersisted(entry);
		}, PERSIST_DELAY_MS);
	}

	private scheduleInactiveRetry(entry: HighlightEntry): void {
		window.clearTimeout(entry.timer);
		entry.timer = window.setTimeout(() => {
			if (this.isFileActive(entry.location.file.path)) {
				this.scheduleInactiveRetry(entry);
				return;
			}
			void this.persist(entry);
		}, INACTIVE_RETRY_MS);
	}

	private scheduleRemovalRetry(entry: HighlightEntry): void {
		window.clearTimeout(entry.timer);
		entry.timer = window.setTimeout(() => {
			if (this.isFileActive(entry.location.file.path)) {
				this.scheduleRemovalRetry(entry);
				return;
			}
			void this.removePersisted(entry);
		}, INACTIVE_RETRY_MS);
	}

	private async persist(entry: HighlightEntry): Promise<void> {
		try {
			const result = await this.writer.applyHighlight(entry.location, entry.color, entry.note);
			const current = this.entries.get(entry.key);
			if (current) {
				current.persisted = true;
				current.timer = undefined;
			}
		} catch (error) {
			this.debug("PDF highlight persistence failed.", error);
		}
	}

	private async removePersisted(entry: HighlightEntry): Promise<void> {
		try {
			await this.writer.removeHighlight(entry.location);
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
		this.schedulePersist(entry);
	}

	private isFileActive(path: string): boolean {
		const view = this.app.workspace.activeLeaf?.view as { file?: { path?: string } } | undefined;
		return view?.file?.path === path;
	}
}

function getLocationKey(location: LocatedPdfHighlight): string {
	const quads = location.quads
		.map((quad) => `${quad.pageIndex}:${quad.quadPoints.map((value) => Math.round(value * 10)).join(",")}`)
		.join("|");
	return `${location.file.path}:${quads}`;
}
