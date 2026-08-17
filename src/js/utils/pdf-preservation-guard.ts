import { PDFDocument, PDFName } from 'pdf-lib';

export type PdfBytes = ArrayBuffer | Uint8Array;

export type PdfMutationPolicy = {
  touchedPages: number[];
  annotationPages: number[];
  strictPageScope?: boolean;
};

type PageSnapshot = {
  geometry: string;
  full: string;
  protectedWithAnnotations: string;
  protectedWithoutAnnotations: string;
  effectiveResources: string;
};

export type PdfPreservationSnapshot = {
  pdfVersion: string | null;
  metadata: string;
  infoDictionary: string;
  trailerId: string;
  encryption: string;
  catalog: Record<string, string>;
  pageCount: number;
  pages: PageSnapshot[];
};

const PROTECTED_CATALOG_KEYS = [
  'Metadata',
  'Outlines',
  'Names',
  'Dests',
  'ViewerPreferences',
  'PageLayout',
  'PageMode',
  'OpenAction',
  'AA',
  'URI',
  'AcroForm',
  'Lang',
  'MarkInfo',
  'StructTreeRoot',
  'OCProperties',
  'Perms',
  'Legal',
  'Collection',
  'NeedsRendering',
  'Version',
] as const;

function toUint8Array(bytes: PdfBytes): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function readPdfVersion(bytes: PdfBytes): string | null {
  const view = toUint8Array(bytes);
  const prefix = new TextDecoder('latin1').decode(view.subarray(0, 32));
  return prefix.match(/%PDF-(\d\.\d)/)?.[1] ?? null;
}

