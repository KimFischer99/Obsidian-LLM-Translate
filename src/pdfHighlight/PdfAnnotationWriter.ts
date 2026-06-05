import type { App } from "obsidian";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFHexString,
	PDFName,
	PDFNumber,
	PDFString,
} from "pdf-lib";
import type { HighlightColorConfig, LocatedPdfHighlight, PdfHighlightQuad, PdfHighlightToggleResult } from "./types";

const NAME_PREFIX = "llm-translator:";
const OPACITY = 0.35;
const TOLERANCE = 1.5;

interface ExistingAnnotation {
	index: number;
	dict: PDFDict;
	quadPoints: number[];
	color?: [number, number, number];
}

export class PdfAnnotationWriter {
	constructor(private app: App) {}

	async applyHighlight(
		location: LocatedPdfHighlight,
		color: HighlightColorConfig,
		note: string,
	): Promise<PdfHighlightToggleResult> {
		const pdfBytes = await this.app.vault.readBinary(location.file);
		const pdfDoc = await PDFDocument.load(pdfBytes);
		const matchesByPage = this.findMatchingAnnotations(pdfDoc, location.quads);
		const matched = Array.from(matchesByPage.values()).flat();
		this.removeMatches(pdfDoc, matchesByPage);

		for (const quad of location.quads) {
			this.addAnnotation(pdfDoc, quad, color, stableAnnotationName(location.normalizedText, quad), note);
		}

		const modified = await pdfDoc.save();
		await this.app.vault.adapter.writeBinary(location.file.path, toArrayBuffer(modified));
		return { action: matched.length > 0 ? "updated" : "added", count: location.quads.length };
	}

	async removeHighlight(location: LocatedPdfHighlight): Promise<PdfHighlightToggleResult> {
		const pdfBytes = await this.app.vault.readBinary(location.file);
		const pdfDoc = await PDFDocument.load(pdfBytes);
		const matchesByPage = this.findMatchingAnnotations(pdfDoc, location.quads);
		const matched = Array.from(matchesByPage.values()).flat();
		this.removeMatches(pdfDoc, matchesByPage);
		const modified = await pdfDoc.save();
		await this.app.vault.adapter.writeBinary(location.file.path, toArrayBuffer(modified));
		return { action: "removed", count: matched.length };
	}

	private findMatchingAnnotations(pdfDoc: PDFDocument, quads: PdfHighlightQuad[]): Map<number, ExistingAnnotation[]> {
		const matches = new Map<number, ExistingAnnotation[]>();

		for (const quad of quads) {
			const page = pdfDoc.getPage(quad.pageIndex);
			const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
			if (!annots) {
				continue;
			}

			for (let index = 0; index < annots.size(); index++) {
				const dict = annots.lookupMaybe(index, PDFDict);
				if (!dict || !isPluginHighlight(dict)) {
					continue;
				}

				const existingQuad = readNumberArray(dict.lookupMaybe(PDFName.of("QuadPoints"), PDFArray));
				if (!quadPointsEqual(existingQuad, quad.quadPoints)) {
					continue;
				}

				const group = matches.get(quad.pageIndex) ?? [];
				group.push({
					index,
					dict,
					quadPoints: existingQuad,
					color: readColor(dict.lookupMaybe(PDFName.of("C"), PDFArray)),
				});
				matches.set(quad.pageIndex, group);
			}
		}

		return matches;
	}

	private addAnnotation(
		pdfDoc: PDFDocument,
		quad: PdfHighlightQuad,
		color: HighlightColorConfig,
		name: string,
		note: string,
	): void {
		const page = pdfDoc.getPage(quad.pageIndex);
		let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
		if (!annots) {
			annots = pdfDoc.context.obj([]);
			page.node.set(PDFName.of("Annots"), annots);
		}

		const annotation = pdfDoc.context.obj({
			Type: PDFName.of("Annot"),
			Subtype: PDFName.of("Highlight"),
			Rect: pdfDoc.context.obj(quad.rect),
			QuadPoints: pdfDoc.context.obj(quad.quadPoints),
			C: pdfDoc.context.obj(color.pdfRgb),
			CA: PDFNumber.of(OPACITY),
			NM: PDFString.of(name),
			F: PDFNumber.of(4),
			P: page.ref,
		});
		const trimmedNote = note.trim();
		if (trimmedNote) {
			annotation.set(PDFName.of("Contents"), PDFString.of(trimmedNote));
		}
		const annotationRef = pdfDoc.context.register(annotation);
		annots.push(annotationRef);
	}

	private removeMatches(pdfDoc: PDFDocument, matchesByPage: Map<number, ExistingAnnotation[]>): void {
		for (const [pageIndex, matches] of matchesByPage) {
			const page = pdfDoc.getPage(pageIndex);
			const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
			if (!annots) {
				continue;
			}
			for (const match of matches.sort((a, b) => b.index - a.index)) {
				annots.remove(match.index);
			}
		}
	}
}

function isPluginHighlight(dict: PDFDict): boolean {
	const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
	if (subtype?.toString() !== "/Highlight") {
		return false;
	}

	const name = readString(dict.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));
	return name.startsWith(NAME_PREFIX);
}

function readString(value: PDFString | PDFHexString | undefined): string {
	return value?.decodeText() ?? "";
}

function readColor(array: PDFArray | undefined): [number, number, number] | undefined {
	const values = readNumberArray(array);
	if (values.length < 3) {
		return undefined;
	}
	return [values[0], values[1], values[2]];
}

function readNumberArray(array: PDFArray | undefined): number[] {
	if (!array) {
		return [];
	}
	const values: number[] = [];
	for (let index = 0; index < array.size(); index++) {
		const value = array.lookupMaybe(index, PDFNumber);
		if (value) {
			values.push(value.asNumber());
		}
	}
	return values;
}

function quadPointsEqual(left: number[], right: readonly number[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => Math.abs(value - right[index]) <= TOLERANCE)
	);
}

function stableAnnotationName(text: string, quad: PdfHighlightQuad): string {
	const source = `${text}:${quad.pageIndex}:${quad.quadPoints.map((value) => Math.round(value * 10)).join(",")}`;
	let hash = 0;
	for (let index = 0; index < source.length; index++) {
		hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
	}
	return `${NAME_PREFIX}${hash.toString(16)}`;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(value.byteLength);
	new Uint8Array(buffer).set(value);
	return buffer;
}
