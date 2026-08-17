import { PDFDocument, PDFName } from 'pdf-lib';

export type PdfBytes = ArrayBuffer | Uint8Array;

export type PdfMutationPolicy = {
  touchedPages: number[];
  annotationAdditions?: Record<number, number>;
  strictPageScope?: boolean;
};

export type PageSnapshot = {
  geometry: string;
  inheritedAttributes: string;
  full: string;
  protectedStatic: string;
  effectiveResources: string;
  annotations: string[];
};

export type PdfPreservationSnapshot = {
  sourceHash: string;
  pdfVersion: string | null;
  metadata: string;
  infoDictionary: string;
  trailerId: string;
  encryption: string;
  catalogFingerprint: string;
  catalog: Record<string, string>;
  pageCount: number;
  signatureFields: number;
  signedSignatures: number;
  pages: PageSnapshot[];
};

const MAX_NORMALIZATION_DEPTH = 160;
const MAX_NORMALIZATION_NODES = 250_000;

export const PROTECTED_CATALOG_KEYS = [
  'Metadata', 'Outlines', 'Names', 'Dests', 'ViewerPreferences',
  'PageLayout', 'PageMode', 'OpenAction', 'AA', 'URI', 'AcroForm',
  'Lang', 'MarkInfo', 'StructTreeRoot', 'OCProperties', 'Perms',
  'Legal', 'Collection', 'NeedsRendering', 'Version', 'PageLabels',
  'OutputIntents', 'Extensions', 'SpiderInfo', 'PieceInfo',
] as const;

const INHERITED_PAGE_KEYS = [
  'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'UserUnit',
] as const;

type NormalizationState = {
  context: any;
  pageRefs: Map<string, number>;
  nodes: number;
};

function toUint8Array(bytes: PdfBytes): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function readPdfVersion(bytes: PdfBytes): string | null {
  const prefix = new TextDecoder('latin1').decode(toUint8Array(bytes).subarray(0, 32));
  return prefix.match(/%PDF-(\d\.\d)/)?.[1] ?? null;
}

function dateValue(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}

function safeValue<T>(reader: () => T, fallback: T): T {
  try { return reader(); } catch { return fallback; }
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto is required for PDF preservation verification.');
  }
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', owned);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

function resolvePdfObject(context: any, object: any): any {
  return object?.constructor?.name === 'PDFRef' ? context.lookup(object) : object;
}

function createPageRefIndex(pages: any[]): Map<string, number> {
  const pageRefs = new Map<string, number>();
  for (let index = 0; index < pages.length; index++) {
    if (pages[index]?.ref) pageRefs.set(String(pages[index].ref), index);
  }
  return pageRefs;
}

