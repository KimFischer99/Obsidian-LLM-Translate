import zh from "./zh.json";
import en from "./en.json";

type Translations = typeof zh;

const locales: Record<string, Translations> = { zh, en };

/**
 * Get a translated string by dot-separated key.
 * Language is detected from Obsidian's localStorage setting.
 * zh* → Chinese, everything else → English.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
    const lang = localStorage.getItem("language") ?? "zh";
    const bundle: Translations = lang.startsWith("zh") ? zh : en;

    let text = resolve(bundle, key) ?? resolve(zh, key) ?? key;

    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${k}\\}`, "g"), String(v));
        }
    }

    return text;
}

function resolve(obj: Record<string, unknown>, key: string): string | undefined {
    const parts = key.split(".");
    let current: unknown = obj;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" ? current : undefined;
}
