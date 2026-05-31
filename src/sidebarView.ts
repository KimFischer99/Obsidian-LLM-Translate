import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfOllamaTranslatorPlugin from "./main";
import type { TranslationLanguage } from "./types";

export const PDF_OLLAMA_TRANSLATOR_VIEW_TYPE = "pdf-ollama-translator-sidebar";

export class PdfOllamaTranslatorSidebarView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: PdfOllamaTranslatorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PDF_OLLAMA_TRANSLATOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "LLM Translate";
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
		titleEl.createSpan({ text: "Translate" });

		const openSettingsButton = headerEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { title: "打开详细设置", "aria-label": "打开详细设置" },
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
		rowEl.createDiv({
			text: "Local LLM",
			cls: "pdf-ollama-translator-sidebar__service-label",
			attr: { title: this.plugin.settings.model || "模型请在详细设置中配置" },
		});

		const testButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { title: "测试连接", "aria-label": "测试连接" },
		});
		setIcon(testButton, "plug-zap");
		testButton.onClickEvent(async () => {
			testButton.disabled = true;
			const result = await this.plugin.testConnection();
			testButton.disabled = false;
			new Notice(result.message);
		});

		const translateButton = rowEl.createEl("button", {
			text: "Translate",
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

		const arrowEl = rowEl.createSpan({ text: "→", cls: "pdf-ollama-translator-sidebar__arrow" });
		arrowEl.ariaHidden = "true";

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
	}

	private renderTextPanels(container: HTMLElement): void {
		const state = this.plugin.getSidebarState();

		const sourceEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__panel" });
		sourceEl.setText(state.sourceText || "Raw text");
		sourceEl.toggleClass("is-placeholder", !state.sourceText);

		const resultEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__panel pdf-ollama-translator-sidebar__panel--result" });
		if (state.status === "loading") {
			resultEl.setText("翻译中...");
		} else if (state.status === "error") {
			resultEl.setText(state.message || "翻译失败。");
			resultEl.addClass("is-error");
		} else {
			resultEl.setText(state.translatedText || "Translation");
			resultEl.toggleClass("is-placeholder", !state.translatedText);
		}
	}

	private renderBottomControls(container: HTMLElement): void {
		const controlsEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__controls" });

		const autoRowEl = controlsEl.createDiv({ cls: "pdf-ollama-translator-sidebar__control-row" });
		autoRowEl.createSpan({ text: "Auto-Trans", cls: "pdf-ollama-translator-sidebar__control-label" });
		const autoToggle = autoRowEl.createEl("input", {
			cls: "pdf-ollama-translator-sidebar__toggle",
			attr: { type: "checkbox", "aria-label": "自动翻译选区" },
		});
		autoToggle.checked = this.plugin.settings.autoTranslateSelection;
		autoToggle.onchange = async () => {
			await this.plugin.updateSettings({ autoTranslateSelection: autoToggle.checked });
			this.render();
		};

		const selectionRowEl = controlsEl.createDiv({ cls: "pdf-ollama-translator-sidebar__control-row" });
		selectionRowEl.createSpan({ text: "Selection", cls: "pdf-ollama-translator-sidebar__control-label" });
		selectionRowEl.createEl("button", {
			text: "Clear",
			cls: "pdf-ollama-translator-sidebar__clear-button",
		}).onClickEvent(() => {
			this.plugin.clearSidebarState();
		});

		const copyRowEl = controlsEl.createDiv({ cls: "pdf-ollama-translator-sidebar__copy-row" });
		copyRowEl.createSpan({ text: "Copy:", cls: "pdf-ollama-translator-sidebar__copy-label" });
		for (const item of [
			{ label: "Raw", action: () => this.plugin.copySidebarText("raw") },
			{ label: "Result", action: () => this.plugin.copySidebarText("result") },
			{ label: "Both", action: () => this.plugin.copySidebarText("both") },
		]) {
			copyRowEl.createEl("button", {
				text: item.label,
				cls: "pdf-ollama-translator-sidebar__copy-button",
			}).onClickEvent(() => void item.action());
		}
	}
}
