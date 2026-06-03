import type { App, TFile } from "obsidian";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs?worker-source";
import { normalizePdfChars, normalizeSelectionTextForPdf, toRawPdfChars } from "./normalize";
import type { LocatedPdfHighlight, PdfCharBox, PdfHighlightQuad } from "./types";

interface PdfTextItem {
	str: string;
	transform: number[];
	width?: number;
	height?: number;
	hasEOL?: boolean;
}

interface PageMatch {
	pageIndex: number;
	text: string;
	map: Array<PdfCharBox | undefined>;
	start: number;
	end: number;
	matchType: "exact" | "compact";
}

export class PdfTextLocator {
	private workerUrl: string | undefined;

	constructor(
		private app: App,
		private debug: (message: string, detail?: unknown) => void,
	) {}

	async locate(file: TFile, selectedText: string, pageHint?: number): Promise<LocatedPdfHighlight | null> {
		const normalizedSelection = normalizeSelectionTextForPdf(selectedText);
		if (normalizedSelection.length < 1) {
			return null;
		}

		const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
		pdfjsLib.GlobalWorkerOptions.workerSrc = this.getWorkerUrl();
		const data = await this.app.vault.readBinary(file);
		const documentTask = pdfjsLib.getDocument({
			data: data.slice(0),
			useWorkerFetch: false,
			isEvalSupported: false,
		} as any);
		const pdfDoc = await documentTask.promise;

		try {
			const searchOrder = buildSearchOrder(pdfDoc.numPages, pageHint);
			const matches: PageMatch[] = [];

			for (const pageNumber of searchOrder) {
				const page = await pdfDoc.getPage(pageNumber);
				const textContent = await page.getTextContent();
				const pageMatch = this.findPageMatch(
					pageNumber - 1,
					textContent.items as PdfTextItem[],
					normalizedSelection,
				);

				if (pageMatch && pageHint === pageNumber) {
					return {
						file,
						normalizedText: normalizedSelection,
						quads: buildQuads(pageMatch),
					};
				}

				if (pageMatch) {
					matches.push(pageMatch);
				}
			}

			if (matches.length === 1) {
				return {
					file,
					normalizedText: normalizedSelection,
					quads: buildQuads(matches[0]),
				};
			}

			this.debug("PDF highlight selection could not be uniquely located.", {
				file: file.path,
				pageHint,
				normalizedSelection,
				matchCount: matches.length,
			});
			return null;
		} finally {
			await (pdfDoc as { destroy?: () => Promise<void> }).destroy?.();
		}
	}

	private getWorkerUrl(): string {
		if (!this.workerUrl) {
			this.workerUrl = URL.createObjectURL(new Blob([pdfWorkerSource], { type: "text/javascript" }));
		}
		return this.workerUrl;
	}

	private findPageMatch(pageIndex: number, items: PdfTextItem[], selectedText: string): PageMatch | null {
		const rawChars: Array<{ value: string; box?: PdfCharBox }> = [];
		let previousBox: PdfCharBox | undefined;

		for (const item of items) {
			if (!item.str) {
				continue;
			}
			const boxes = boxesForItem(pageIndex, item);
			const firstBox = boxes[0];
			if (previousBox && firstBox) {
				const separator = inferSeparator(previousBox, firstBox);
				if (separator) {
					rawChars.push({ value: separator });
				}
			}
			rawChars.push(...toRawPdfChars(item.str, boxes));
			if (item.hasEOL) {
				rawChars.push({ value: "\n" });
			}
			previousBox = boxes[boxes.length - 1] ?? previousBox;
		}

		const normalized = normalizePdfChars(rawChars);
		const start = normalized.text.indexOf(selectedText);
		if (start >= 0) {
			return {
				pageIndex,
				text: normalized.text,
				map: normalized.map,
				start,
				end: start + selectedText.length,
				matchType: "exact",
			};
		}

		const compactMatch = findCompactMatch(normalized.text, selectedText);
		if (compactMatch) {
			return {
				pageIndex,
				text: normalized.text,
				map: normalized.map,
				start: compactMatch.start,
				end: compactMatch.end,
				matchType: "compact",
			};
		}

		return null;
	}
}

