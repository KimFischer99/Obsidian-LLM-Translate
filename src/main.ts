import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { getProviderLabel, TranslatorService } from "./translatorService";
import { DEFAULT_TRANSLATION_PROMPT } from "./translatorService";
import { PdfSelectionReader } from "./pdfSelection";
import { PdfOllamaTranslatorSettingTab } from "./settings";
import { PDF_OLLAMA_TRANSLATOR_VIEW_TYPE, PdfOllamaTranslatorSidebarView } from "./sidebarView";
import { TranslationPopup } from "./translationPopup";
import { t } from "./i18n";
import type {
	ConnectionTestResult,
	PdfOllamaTranslatorSettings,
	PdfTextSelection,
	SidebarTranslationState,
	TranslationResult,
} from "./types";

const DEFAULT_SETTINGS: PdfOllamaTranslatorSettings = {
	translationScope: "pdf-only",
	translationProvider: "local-llm",
	ollamaBaseUrl: "",
	model: "",
	cloudApiBaseUrl: "",
	cloudApiKey: "",
	cloudApiModel: "",
	autoTranslateSelection: true,
	enablePopup: true,
	restrictSourceLanguages: true,
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
	debounceMs: 350,
	requestTimeoutMs: 30000,
	maxSelectionChars: 2500,
	fontSize: 13,
	lineHeight: 1.6,
	rememberPopupSize: true,
	popupWidth: 360,
	popupHeight: 220,
	showCopyButton: true,
	showRetryButton: true,
	customPrompt: DEFAULT_TRANSLATION_PROMPT,
	topK: 20,
	topP: 0.6,
	repeatPenalty: 1.05,
	numPredict: 4096,
	ollamaOptionsJson: "",
	cleanModelOutput: true,
	debugLogging: false,
};

interface AppWithSetting {
	setting?: {
		open: () => void;
		openTabById: (id: string) => unknown;
	};
}

export default class PdfOllamaTranslatorPlugin extends Plugin {
	settings: PdfOllamaTranslatorSettings;
	private translator: TranslatorService;
	private selectionReader: PdfSelectionReader;
	private popup: TranslationPopup;
	private selectionTimer: number | undefined;
	private activeRequest: AbortController | undefined;
	private lastSelection: PdfTextSelection | undefined;
	private lastSelectionKey = "";
	private isPointerSelecting = false;
	private sidebarState: SidebarTranslationState = {
		sourceText: "",
		translatedText: "",
		status: "idle",
		message: "",
	};

	async onload(): Promise<void> {
		await this.loadSettings();

		this.translator = new TranslatorService(() => this.settings);
		this.selectionReader = new PdfSelectionReader(this.app, () => this.settings, this.debug);
		this.popup = new TranslationPopup({
			showCopyButton: this.settings.showCopyButton,
			showRetryButton: this.settings.showRetryButton,
			fontSize: this.settings.fontSize,
			lineHeight: this.settings.lineHeight,
			sourceLanguage: this.settings.sourceLanguage,
			targetLanguage: this.settings.targetLanguage,
			rememberSize: this.settings.rememberPopupSize,
			width: this.settings.popupWidth,
			height: this.settings.popupHeight,
			onLanguageChange: (sourceLanguage, targetLanguage) =>
				void this.updateSettings({ sourceLanguage, targetLanguage }),
			onResize: (width, height) => void this.updateSettings({ popupWidth: width, popupHeight: height }),
			onRetry: () => void this.retryLastSelection(),
		});

		this.addSettingTab(new PdfOllamaTranslatorSettingTab(this.app, this));
		this.registerSidebarView();
		this.addRibbonIcon("languages", "LLM Translator", () => {
			void this.activateSidebarView();
		});
		this.addCommand({
			id: "open-pdf-ollama-translator-sidebar",
			name: "Open LLM Translator sidebar",
			callback: () => void this.activateSidebarView(),
		});
		this.registerSelectionEvents();
	}

	onunload(): void {
		this.cancelActiveRequest();
		window.clearTimeout(this.selectionTimer);
		this.popup?.destroy();
	}

