import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfOllamaTranslatorPlugin from "./main";
import type { TranslationLanguage, TranslationProviderId } from "./types";
import { t } from "./i18n";

export const PDF_OLLAMA_TRANSLATOR_VIEW_TYPE = "llm-translator-sidebar";

export class PdfOllamaTranslatorSidebarView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: PdfOllamaTranslatorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PDF_OLLAMA_TRANSLATOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "LLM Translator";
	}

	getIcon(): string {
		return "languages";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("pdf-ollama-translator-sidebar");

		const headerEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__header" });
		const titleEl = headerEl.createDiv({ cls: "pdf-ollama-translator-sidebar__title" });
		const iconEl = titleEl.createSpan({ cls: "pdf-ollama-translator-sidebar__title-icon" });
		setIcon(iconEl, "languages");
		titleEl.createSpan({ text: "LLM Translator" });

		const openSettingsButton = headerEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { title: t("sidebar.openSettings"), "aria-label": t("sidebar.openSettings") },
		});
		setIcon(openSettingsButton, "settings");
		openSettingsButton.onClickEvent(() => this.plugin.openSettingsTab());

		this.renderServiceControls(container);
		this.renderLanguageControls(container);
		this.renderTextPanels(container);
		this.renderBottomControls(container);
	}

	private renderServiceControls(container: HTMLElement): void {
		const rowEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__service-row" });
		const providerEl = rowEl.createEl("select", {
			cls: "pdf-ollama-translator-sidebar__select",
			attr: { title: this.plugin.getActiveProviderLabel(), "aria-label": t("sidebar.translationService") },
		});
		for (const option of [
			{ value: "local-llm", label: "Local LLM" },
			{ value: "cloud-api", label: "Cloud API" },
			{ value: "google", label: "Google" },
			{ value: "bing", label: "Bing" },
		]) {
			providerEl.createEl("option", { text: option.label, value: option.value });
		}
		providerEl.value = this.plugin.settings.translationProvider;
		providerEl.onchange = () => {
			void this.plugin.updateSettings({ translationProvider: providerEl.value as TranslationProviderId });
		};

		const testButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { title: t("sidebar.testConnection"), "aria-label": t("sidebar.testConnection") },
		});
		setIcon(testButton, "plug-zap");
		testButton.onClickEvent(async () => {
			testButton.disabled = true;
			const result = await this.plugin.testConnection();
			testButton.disabled = false;
			new Notice(result.message);
		});

		const translateButton = rowEl.createEl("button", {
			text: t("sidebar.translate"),
			cls: "pdf-ollama-translator-sidebar__primary-button",
		});
		translateButton.onClickEvent(() => void this.plugin.translateActiveSelectionFromSidebar());
	}

	private renderLanguageControls(container: HTMLElement): void {
		const rowEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__language-row" });
		const sourceEl = rowEl.createEl("select", { cls: "pdf-ollama-translator-sidebar__select" });
		for (const option of [
			{ value: "auto", label: "Auto" },
			{ value: "en", label: "English" },
			{ value: "de", label: "Deutsch" },
			{ value: "fr", label: "Français" },
			{ value: "ja", label: "日本語" },
			{ value: "zh-Hans", label: "简体中文" },
		]) {
			sourceEl.createEl("option", { text: option.label, value: option.value });
		}
		sourceEl.value = this.plugin.settings.sourceLanguage;
		sourceEl.onchange = () => {
			void this.plugin.updateSettings({ sourceLanguage: sourceEl.value as TranslationLanguage });
		};

		const swapButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { "aria-label": t("popup.swapLanguage"), title: t("popup.swapLanguage") },
		});
		setIcon(swapButton, "arrow-left-right");
		swapButton.onpointerdown = (event) => event.preventDefault();

		const targetEl = rowEl.createEl("select", { cls: "pdf-ollama-translator-sidebar__select" });
		for (const option of [
			{ value: "en", label: "English" },
			{ value: "de", label: "Deutsch" },
			{ value: "fr", label: "Français" },
			{ value: "ja", label: "日本語" },
			{ value: "zh-Hans", label: "简体中文" },
		]) {
			targetEl.createEl("option", { text: option.label, value: option.value });
		}
		targetEl.value = this.plugin.settings.targetLanguage;
		targetEl.onchange = () => {
			void this.plugin.updateSettings({
				targetLanguage: targetEl.value as Exclude<TranslationLanguage, "auto">,
			});
		};
		swapButton.onClickEvent(() => {
			if (sourceEl.value === "auto") {
				sourceEl.value = targetEl.value;
				targetEl.value = this.plugin.settings.targetLanguage;
			} else {
				const previousSource = sourceEl.value;
				sourceEl.value = targetEl.value;
				targetEl.value = previousSource;
			}
			void this.plugin.updateSettings({
				sourceLanguage: sourceEl.value as TranslationLanguage,
				targetLanguage: targetEl.value as Exclude<TranslationLanguage, "auto">,
			});
			void this.plugin.translateActiveSelectionFromSidebar();
		});
	}

	private renderTextPanels(container: HTMLElement): void {
		const state = this.plugin.getSidebarState();

		const sourceEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__panel" });
		sourceEl.setText(state.sourceText || t("sidebar.rawText"));
		sourceEl.toggleClass("is-placeholder", !state.sourceText);

		const resultEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__panel pdf-ollama-translator-sidebar__panel--result" });
		if (state.status === "loading") {
			resultEl.setText(t("sidebar.translating"));
		} else if (state.status === "error") {
			resultEl.setText(state.message || t("sidebar.translationFailed"));
			resultEl.addClass("is-error");
		} else {
			resultEl.setText(state.translatedText || t("sidebar.translation"));
			resultEl.toggleClass("is-placeholder", !state.translatedText);
		}
	}

	private renderBottomControls(container: HTMLElement): void {
		const controlsEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__controls" });

		const autoRowEl = controlsEl.createDiv({ cls: "pdf-ollama-translator-sidebar__control-row" });
		autoRowEl.createSpan({ text: t("sidebar.autoTrans"), cls: "pdf-ollama-translator-sidebar__control-label" });
		const autoToggle = autoRowEl.createEl("input", {
			cls: "pdf-ollama-translator-sidebar__toggle",
			attr: { type: "checkbox", "aria-label": t("sidebar.autoTransLabel") },
		});
		autoToggle.checked = this.plugin.settings.autoTranslateSelection;
		autoToggle.onchange = async () => {
			await this.plugin.updateSettings({ autoTranslateSelection: autoToggle.checked });
			this.render();
		};

		const selectionRowEl = controlsEl.createDiv({ cls: "pdf-ollama-translator-sidebar__control-row" });
		selectionRowEl.createSpan({ text: t("sidebar.selection"), cls: "pdf-ollama-translator-sidebar__control-label" });
		selectionRowEl.createEl("button", {
			text: t("sidebar.clear"),
			cls: "pdf-ollama-translator-sidebar__clear-button",
		}).onClickEvent(() => {
			this.plugin.clearSidebarState();
		});

		const copyRowEl = controlsEl.createDiv({ cls: "pdf-ollama-translator-sidebar__copy-row" });
		copyRowEl.createSpan({ text: t("sidebar.copy"), cls: "pdf-ollama-translator-sidebar__copy-label" });
		for (const item of [
			{ label: t("sidebar.raw"), action: () => this.plugin.copySidebarText("raw") },
			{ label: t("sidebar.result"), action: () => this.plugin.copySidebarText("result") },
			{ label: t("sidebar.both"), action: () => this.plugin.copySidebarText("both") },
		]) {
			copyRowEl.createEl("button", {
				text: item.label,
				cls: "pdf-ollama-translator-sidebar__copy-button",
			}).onClickEvent(() => void item.action());
		}
	}
}