function buildSearchOrder(numPages: number, pageHint?: number): number[] {
	const order: number[] = [];
	if (pageHint && pageHint >= 1 && pageHint <= numPages) {
		order.push(pageHint);
	}
	for (let page = 1; page <= numPages; page++) {
		if (page !== pageHint) {
			order.push(page);
		}
	}
	return order;
}

function boxesForItem(pageIndex: number, item: PdfTextItem): PdfCharBox[] {
	const chars = Array.from(item.str);
	const transform = item.transform;
	const x = finite(transform[4]);
	const y = finite(transform[5]);
	const width = Math.max(finite(item.width), estimateWidth(transform), chars.length);
	const height = Math.max(finite(item.height), estimateHeight(transform), 8);
	const charWidth = width / Math.max(chars.length, 1);
	const yBottom = y - height * 0.22;
	const yTop = y + height * 0.88;
	const lineKey = Math.round(y / 2);

	return chars.map((_, index) => ({
		pageIndex,
		x: x + charWidth * index,
		x2: x + charWidth * (index + 1),
		yBottom,
		yTop,
		lineKey,
	}));
}

function inferSeparator(previous: PdfCharBox, next: PdfCharBox): " " | "\n" | "" {
	const previousHeight = Math.max(previous.yTop - previous.yBottom, 1);
	const nextHeight = Math.max(next.yTop - next.yBottom, 1);
	const averageHeight = (previousHeight + nextHeight) / 2;
	const verticalDelta = Math.abs(next.yBottom - previous.yBottom);
	if (verticalDelta > averageHeight * 0.65) {
		return "\n";
	}

	const horizontalGap = next.x - previous.x2;
	if (horizontalGap > averageHeight * 0.18) {
		return " ";
	}

	return "";
}

function findCompactMatch(pageText: string, selectedText: string): { start: number; end: number } | null {
	const pageCompact: string[] = [];
	const pageIndexMap: number[] = [];
	for (let index = 0; index < pageText.length; index++) {
		const char = pageText[index];
		if (/\s/.test(char)) {
			continue;
		}
		pageCompact.push(char);
		pageIndexMap.push(index);
	}

	const selectedCompact = selectedText.replace(/\s/g, "");
	if (!selectedCompact) {
		return null;
	}

	const compactText = pageCompact.join("");
	const compactStart = compactText.indexOf(selectedCompact);
	if (compactStart < 0) {
		return null;
	}

	const nextStart = compactText.indexOf(selectedCompact, compactStart + 1);
	if (nextStart >= 0) {
		return null;
	}

	const start = pageIndexMap[compactStart];
	const end = pageIndexMap[compactStart + selectedCompact.length - 1] + 1;
	return { start, end };
}

function buildQuads(match: PageMatch): PdfHighlightQuad[] {
	const boxes = match.map
		.slice(match.start, match.end)
		.filter((box): box is PdfCharBox => Boolean(box));
	if (boxes.length === 0) {
		return [];
	}

	const lineGroups = new Map<number, PdfCharBox[]>();
	for (const box of boxes) {
		const group = lineGroups.get(box.lineKey) ?? [];
		group.push(box);
		lineGroups.set(box.lineKey, group);
	}

	return Array.from(lineGroups.values())
		.map((lineBoxes): PdfHighlightQuad => {
			const left = Math.min(...lineBoxes.map((box) => box.x));
			const right = Math.max(...lineBoxes.map((box) => box.x2));
			const bottom = Math.min(...lineBoxes.map((box) => box.yBottom));
			const top = Math.max(...lineBoxes.map((box) => box.yTop));
			const pageIndex = lineBoxes[0].pageIndex;

			return {
				pageIndex,
				quadPoints: [left, top, right, top, left, bottom, right, bottom],
				rect: [left, bottom, right, top],
			};
		})
		.filter((quad) => quad.rect[2] - quad.rect[0] > 0 && quad.rect[3] - quad.rect[1] > 0);
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateWidth(transform: number[]): number {
	return Math.hypot(finite(transform[0]), finite(transform[1]));
}

function estimateHeight(transform: number[]): number {
	return Math.hypot(finite(transform[2]), finite(transform[3]));
}
