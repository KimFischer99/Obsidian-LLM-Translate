import type {
	ConnectionTestResult,
	PdfOllamaTranslatorSettings,
	TranslationRequest,
	TranslationResult,
	TranslationLanguage,
} from "./types";

interface OllamaChatResponse {
	message?: {
		content?: string;
		thinking?: string;
	};
	error?: string;
}

interface OllamaTagsResponse {
	models?: Array<{
		name?: string;
		model?: string;
	}>;
}

interface TimeoutSignal {
	signal: AbortSignal;
	cleanup: () => void;
}

export const DEFAULT_TRANSLATION_PROMPT =
	"Translate English, German, French, Japanese, or Simplified Chinese into the selected target language. Preserve terminology, numbers, formulas, citations, and paragraph breaks. Output only the translation.";

const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
	auto: "auto-detected language",
	en: "English",
	de: "German",
	fr: "French",
	ja: "Japanese",
	"zh-Hans": "Simplified Chinese",
};

export class OllamaTranslator {
	constructor(private getSettings: () => PdfOllamaTranslatorSettings) {}

	async translate(request: TranslationRequest): Promise<TranslationResult> {
		const settings = this.getSettings();
		const model = settings.model.trim();
		if (!model) {
			throw new Error("请先在插件设置中填写 Ollama 模型名称。");
		}

		const startedAt = performance.now();
		const timeout = this.withTimeout(request.signal, settings.requestTimeoutMs);
		const response = await fetch(this.getChatUrl(settings.ollamaBaseUrl), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					stream: false,
					options: buildOllamaOptions(settings),
					messages: [
						{ role: "system", content: this.getSystemPrompt(settings, request) },
						{ role: "user", content: request.text },
					],
				}),
				signal: timeout.signal,
			})
			.finally(timeout.cleanup);

		if (!response.ok) {
			throw new Error(await this.toHttpError(response));
		}

		const data = (await response.json()) as OllamaChatResponse;
		if (data.error) {
			throw new Error(data.error);
		}

		const rawContent = data.message?.content?.trim() ?? "";
		if (!rawContent) {
			throw new Error("Ollama 返回了空译文。");
		}

		return {
			sourceText: request.text,
			translatedText: settings.cleanModelOutput ? cleanModelOutput(rawContent) : rawContent,
			model,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	async testConnection(): Promise<ConnectionTestResult> {
		const settings = this.getSettings();
		const model = settings.model.trim();
		if (!model) {
			return { ok: false, message: "模型名称为空。" };
		}

		try {
			const timeout = this.withTimeout(undefined, settings.requestTimeoutMs);
			const response = await fetch(this.getTagsUrl(settings.ollamaBaseUrl), {
					method: "GET",
					signal: timeout.signal,
				})
				.finally(timeout.cleanup);

			if (!response.ok) {
				return { ok: false, message: await this.toHttpError(response) };
			}

			const data = (await response.json()) as OllamaTagsResponse;
			const models = data.models ?? [];
			const hasModel = models.some((item) => item.name === model || item.model === model);
			if (!hasModel) {
				return {
					ok: false,
					message: `已连接 Ollama，但没有找到模型“${model}”。`,
				};
			}

			return { ok: true, message: `连接成功，模型“${model}”可用。` };
		} catch (error) {
			return { ok: false, message: this.toReadableError(error) };
		}
	}

	async listModels(): Promise<string[]> {
		const settings = this.getSettings();
		const timeout = this.withTimeout(undefined, settings.requestTimeoutMs);
		const response = await fetch(this.getTagsUrl(settings.ollamaBaseUrl), {
				method: "GET",
				signal: timeout.signal,
			})
			.finally(timeout.cleanup);

		if (!response.ok) {
			throw new Error(await this.toHttpError(response));
		}

		const data = (await response.json()) as OllamaTagsResponse;
		return (data.models ?? [])
			.map((item) => item.name ?? item.model ?? "")
			.filter((name) => name.length > 0)
			.sort((a, b) => a.localeCompare(b));
	}

	toReadableError(error: unknown): string {
		if (error instanceof DOMException && error.name === "AbortError") {
			return "请求超时或已取消。";
		}
		if (error instanceof TypeError) {
			return "无法连接 Ollama。请检查地址，并确认 Ollama 正在运行。";
		}
		if (error instanceof Error) {
			return error.message;
		}
		return "未知翻译错误。";
	}

	private getChatUrl(baseUrl: string): string {
		return `${this.getApiBaseUrl(baseUrl)}/chat`;
	}

	private getTagsUrl(baseUrl: string): string {
		return `${this.getApiBaseUrl(baseUrl)}/tags`;
	}

	private getApiBaseUrl(baseUrl: string): string {
		const trimmed = baseUrl.trim().replace(/\/+$/, "");
		if (!trimmed) {
			return "http://127.0.0.1:11434/api";
		}
		return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
	}

	private withTimeout(signal: AbortSignal | undefined, timeoutMs: number): TimeoutSignal {
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

		const abort = () => controller.abort();
		if (signal) {
			if (signal.aborted) {
				controller.abort();
			} else {
				signal.addEventListener("abort", abort, { once: true });
			}
		}

		controller.signal.addEventListener(
			"abort",
			() => {
				window.clearTimeout(timeoutId);
				signal?.removeEventListener("abort", abort);
			},
			{ once: true },
		);

		return {
			signal: controller.signal,
			cleanup: () => {
				window.clearTimeout(timeoutId);
				signal?.removeEventListener("abort", abort);
			},
		};
	}

	private async toHttpError(response: Response): Promise<string> {
		const text = await response.text();
		if (!text) {
			return `Ollama 请求失败，HTTP ${response.status}。`;
		}

		try {
			const data = JSON.parse(text) as { error?: string };
			return data.error ?? `Ollama 请求失败，HTTP ${response.status}。`;
		} catch {
			return `Ollama 请求失败，HTTP ${response.status}: ${text}`;
		}
	}

	private getSystemPrompt(settings: PdfOllamaTranslatorSettings, request: TranslationRequest): string {
		const source = LANGUAGE_NAMES[request.sourceLanguage] ?? request.sourceLanguage;
		const target = LANGUAGE_NAMES[request.targetLanguage] ?? request.targetLanguage;
		const template = settings.customPrompt.trim() || DEFAULT_TRANSLATION_PROMPT;
		return `${template}\n\nSource language: ${source}\nTarget language: ${target}`;
	}

}

export function buildOllamaOptions(settings: PdfOllamaTranslatorSettings): Record<string, unknown> {
	return {
		top_k: settings.topK,
		top_p: settings.topP,
		repeat_penalty: settings.repeatPenalty,
		num_predict: settings.numPredict,
	};
}

export function cleanModelOutput(value: string): string {
	return value
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/^\s*(translation|translated text|译文|翻译)\s*[:：]\s*/i, "")
		.replace(/^```(?:text|markdown)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.trim()
		.replace(/^["'“”]+|["'“”]+$/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^[ \t]*\n/gm, "")
		.trim();
}