function dateValue(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
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

async function normalizePdfObject(
  context: any,
  object: any,
  rootSkipKeys: Set<string>,
  stack: Set<string> = new Set(),
  applyRootSkip = true,
  depth = 0
): Promise<string> {
  if (object === undefined || object === null) return 'null';
  if (depth > 80) return '[depth-limit]';

  const typeName = object?.constructor?.name ?? typeof object;

  if (typeName === 'PDFRef') {
    const refKey = String(object);
    if (stack.has(refKey)) return '[cycle]';
    const nextStack = new Set(stack);
    nextStack.add(refKey);
    const dereferenced = context.lookup(object);
    return normalizePdfObject(
      context,
      dereferenced,
      rootSkipKeys,
      nextStack,
      applyRootSkip,
      depth + 1
    );
  }

  if (typeName.includes('Stream')) {
    const dictionary = object.dict
      ? await normalizePdfObject(
          context,
          object.dict,
          rootSkipKeys,
          stack,
          applyRootSkip,
          depth + 1
        )
      : '{}';
    const streamBytes = object.contents ?? object.getContents?.();
    const streamHash = streamBytes
      ? await sha256Bytes(toUint8Array(streamBytes))
      : await sha256Text(String(object));
    return `stream:${dictionary}:${streamHash}`;
  }

  if (
    typeName === 'PDFDict' ||
    typeName === 'PDFCatalog' ||
    typeName === 'PDFPageLeaf'
  ) {
    const entries: Array<[any, any]> = Array.from(object.entries?.() ?? []);
    const normalizedEntries: Array<[string, any]> = entries
      .map(([key, value]) => [String(key).replace(/^\//, ''), value])
      .filter(([key]) => !(applyRootSkip && rootSkipKeys.has(key)))
      .sort(([left], [right]) => left.localeCompare(right));

    const pieces: string[] = [];
    for (const [key, value] of normalizedEntries) {
      pieces.push(
        `${key}:${await normalizePdfObject(
          context,
          value,
          rootSkipKeys,
          stack,
          false,
          depth + 1
        )}`
      );
    }
    return `{${pieces.join(',')}}`;
  }

  if (typeName === 'PDFArray') {
    const size = object.size?.() ?? 0;
    const values: string[] = [];
    for (let index = 0; index < size; index++) {
      values.push(
        await normalizePdfObject(
          context,
          object.get(index),
          rootSkipKeys,
          stack,
          false,
          depth + 1
        )
      );
    }
    return `[${values.join(',')}]`;
  }

  return `${typeName}:${String(object)}`;
}

async function fingerprintPdfObject(
  context: any,
  object: any,
  rootSkipKeys: string[] = []
): Promise<string> {
  const normalized = await normalizePdfObject(
    context,
    object,
    new Set(rootSkipKeys)
  );
  return sha256Text(normalized);
}

async function getEffectiveResourcesFingerprint(page: any): Promise<string> {
  const context = page.doc.context;
  const resources =
    page.node.Resources?.() ?? page.node.get?.(PDFName.of('Resources'));
  return fingerprintPdfObject(context, resources);
}

async function snapshotPage(page: any): Promise<PageSnapshot> {
  const context = page.doc.context;
  const size = page.getSize();
  const rotation = page.getRotation();
  const geometry = JSON.stringify({
    width: size.width,
    height: size.height,
    rotation: rotation.angle,
  });

  return {
    geometry,
    full: await fingerprintPdfObject(context, page.node, ['Parent']),
    protectedWithAnnotations: await fingerprintPdfObject(context, page.node, [
      'Parent',
      'Contents',
      'Resources',
    ]),
    protectedWithoutAnnotations: await fingerprintPdfObject(
      context,
      page.node,
      ['Parent', 'Contents', 'Resources', 'Annots']
    ),
    effectiveResources: await getEffectiveResourcesFingerprint(page),
  };
}

export async function createPdfPreservationSnapshot(
  bytes: PdfBytes
): Promise<PdfPreservationSnapshot> {
  const pdf = await PDFDocument.load(toUint8Array(bytes), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const context: any = pdf.context;
  const trailerInfo: any = context.trailerInfo ?? {};

  const metadata = JSON.stringify({
    title: pdf.getTitle() ?? null,
    author: pdf.getAuthor() ?? null,
    subject: pdf.getSubject() ?? null,
    keywords: pdf.getKeywords() ?? null,
    creator: pdf.getCreator() ?? null,
    producer: pdf.getProducer() ?? null,
    creationDate: dateValue(pdf.getCreationDate()),
    modificationDate: dateValue(pdf.getModificationDate()),
  });

  const catalog: Record<string, string> = {};
  for (const key of PROTECTED_CATALOG_KEYS) {
    catalog[key] = await fingerprintPdfObject(
      context,
      pdf.catalog.get(PDFName.of(key))
    );
  }

  const pages: PageSnapshot[] = [];
  for (const page of pdf.getPages()) {
    pages.push(await snapshotPage(page));
  }

  return {
    pdfVersion: readPdfVersion(bytes),
    metadata,
    infoDictionary: await fingerprintPdfObject(context, trailerInfo.Info),
    trailerId: await fingerprintPdfObject(context, trailerInfo.ID),
    encryption: await fingerprintPdfObject(context, trailerInfo.Encrypt),
    catalog,
    pageCount: pdf.getPageCount(),
    pages,
  };
}

function describeCatalogKey(key: string): string {
  const labels: Record<string, string> = {
    Metadata: 'XMP metadata',
    Outlines: 'bookmarks / outline',
    Names: 'named destinations, embedded files, or document name trees',
    Dests: 'document destinations',
    ViewerPreferences: 'viewer preferences',
    PageLayout: 'page layout preference',
    PageMode: 'page mode preference',
    OpenAction: 'document open action',
    AA: 'document additional actions',
    URI: 'document URI settings',
    AcroForm: 'form structure or fields',
    Lang: 'document language',
    MarkInfo: 'tagging metadata',
    StructTreeRoot: 'accessibility structure tree',
    OCProperties: 'optional-content / layer settings',
    Perms: 'document permissions',
    Legal: 'legal-attestation dictionary',
    Collection: 'document collection settings',
    NeedsRendering: 'rendering requirement flag',
    Version: 'catalog PDF version',
  };
  return labels[key] ?? key;
}

export async function verifyPdfPreservation(
  editedBytes: PdfBytes,
  baseline: PdfPreservationSnapshot,
  policy: PdfMutationPolicy
): Promise<string[]> {
  const edited = await createPdfPreservationSnapshot(editedBytes);
  const violations: string[] = [];

  if (edited.pdfVersion !== baseline.pdfVersion) {
    violations.push(
      `PDF version changed (${baseline.pdfVersion ?? 'unknown'} → ${edited.pdfVersion ?? 'unknown'}).`
    );
  }
  if (edited.metadata !== baseline.metadata) {
    violations.push('standard document metadata changed.');
  }
  if (edited.infoDictionary !== baseline.infoDictionary) {
    violations.push('the PDF Info dictionary changed.');
  }
  if (edited.trailerId !== baseline.trailerId) {
    violations.push('the document trailer ID changed.');
  }
  if (edited.encryption !== baseline.encryption) {
    violations.push('document encryption/security state changed.');
  }

  for (const key of PROTECTED_CATALOG_KEYS) {
    if (edited.catalog[key] !== baseline.catalog[key]) {
      violations.push(`${describeCatalogKey(key)} changed.`);
    }
  }

  if (edited.pageCount !== baseline.pageCount) {
    violations.push(
      `page count changed (${baseline.pageCount} → ${edited.pageCount}).`
    );
  }

  const sharedPageCount = Math.min(edited.pages.length, baseline.pages.length);
  const touchedPages = new Set(policy.touchedPages);
  const annotationPages = new Set(policy.annotationPages);
  const strictPageScope = policy.strictPageScope !== false;

  for (let pageIndex = 0; pageIndex < sharedPageCount; pageIndex++) {
    const before = baseline.pages[pageIndex];
    const after = edited.pages[pageIndex];

    if (before.geometry !== after.geometry) {
      violations.push(`page ${pageIndex + 1} size or rotation changed.`);
    }

    if (!strictPageScope) continue;

    if (!touchedPages.has(pageIndex)) {
      if (before.full !== after.full) {
        violations.push(`untouched page ${pageIndex + 1} changed.`);
      }
      if (before.effectiveResources !== after.effectiveResources) {
        violations.push(`resources used by untouched page ${pageIndex + 1} changed.`);
      }
      continue;
    }

    const beforeProtected = annotationPages.has(pageIndex)
      ? before.protectedWithoutAnnotations
      : before.protectedWithAnnotations;
    const afterProtected = annotationPages.has(pageIndex)
      ? after.protectedWithoutAnnotations
      : after.protectedWithAnnotations;

    if (beforeProtected !== afterProtected) {
      violations.push(
        `page ${pageIndex + 1} changed outside the allowed text-content${
          annotationPages.has(pageIndex) ? ' / replacement-annotation' : ''
        } scope.`
      );
    }
  }

  return Array.from(new Set(violations));
}