	async updateSettings(partial: Partial<PdfOllamaTranslatorSettings>): Promise<void> {
		this.settings = { ...this.settings, ...partial };
		await this.saveSettings();
		this.syncPopupOptions();
		this.refreshSidebarViews();
	}

	async updateNumberSetting(
		key: keyof Pick<
			PdfOllamaTranslatorSettings,
			"debounceMs" | "fontSize" | "maxSelectionChars" | "numPredict" | "requestTimeoutMs" | "topK"
		>,
		value: string,
		min: number,
		max: number,
	): Promise<void> {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isFinite(parsed)) {
			return;
		}

		const nextValue = Math.min(Math.max(parsed, min), max);
		await this.updateSettings({ [key]: nextValue });
	}

	async updateFloatSetting(
		key: keyof Pick<PdfOllamaTranslatorSettings, "lineHeight" | "repeatPenalty" | "topP">,
		value: string,
		min: number,
		max: number,
	): Promise<void> {
		const parsed = Number.parseFloat(value);
		if (!Number.isFinite(parsed)) {
			return;
		}

		const nextValue = Math.min(Math.max(parsed, min), max);
		await this.updateSettings({ [key]: nextValue });
	}

	async testConnection(): Promise<ConnectionTestResult> {
		const result = await this.translator.testConnection();
		this.debug("Connection test result.", result);
		return result;
	}

	async listModels(): Promise<string[]> {
		return this.translator.listModels();
	}

	getActiveProviderLabel(): string {
		return getProviderLabel(this.settings.translationProvider);
	}

	getSidebarState(): SidebarTranslationState {
		return { ...this.sidebarState };
	}

	clearSidebarState(): void {
		this.sidebarState = {
			sourceText: "",
			translatedText: "",
			status: "idle",
			message: "",
		};
		this.refreshSidebarViews();
	}

	async copySidebarText(mode: "raw" | "result" | "both"): Promise<void> {
		const { sourceText, translatedText } = this.sidebarState;
		const value =
			mode === "raw"
				? sourceText
				: mode === "result"
					? translatedText
					: [sourceText, translatedText].filter(Boolean).join("\n\n");

		if (!value) {
			new Notice(t("notice.nothingToCopy"));
			return;
		}

		await navigator.clipboard.writeText(value);
		new Notice(t("notice.copied"));
	}

	async translateActiveSelectionFromSidebar(): Promise<void> {
		const selection = this.selectionReader.readSelection();
		if (!selection) {
			new Notice(t("notice.selectTextFirst"));
			return;
		}
		await this.translateSelection(selection, true);
	}

	openSettingsTab(): void {
		const setting = (this.app as AppWithSetting).setting;
		if (!setting) {
			new Notice(t("notice.cannotOpenSettings"));
			return;
		}
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private registerSidebarView(): void {
		this.registerView(
			PDF_OLLAMA_TRANSLATOR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new PdfOllamaTranslatorSidebarView(leaf, this),
		);
	}

	private async activateSidebarView(): Promise<void> {
		this.popup.hide();
		const existingLeaves = this.app.workspace.getLeavesOfType(PDF_OLLAMA_TRANSLATOR_VIEW_TYPE);
		if (existingLeaves.length > 0) {
			this.app.workspace.revealLeaf(existingLeaves[0]);
			return;
		}

		const leaf = this.app.workspace.getLeftLeaf(false);
		if (!leaf) {
			new Notice(t("notice.cannotOpenSidebar"));
			return;
		}
		await leaf.setViewState({ type: PDF_OLLAMA_TRANSLATOR_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private registerSelectionEvents(): void {
		this.registerDomEvent(document, "pointerdown", (event) => this.handleDocumentPointerDown(event), true);
		this.registerDomEvent(document, "selectionchange", () => this.handleSelectionChange());
		this.registerDomEvent(document, "mouseup", () => this.finishPointerSelection());
		this.registerDomEvent(document, "keyup", () => this.scheduleSelectionTranslation());
		this.registerDomEvent(window, "resize", () => this.popup.reposition());
		this.registerDomEvent(document, "scroll", () => this.popup.reposition(), true);
	}

	private handleDocumentPointerDown(event: MouseEvent): void {
		if (this.popup.containsTarget(event.target)) {
			return;
		}

		this.hidePopup();
		this.isPointerSelecting = true;
		window.clearTimeout(this.selectionTimer);
	}

	private handleSelectionChange(): void {
		if (this.isPointerSelecting) {
			return;
		}
		this.scheduleSelectionTranslation();
	}

	private finishPointerSelection(): void {
		if (!this.isPointerSelecting) {
			return;
		}
		this.isPointerSelecting = false;
		this.scheduleSelectionTranslation();
	}

	private scheduleSelectionTranslation(): void {
		window.clearTimeout(this.selectionTimer);
		if (!this.settings.autoTranslateSelection) {
			return;
		}

		this.selectionTimer = window.setTimeout(
			() => void this.translateCurrentSelection(),
			this.settings.debounceMs,
		);
	}

	private async translateCurrentSelection(): Promise<void> {
		const selection = this.selectionReader.readSelection();
		if (!selection) {
			return;
		}

		if (this.selectionReader.isSelectionTooLong(selection)) {
			this.popup.showInfo(
				selection.text,
				t("notice.selectionExceedsLimit", { count: this.settings.maxSelectionChars }),
				selection.rect,
			);
			return;
		}

		await this.translateSelection(selection, false);
	}

	private async retryLastSelection(): Promise<void> {
		if (!this.lastSelection) {
			new Notice(t("notice.noSelectionToRetry"));
			return;
		}
		await this.translateSelection(this.lastSelection, true);
	}

	private async translateSelection(selection: PdfTextSelection, force: boolean): Promise<void> {
		const missingConfigMessage = this.getMissingProviderConfigMessage();
		if (missingConfigMessage) {
			if (this.isSidebarVisible()) {
				this.updateSidebarState({
					sourceText: selection.text,
					translatedText: "",
					status: "error",
					message: missingConfigMessage,
				});
			} else {
				this.popup.showError(selection.text, missingConfigMessage, selection.rect);
			}
			return;
		}

		const selectionKey = `${selection.text}:${Math.round(selection.rect.left)}:${Math.round(selection.rect.top)}`;
		if (!force && selectionKey === this.lastSelectionKey) {
			return;
		}

		this.lastSelection = selection;
		this.lastSelectionKey = selectionKey;
		this.cancelActiveRequest();

		const request = new AbortController();
		this.activeRequest = request;
		const showPopup = !this.isSidebarVisible();
		const shouldShowPopup = showPopup && this.settings.enablePopup;
		if (shouldShowPopup) {
			this.popup.showLoading(selection.text, selection.rect);
		} else {
			this.popup.hide();
		}
		this.updateSidebarState({
			sourceText: selection.text,
			translatedText: "",
			status: "loading",
			message: "",
		});
		this.debug("Translating PDF selection.", {
			length: selection.text.length,
			provider: this.settings.translationProvider,
			model: this.getActiveModelName(),
		});

		try {
			const result = await this.translator.translate({
				text: selection.text,
				sourceLanguage: this.settings.sourceLanguage,
				targetLanguage: this.settings.targetLanguage,
				allowedSourceLanguages: ["en", "de", "fr", "ja", "zh-Hans"],
				signal: request.signal,
			});
			if (!request.signal.aborted) {
				if (shouldShowPopup) {
					this.showTranslationResult(result, selection.rect);
				}
				this.updateSidebarState({
					sourceText: result.sourceText,
					translatedText: result.translatedText,
					status: "success",
					message: "",
				});
			}
		} catch (error) {
			if (request.signal.aborted) {
				return;
			}

			const message = this.translator.toReadableError(error);
			this.debug("Translation failed.", error);
			if (shouldShowPopup) {
				this.popup.showError(selection.text, message, selection.rect);
			}
			this.updateSidebarState({
				sourceText: selection.text,
				translatedText: "",
				status: "error",
				message,
			});
		} finally {
			if (this.activeRequest === request) {
				this.activeRequest = undefined;
			}
		}
	}

	private showTranslationResult(result: TranslationResult, rect: DOMRect): void {
		this.popup.showResult(result, rect);
	}

	private getMissingProviderConfigMessage(): string {
		if (this.settings.translationProvider === "local-llm" && !this.settings.model.trim()) {
			return t("error.selectLocalModel");
		}
		if (this.settings.translationProvider === "cloud-api") {
			if (!this.settings.cloudApiKey.trim()) {
				return t("error.fillApiKey");
			}
			if (!this.settings.cloudApiModel.trim()) {
				return t("error.fillModelName");
			}
		}
		return "";
	}

	private getActiveModelName(): string {
		if (this.settings.translationProvider === "cloud-api") {
			return this.settings.cloudApiModel;
		}
		if (this.settings.translationProvider === "local-llm") {
			return this.settings.model;
		}
		return getProviderLabel(this.settings.translationProvider);
	}

	private hidePopup(): void {
		this.cancelActiveRequest();
		this.popup.hide();
		this.lastSelectionKey = "";
	}

	private cancelActiveRequest(): void {
		if (this.activeRequest) {
			this.activeRequest.abort();
			this.activeRequest = undefined;
		}
	}

	private syncPopupOptions(): void {
		this.popup.updateOptions({
			showCopyButton: this.settings.showCopyButton,
			showRetryButton: this.settings.showRetryButton,
			fontSize: this.settings.fontSize,
			lineHeight: this.settings.lineHeight,
			sourceLanguage: this.settings.sourceLanguage,
			targetLanguage: this.settings.targetLanguage,
			rememberSize: this.settings.rememberPopupSize,
			width: this.settings.popupWidth,
			height: this.settings.popupHeight,
			onLanguageChange: (sourceLanguage, targetLanguage) =>
				void this.updateSettings({ sourceLanguage, targetLanguage }),
			onResize: (width, height) => void this.updateSettings({ popupWidth: width, popupHeight: height }),
			onRetry: () => void this.retryLastSelection(),
		});
	}

	private updateSidebarState(nextState: SidebarTranslationState): void {
		this.sidebarState = nextState;
		this.refreshSidebarViews();
	}

	private refreshSidebarViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(PDF_OLLAMA_TRANSLATOR_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof PdfOllamaTranslatorSidebarView) {
				view.refresh();
			}
		}
	}

	private isSidebarVisible(): boolean {
		return this.app.workspace
			.getLeavesOfType(PDF_OLLAMA_TRANSLATOR_VIEW_TYPE)
			.some((leaf) => {
				if (!(leaf.view instanceof PdfOllamaTranslatorSidebarView)) {
					return false;
				}

				const viewEl = leaf.view.containerEl;
				const leafEl = viewEl.closest<HTMLElement>(".workspace-leaf");
				if (leafEl && !leafEl.classList.contains("mod-active")) {
					return false;
				}

				const visibleEl = leafEl ?? viewEl;
				const rect = visibleEl.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && getComputedStyle(visibleEl).display !== "none";
			});
	}

	private async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Partial<PdfOllamaTranslatorSettings> & { translationProvider?: string };
		const loadedProvider = (loaded as { translationProvider?: string }).translationProvider;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded, {
			cloudApiBaseUrl: loaded.cloudApiBaseUrl ?? DEFAULT_SETTINGS.cloudApiBaseUrl,
			cloudApiKey: loaded.cloudApiKey ?? DEFAULT_SETTINGS.cloudApiKey,
			cloudApiModel: loaded.cloudApiModel ?? DEFAULT_SETTINGS.cloudApiModel,
			translationProvider: loadedProvider ?? DEFAULT_SETTINGS.translationProvider,
		});
	}

	private async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private debug = (message: string, detail?: unknown): void => {
		if (!this.settings.debugLogging) {
			return;
		}
		console.debug("[LLM Translator]", message, detail ?? "");
	};
}
