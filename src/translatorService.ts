import type {
	ConnectionTestResult,
	PdfOllamaTranslatorSettings,
	TranslationRequest,
	TranslationResult,
	TranslationLanguage,
	TranslationProviderId,
} from "./types";
import { requestUrl } from "obsidian";
import { t } from "./i18n";

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

interface CloudChatResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
	error?: {
		message?: string;
	};
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

const PROVIDER_LABELS: Record<TranslationProviderId, string> = {
	"local-llm": "Local LLM",
	"cloud-api": "Cloud API",
	google: "Google",
	bing: "Bing",
};

export function getProviderLabel(provider: TranslationProviderId): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

export class TranslatorService {
	constructor(private getSettings: () => PdfOllamaTranslatorSettings) {}

	async translate(request: TranslationRequest): Promise<TranslationResult> {
		const provider = this.getSettings().translationProvider;
		if (provider === "cloud-api") {
			return this.translateWithCloudApi(request);
		}
		if (provider === "google") {
			return this.translateWithGoogle(request);
		}
		if (provider === "bing") {
			return this.translateWithBing(request);
		}
		return this.translateWithOllama(request);
	}

	private async translateWithOllama(request: TranslationRequest): Promise<TranslationResult> {
		const settings = this.getSettings();
		const model = settings.model.trim();
		if (!model) {
			throw new Error(t("error.selectLocalModel"));
		}

		const startedAt = performance.now();
		const response = await this.requestUrlWithTimeout({
			url: this.getChatUrl(settings.ollamaBaseUrl),
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
		}, settings.requestTimeoutMs);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Ollama"));
		}

		const data = response.json as OllamaChatResponse;
		if (data.error) {
			throw new Error(data.error);
		}

		const rawContent = data.message?.content?.trim() ?? "";
		if (!rawContent) {
			throw new Error(t("error.ollamaReturnedEmpty"));
		}