function consumeNormalizationNode(state: NormalizationState, depth: number): void {
  if (depth > MAX_NORMALIZATION_DEPTH) {
    throw new Error(`PDF object graph exceeds the preservation depth limit (${MAX_NORMALIZATION_DEPTH}).`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_NORMALIZATION_NODES) {
    throw new Error(`PDF object graph exceeds the preservation complexity limit (${MAX_NORMALIZATION_NODES} nodes).`);
  }
}

async function normalizePdfObject(
  state: NormalizationState,
  object: any,
  rootSkipKeys: Set<string>,
  stack: Set<string> = new Set(),
  applyRootSkip = true,
  depth = 0
): Promise<string> {
  consumeNormalizationNode(state, depth);
  if (object === undefined || object === null) return 'null';
  const typeName = object?.constructor?.name ?? typeof object;

  if (typeName === 'PDFRef') {
    const refKey = String(object);
    const pageIndex = state.pageRefs.get(refKey);
    if (pageIndex !== undefined) return `page-ref:${pageIndex}`;
    if (stack.has(refKey)) return '[cycle]';
    const nextStack = new Set(stack);
    nextStack.add(refKey);
    return normalizePdfObject(
      state,
      state.context.lookup(object),
      rootSkipKeys,
      nextStack,
      applyRootSkip,
      depth + 1
    );
  }

  if (typeName.includes('Stream')) {
    const streamSkipKeys = new Set(rootSkipKeys);
    streamSkipKeys.add('Length');
    const dictionary = object.dict
      ? await normalizePdfObject(state, object.dict, streamSkipKeys, stack, true, depth + 1)
      : '{}';
    const streamBytes = object.contents ?? object.getContents?.();
    const streamHash = streamBytes
      ? await sha256Bytes(streamBytes instanceof Uint8Array ? streamBytes : new Uint8Array(streamBytes))
      : await sha256Text(String(object));
    return `stream:${dictionary}:${streamHash}`;
  }

  if (typeof object.entries === 'function') {
    const entries: Array<[any, any]> = Array.from(object.entries() ?? []);
    const normalizedEntries = entries
      .map(([key, value]) => [String(key).replace(/^\//, ''), value] as [string, any])
      .filter(([key]) => !(applyRootSkip && rootSkipKeys.has(key)))
      .sort(([left], [right]) => left.localeCompare(right));
    const pieces: string[] = [];
    for (const [key, value] of normalizedEntries) {
      pieces.push(`${key}:${await normalizePdfObject(state, value, rootSkipKeys, stack, false, depth + 1)}`);
    }
    return `{${pieces.join(',')}}`;
  }

  if (typeName === 'PDFArray') {
    const values: string[] = [];
    const size = object.size?.() ?? 0;
    for (let index = 0; index < size; index++) {
      values.push(await normalizePdfObject(state, object.get(index), rootSkipKeys, stack, false, depth + 1));
    }
    return `[${values.join(',')}]`;
  }

  return `${typeName}:${String(object)}`;
}

async function fingerprintPdfObject(
  context: any,
  object: any,
  pageRefs: Map<string, number>,
  rootSkipKeys: string[] = []
): Promise<string> {
  const normalized = await normalizePdfObject(
    { context, pageRefs, nodes: 0 },
    object,
    new Set(rootSkipKeys)
  );
  return sha256Text(normalized);
}

function getInheritedPageValue(page: any, key: string): any {
  const context = page.doc.context;
  const keyName = PDFName.of(key);
  const parentName = PDFName.of('Parent');
  const visited = new Set<string>();
  let node = page.node;

  for (let depth = 0; depth <= MAX_NORMALIZATION_DEPTH; depth++) {
    const directValue = node?.get?.(keyName);
    if (directValue !== undefined) return directValue;
    const parentReference = node?.get?.(parentName);
    if (!parentReference) return undefined;
    const refKey = String(parentReference);
    if (visited.has(refKey)) throw new Error('Cycle detected in the PDF page tree.');
    visited.add(refKey);
    node = resolvePdfObject(context, parentReference);
    if (!node) return undefined;
  }
  throw new Error('PDF page inheritance exceeds the supported depth.');
}

async function getInheritedAttributesFingerprint(page: any, pageRefs: Map<string, number>): Promise<string> {
  const values: Record<string, string> = {};
  for (const key of INHERITED_PAGE_KEYS) {
    values[key] = await fingerprintPdfObject(page.doc.context, getInheritedPageValue(page, key), pageRefs);
  }
  return sha256Text(JSON.stringify(values));
}

async function getEffectiveResourcesFingerprint(page: any, pageRefs: Map<string, number>): Promise<string> {
  return fingerprintPdfObject(page.doc.context, getInheritedPageValue(page, 'Resources'), pageRefs);
}

async function getAnnotationFingerprints(page: any, pageRefs: Map<string, number>): Promise<string[]> {
  const context = page.doc.context;
  const annotations = resolvePdfObject(context, page.node.get?.(PDFName.of('Annots')));
  if (annotations?.constructor?.name !== 'PDFArray') return [];
  const fingerprints: string[] = [];
  const size = annotations.size?.() ?? 0;
  for (let index = 0; index < size; index++) {
    fingerprints.push(await fingerprintPdfObject(context, annotations.get(index), pageRefs, ['P']));
  }
  return fingerprints;
}

async function snapshotPage(page: any, pageRefs: Map<string, number>): Promise<PageSnapshot> {
  const context = page.doc.context;
  const size = page.getSize();
  const geometry = JSON.stringify({ width: size.width, height: size.height, rotation: page.getRotation().angle });
  return {
    geometry,
    inheritedAttributes: await getInheritedAttributesFingerprint(page, pageRefs),
    full: await fingerprintPdfObject(context, page.node, pageRefs, ['Parent']),
    protectedStatic: await fingerprintPdfObject(context, page.node, pageRefs, ['Parent', 'Contents', 'Resources', 'Annots']),
    effectiveResources: await getEffectiveResourcesFingerprint(page, pageRefs),
    annotations: await getAnnotationFingerprints(page, pageRefs),
  };
}

function getPdfName(context: any, object: any): string | null {
  const resolved = resolvePdfObject(context, object);
  if (!resolved) return null;
  const value = String(resolved);
  return value.startsWith('/') ? value.slice(1) : value;
}

function getArrayItems(context: any, object: any): any[] {
  const resolved = resolvePdfObject(context, object);
  if (resolved?.constructor?.name !== 'PDFArray') return [];
  const items: any[] = [];
  const size = resolved.size?.() ?? 0;
  for (let index = 0; index < size; index++) items.push(resolved.get(index));
  return items;
}

function countSignatureFields(pdf: any): { signatureFields: number; signedSignatures: number } {
  const context = pdf.context;
  const acroForm = resolvePdfObject(context, pdf.catalog.get(PDFName.of('AcroForm')));
  if (!acroForm) return { signatureFields: 0, signedSignatures: 0 };
  const roots = getArrayItems(context, acroForm.get?.(PDFName.of('Fields')));
  const visited = new Set<string>();
  let signatureFields = 0;
  let signedSignatures = 0;

  const visit = (fieldReference: any, inheritedType: string | null): void => {
    const refKey = fieldReference?.constructor?.name === 'PDFRef' ? String(fieldReference) : null;
    if (refKey) {
      if (visited.has(refKey)) return;
      visited.add(refKey);
    }
    const field = resolvePdfObject(context, fieldReference);
    if (!field || typeof field.get !== 'function') return;
    const effectiveType = getPdfName(context, field.get(PDFName.of('FT'))) ?? inheritedType;
    const kids = getArrayItems(context, field.get(PDFName.of('Kids')));
    if (effectiveType === 'Sig') {
      signatureFields += 1;
      const value = field.get(PDFName.of('V'));
      const resolvedValue = resolvePdfObject(context, value);
      if (value !== undefined && resolvedValue?.constructor?.name !== 'PDFNull') signedSignatures += 1;
    }
    for (const child of kids) visit(child, effectiveType);
  };
  for (const root of roots) visit(root, null);
  return { signatureFields, signedSignatures };
}

export async function createPdfPreservationSnapshot(bytes: PdfBytes): Promise<PdfPreservationSnapshot> {
  const sourceBytes = toUint8Array(bytes);
  const pdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false });
  const context: any = pdf.context;
  const trailerInfo: any = context.trailerInfo ?? {};
  const pdfPages = pdf.getPages();
  const pageRefs = createPageRefIndex(pdfPages);
  const metadata = JSON.stringify({
    title: safeValue(() => pdf.getTitle() ?? null, null),
    author: safeValue(() => pdf.getAuthor() ?? null, null),
    subject: safeValue(() => pdf.getSubject() ?? null, null),
    keywords: safeValue(() => pdf.getKeywords() ?? null, null),
    creator: safeValue(() => pdf.getCreator() ?? null, null),
    producer: safeValue(() => pdf.getProducer() ?? null, null),
    creationDate: safeValue(() => dateValue(pdf.getCreationDate()), null),
    modificationDate: safeValue(() => dateValue(pdf.getModificationDate()), null),
  });
  const catalog: Record<string, string> = {};
  for (const key of PROTECTED_CATALOG_KEYS) {
    catalog[key] = await fingerprintPdfObject(context, pdf.catalog.get(PDFName.of(key)), pageRefs);
  }
  const pages: PageSnapshot[] = [];
  for (const page of pdfPages) pages.push(await snapshotPage(page, pageRefs));
  const signatures = countSignatureFields(pdf);
  return {
    sourceHash: await sha256Bytes(sourceBytes),
    pdfVersion: readPdfVersion(bytes),
    metadata,
    infoDictionary: await fingerprintPdfObject(context, trailerInfo.Info, pageRefs),
    trailerId: await fingerprintPdfObject(context, trailerInfo.ID, pageRefs),
    encryption: await fingerprintPdfObject(context, trailerInfo.Encrypt, pageRefs),
    catalogFingerprint: await fingerprintPdfObject(context, pdf.catalog, pageRefs, ['Pages']),
    catalog,
    pageCount: pdf.getPageCount(),
    signatureFields: signatures.signatureFields,
    signedSignatures: signatures.signedSignatures,
    pages,
  };
}
