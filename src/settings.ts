import { App, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type PdfOllamaTranslatorPlugin from "./main";
import { DEFAULT_TRANSLATION_PROMPT } from "./translatorService";
import type { TranslationLanguage, TranslationProviderId } from "./types";

const SOURCE_LANGUAGE_OPTIONS: Array<{ value: TranslationLanguage; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "en", label: "English" },
	{ value: "de", label: "Deutsch" },
	{ value: "fr", label: "Français" },
	{ value: "ja", label: "日本語" },
	{ value: "zh-Hans", label: "简体中文" },
];

const TARGET_LANGUAGE_OPTIONS: Array<{ value: Exclude<TranslationLanguage, "auto">; label: string }> = [
	{ value: "en", label: "English" },
	{ value: "de", label: "Deutsch" },
	{ value: "fr", label: "Français" },
	{ value: "ja", label: "日本語" },
	{ value: "zh-Hans", label: "简体中文" },
];

export class PdfOllamaTranslatorSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PdfOllamaTranslatorPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("pdf-ollama-translator-settings");

		containerEl.createEl("h2", { text: "LLM Translate" });

		this.addSection("常规");
		new Setting(containerEl)
			.setName("自动翻译选中文本")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoTranslateSelection)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ autoTranslateSelection: value });
					}),
			);

		new Setting(containerEl)
			.setName("启用阅读器划词弹窗")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enablePopup)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ enablePopup: value });
					}),
			);

		this.addSection("服务");
		new Setting(containerEl)
			.setName("翻译服务")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("local-llm", "Local LLM")
					.addOption("cloud-api", "Cloud API")
					.addOption("google", "Google")
					.addOption("bing", "Bing")
					.setValue(this.plugin.settings.translationProvider)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ translationProvider: value as TranslationProviderId });
						this.display();
					}),
			);

		if (this.plugin.settings.translationProvider === "local-llm") {
			this.renderLocalServiceSettings(containerEl);
		} else if (this.plugin.settings.translationProvider === "cloud-api") {
			this.renderCloudServiceSettings(containerEl);
		} else {
			this.renderDirectServiceSettings(containerEl);
		}

		new Setting(containerEl)
			.setName("源语言")
			.addDropdown((dropdown) => {
				for (const option of SOURCE_LANGUAGE_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				return dropdown
					.setValue(this.plugin.settings.sourceLanguage)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ sourceLanguage: value as TranslationLanguage });
					});
			});

		new Setting(containerEl)
			.setName("目标语言")
			.addDropdown((dropdown) => {
				for (const option of TARGET_LANGUAGE_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				return dropdown
					.setValue(this.plugin.settings.targetLanguage)
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							targetLanguage: value as Exclude<TranslationLanguage, "auto">,
						});
					});
			});

		this.addSection("界面");
		new Setting(containerEl)
			.setName("字体大小")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "10";
				text
					.setValue(String(this.plugin.settings.fontSize))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("fontSize", value, 10, 24);
					});
			});

		new Setting(containerEl)
			.setName("行高")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.step = "0.1";
				text
					.setValue(String(this.plugin.settings.lineHeight))
					.onChange(async (value) => {
						await this.plugin.updateFloatSetting("lineHeight", value, 1, 2.4);
					});
			});

		new Setting(containerEl)
			.setName("记住窗口大小")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.rememberPopupSize)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ rememberPopupSize: value });
					}),
			);

		new Setting(containerEl)
			.setName("显示复制按钮")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCopyButton)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ showCopyButton: value });
					}),
			);

		new Setting(containerEl)
			.setName("显示重新翻译按钮")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRetryButton)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ showRetryButton: value });
					}),
			);

		this.addSection("高级");
		new Setting(containerEl)
			.setName("最大选区长度")
			.setDesc("超过该字符数的选区不会发送翻译请求。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.maxSelectionChars))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("maxSelectionChars", value, 1, 20000);
					});
			});

		new Setting(containerEl)
			.setName("选区触发延迟")
			.setDesc("完成选中文本后等待多久开始翻译，单位为毫秒。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("debounceMs", value, 0, 5000);
					});
			});

		new Setting(containerEl)
			.setName("请求超时")
			.setDesc("等待本地模型返回的最长时间，单位为毫秒。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1000";
				text
					.setValue(String(this.plugin.settings.requestTimeoutMs))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("requestTimeoutMs", value, 1000, 300000);
					});
			});

		new Setting(containerEl)
			.setName("自定义 Prompt")
			.setDesc("默认 Prompt 已填入此处，可直接修改保存。")
			.addTextArea((text) => {
				text.inputEl.rows = 5;
				text.inputEl.addClass("pdf-ollama-translator-settings__textarea");
				text
					.setPlaceholder(DEFAULT_TRANSLATION_PROMPT)
					.setValue(this.plugin.settings.customPrompt || DEFAULT_TRANSLATION_PROMPT)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ customPrompt: value });
					});
			});

		if (this.plugin.settings.translationProvider === "local-llm") {
			this.renderLocalAdvancedSettings(containerEl);
		}

		new Setting(containerEl)
			.setName("清理译文中的空行、thinking 和多余文本")
			.setDesc("自动移除引号、代码块、翻译标签和 thinking 残留。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.cleanModelOutput)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cleanModelOutput: value });
					}),
			);

		new Setting(containerEl)
			.setName("调试日志")
			.setDesc("在开发者控制台输出请求状态和错误摘要。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLogging)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ debugLogging: value });
					}),
			);
	}

	private renderLocalServiceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("本地模型端口")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:11434")
					.setValue(this.plugin.settings.ollamaBaseUrl)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ ollamaBaseUrl: value.trim() });
					}),
			);

		let modelDropdown: DropdownComponent | undefined;
		new Setting(containerEl)
			.setName("模型名称")
			.addDropdown((dropdown) => {
				modelDropdown = dropdown;
				dropdown.addOption("", "选择模型");
				if (this.plugin.settings.model) {
					dropdown.addOption(this.plugin.settings.model, this.plugin.settings.model);
				}
				return dropdown
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ model: value });
					});
			})
			.addButton((button) => this.bindTestButton(button));
		if (modelDropdown) {
			void this.populateModelDropdown(modelDropdown);
		}
	}

	private renderCloudServiceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("API 类型")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("openai-compatible", "OpenAI Compatible")
					.setValue("openai-compatible"),
			);

		new Setting(containerEl)
			.setName("API 地址")
			.addText((text) =>
				text
					.setPlaceholder("https://api.deepseek.com")
					.setValue(this.plugin.settings.cloudApiBaseUrl)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cloudApiBaseUrl: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName("API Key")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.cloudApiKey)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cloudApiKey: value.trim() });
					});
			});

		new Setting(containerEl)
			.setName("模型名称")
			.addText((text) =>
				text
					.setPlaceholder("deepseek-chat")
					.setValue(this.plugin.settings.cloudApiModel)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cloudApiModel: value.trim() });
					}),
			)
			.addButton((button) => this.bindTestButton(button));
	}

	private renderDirectServiceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("连接测试")
			.addButton((button) => this.bindTestButton(button));
	}

	private renderLocalAdvancedSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Top K")
			.setDesc("限制候选 token 数量。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.topK))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("topK", value, 1, 1000);
					});
			});

		new Setting(containerEl)
			.setName("Top P")
			.setDesc("控制 nucleus sampling 范围。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "1";
				text.inputEl.step = "0.05";
				text
					.setValue(String(this.plugin.settings.topP))
					.onChange(async (value) => {
						await this.plugin.updateFloatSetting("topP", value, 0, 1);
					});
			});

		new Setting(containerEl)
			.setName("Repeat Penalty")
			.setDesc("降低重复输出的概率。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.step = "0.01";
				text
					.setValue(String(this.plugin.settings.repeatPenalty))
					.onChange(async (value) => {
						await this.plugin.updateFloatSetting("repeatPenalty", value, 0, 3);
					});
			});

		new Setting(containerEl)
			.setName("Num Predict")
			.setDesc("单次请求允许生成的最大 token 数。")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.numPredict))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("numPredict", value, 1, 32768);
					});
			});
	}

	private bindTestButton(button: import("obsidian").ButtonComponent): import("obsidian").ButtonComponent {
		return button
			.setButtonText("测试")
			.onClick(async () => {
				button.setDisabled(true).setButtonText("测试中...");
				const result = await this.plugin.testConnection();
				button.setDisabled(false).setButtonText("测试");
				new Notice(result.message);
			});
	}

	private async populateModelDropdown(dropdown: DropdownComponent): Promise<void> {
		try {
			const currentModel = this.plugin.settings.model;
			const models = await this.plugin.listModels();
			dropdown.selectEl.empty();
			dropdown.addOption("", "选择模型");
			for (const model of models) {
				dropdown.addOption(model, model);
			}
			if (currentModel && !models.includes(currentModel)) {
				dropdown.addOption(currentModel, currentModel);
			}
			dropdown.setValue(currentModel);
		} catch {
			// 连接不可用时保留当前模型选项，测试按钮会显示具体错误。
		}
	}

	private addSection(title: string): void {
		const sectionEl = this.containerEl.createDiv({ cls: "pdf-ollama-translator-settings__section" });
		sectionEl.createEl("h3", { text: title });
	}
}