		return {
			sourceText: request.text,
			translatedText: settings.cleanModelOutput ? cleanModelOutput(rawContent) : rawContent,
			model,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	private async translateWithCloudApi(request: TranslationRequest): Promise<TranslationResult> {
		const settings = this.getSettings();
		const apiKey = settings.cloudApiKey.trim();
		const model = settings.cloudApiModel.trim();
		if (!apiKey) {
			throw new Error(t("error.fillApiKey"));
		}
		if (!model) {
			throw new Error(t("error.fillModelName"));
		}

		const startedAt = performance.now();
		const response = await this.requestUrlWithTimeout({
			url: this.getCloudChatUrl(settings.cloudApiBaseUrl),
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			contentType: "application/json",
			body: JSON.stringify({
				model,
				stream: false,
				messages: [
					{ role: "system", content: this.getSystemPrompt(settings, request) },
					{ role: "user", content: request.text },
				],
			}),
		}, settings.requestTimeoutMs);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Cloud API"));
		}

		const data = response.json as CloudChatResponse;
		if (data.error) {
			throw new Error(data.error.message ?? t("error.cloudApiError"));
		}

		const rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
		if (!rawContent) {
			throw new Error(t("error.cloudApiReturnedEmpty"));
		}

		return {
			sourceText: request.text,
			translatedText: settings.cleanModelOutput ? cleanModelOutput(rawContent) : rawContent,
			model,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	private async translateWithGoogle(request: TranslationRequest): Promise<TranslationResult> {
		const settings = this.getSettings();
		const startedAt = performance.now();
		const source = toGoogleLanguage(request.sourceLanguage);
		const target = toGoogleLanguage(request.targetLanguage);
		const url = new URL("https://translate.googleapis.com/translate_a/single");
		url.searchParams.set("client", "gtx");
		url.searchParams.set("sl", source);
		url.searchParams.set("tl", target);
		url.searchParams.set("dt", "t");
		url.searchParams.set("q", request.text);

		const response = await this.requestUrlWithTimeout({ url: url.toString() }, settings.requestTimeoutMs);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Google Translate"));
		}

		const translatedText = parseGoogleResponse(response.json);
		if (!translatedText) {
			throw new Error(t("error.googleReturnedEmpty"));
		}
		return {
			sourceText: request.text,
			translatedText,
			model: "Google",
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	private async translateWithBing(request: TranslationRequest): Promise<TranslationResult> {
		const settings = this.getSettings();
		const startedAt = performance.now();
		const target = toBingLanguage(request.targetLanguage);
		const source = request.sourceLanguage === "auto" ? "" : `&from=${encodeURIComponent(toBingLanguage(request.sourceLanguage))}`;
		const url = `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0${source}&to=${encodeURIComponent(target)}`;
		const token = await this.getBingAuthToken(settings.requestTimeoutMs);
		const response = await this.requestUrlWithTimeout({
			url,
			method: "POST",
			headers: {
				Accept: "*/*",
				"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
				Authorization: `Bearer ${token}`,
				"Cache-Control": "no-cache",
				Pragma: "no-cache",
				Referer: "https://appsumo.com/",
				"Referrer-Policy": "strict-origin-when-cross-origin",
			},
			contentType: "application/json",
			body: JSON.stringify([{ text: request.text }]),
		}, settings.requestTimeoutMs);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Bing Translate"));
		}

		const translatedText = parseBingResponse(response.json);
		if (!translatedText) {
			throw new Error(t("error.bingReturnedEmpty"));
		}
		return {
			sourceText: request.text,
			translatedText,
			model: "Bing",
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	async testConnection(): Promise<ConnectionTestResult> {
		const provider = this.getSettings().translationProvider;
		if (provider !== "local-llm") {
			try {
				const result = await this.translate({
					text: "Hello",
					sourceLanguage: "en",
					targetLanguage: "zh-Hans",
					allowedSourceLanguages: ["en", "de", "fr", "ja", "zh-Hans"],
				});
				return { ok: true, message: t("error.connectionSuccess", { provider: getProviderLabel(provider), result: result.translatedText }) };
			} catch (error) {
				return { ok: false, message: this.toReadableError(error) };
			}
		}

		const settings = this.getSettings();
		const model = settings.model.trim();
		if (!model) {
			return { ok: false, message: t("error.modelNameEmpty") };
		}

		try {
			const response = await this.requestUrlWithTimeout({
				url: this.getTagsUrl(settings.ollamaBaseUrl),
			}, settings.requestTimeoutMs);

			if (response.status < 200 || response.status >= 300) {
				return { ok: false, message: this.toHttpError(response, "Ollama") };
			}

			const data = response.json as OllamaTagsResponse;
			const models = data.models ?? [];
			const hasModel = models.some((item) => item.name === model || item.model === model);
			if (!hasModel) {
				return {
					ok: false,
					message: t("error.ollamaConnectedButModelNotFound", { model }),
				};
			}

			return { ok: true, message: t("error.modelAvailable", { model }) };
		} catch (error) {
			return { ok: false, message: this.toReadableError(error) };
		}
	}

	async listModels(): Promise<string[]> {
		const settings = this.getSettings();
		const response = await this.requestUrlWithTimeout({
			url: this.getTagsUrl(settings.ollamaBaseUrl),
		}, settings.requestTimeoutMs);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Ollama"));
		}

		const data = response.json as OllamaTagsResponse;
		return (data.models ?? [])
			.map((item) => item.name ?? item.model ?? "")
			.filter((name) => name.length > 0)
			.sort((a, b) => a.localeCompare(b));
	}

	toReadableError(error: unknown): string {
		if (error instanceof DOMException && error.name === "AbortError") {
			return t("error.timeout");
		}
		if (error instanceof TypeError) {
			return t("error.cannotConnectOllama");
		}
		if (error instanceof Error) {
			return error.message;
		}
		return t("error.unknownError");
	}

	private getChatUrl(baseUrl: string): string {
		return `${this.getApiBaseUrl(baseUrl)}/chat`;
	}

	private getTagsUrl(baseUrl: string): string {
		return `${this.getApiBaseUrl(baseUrl)}/tags`;
	}

	private getCloudChatUrl(baseUrl: string): string {
		const trimmed = baseUrl.trim().replace(/\/+$/, "");
		return `${trimmed}/chat/completions`;
	}

	private async getBingAuthToken(timeoutMs: number): Promise<string> {
		const response = await this.requestUrlWithTimeout({
			url: "https://edge.microsoft.com/translate/auth",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42",
			},
		}, timeoutMs);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Bing Auth"));
		}
		const token = response.text.trim();
		if (!token) {
			throw new Error(t("error.bingAuthEmptyToken"));
		}
		return token;
	}

	private getApiBaseUrl(baseUrl: string): string {
		const trimmed = baseUrl.trim().replace(/\/+$/, "");
		if (!trimmed) {
			return "http://localhost:11434/api";
		}
		return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
	}

	private requestUrlWithTimeout(
		params: { url: string; method?: string; headers?: Record<string, string>; body?: string; contentType?: string },
		timeoutMs: number,
	): Promise<{ status: number; text: string; json: unknown }> {
		return new Promise((resolve, reject) => {
			const timeoutId = window.setTimeout(() => {
				reject(new DOMException("Timeout", "AbortError"));
			}, timeoutMs);

			requestUrl({
				url: params.url,
				method: params.method,
				headers: params.headers,
				body: params.body,
				contentType: params.contentType,
				throw: false,
			}).then(
				(response) => {
					window.clearTimeout(timeoutId);
					resolve(response);
				},
				(error) => {
					window.clearTimeout(timeoutId);
					reject(error);
				},
			);
		});
	}

	private toHttpError(response: { status: number; text: string }, service: string): string {
		const text = response.text;
		if (!text) {
			return t("error.httpRequestFailed", { service, status: response.status });
		}

		try {
			const data = JSON.parse(text) as { error?: string | { message?: string } };
			if (typeof data.error === "string") {
				return data.error;
			}
			return data.error?.message ?? t("error.httpRequestFailed", { service, status: response.status });
		} catch {
			return t("error.httpRequestFailedWithBody", { service, status: response.status, body: text });
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

function toGoogleLanguage(language: TranslationLanguage): string {
	return language === "zh-Hans" ? "zh-CN" : language;
}

function toBingLanguage(language: Exclude<TranslationLanguage, "auto">): string;
function toBingLanguage(language: TranslationLanguage): string {
	return language === "zh-Hans" ? "zh-Hans" : language;
}

function parseGoogleResponse(data: unknown): string {
	if (!Array.isArray(data) || !Array.isArray(data[0])) {
		return "";
	}
	const outer = data as unknown[][];
	return outer[0]
		.map((item) => (Array.isArray(item) ? String(item[0] ?? "") : ""))
		.join("")
		.trim();
}

function parseBingResponse(data: unknown): string {
	if (!Array.isArray(data)) {
		return "";
	}
	const items = data as Array<{ translations?: Array<{ text?: string }> }>;
	return items
		.flatMap((item) => {
			const translations = item.translations ?? [];
			return translations.map((translation) => translation.text ?? "");
		})
		.filter((value): value is string => Boolean(value))
		.join("\n")
		.trim();
}
