import {
  PROTECTED_CATALOG_KEYS,
  createPdfPreservationSnapshot,
  type PdfBytes,
  type PdfMutationPolicy,
  type PdfPreservationSnapshot,
} from './pdf-preservation-snapshot.js';

function describeCatalogKey(key: string): string {
  const labels: Record<string, string> = {
    Metadata: 'XMP metadata', Outlines: 'bookmarks / outline',
    Names: 'named destinations, embedded files, or document name trees',
    Dests: 'document destinations', ViewerPreferences: 'viewer preferences',
    PageLayout: 'page layout preference', PageMode: 'page mode preference',
    OpenAction: 'document open action', AA: 'document additional actions',
    URI: 'document URI settings', AcroForm: 'form structure or fields',
    Lang: 'document language', MarkInfo: 'tagging metadata',
    StructTreeRoot: 'accessibility structure tree',
    OCProperties: 'optional-content / layer settings',
    Perms: 'document permissions', Legal: 'legal-attestation dictionary',
    Collection: 'document collection settings',
    NeedsRendering: 'rendering requirement flag', Version: 'catalog PDF version',
    PageLabels: 'page labels', OutputIntents: 'output intents / color profiles',
    Extensions: 'PDF extension declarations', SpiderInfo: 'web-capture information',
    PieceInfo: 'private application data',
  };
  return labels[key] ?? key;
}

function isOrderedSubsequence(expected: string[], actual: string[]): boolean {
  let expectedIndex = 0;
  for (const value of actual) {
    if (value === expected[expectedIndex]) {
      expectedIndex += 1;
      if (expectedIndex === expected.length) return true;
    }
  }
  return expectedIndex === expected.length;
}

function normalizeAnnotationAdditions(
  policy: PdfMutationPolicy,
  violations: string[]
): Map<number, number> {
  const additions = new Map<number, number>();
  for (const [rawPage, rawCount] of Object.entries(policy.annotationAdditions ?? {})) {
    const pageIndex = Number(rawPage);
    const count = Number(rawCount);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isInteger(count) || count < 0) {
      violations.push('the requested annotation-mutation policy was invalid.');
      continue;
    }
    if (count > 0) additions.set(pageIndex, count);
  }
  return additions;
}

export async function verifyPdfPreservation(
  editedBytes: PdfBytes,
  baseline: PdfPreservationSnapshot,
  policy: PdfMutationPolicy
): Promise<string[]> {
  const edited = await createPdfPreservationSnapshot(editedBytes);
  const violations: string[] = [];

  if (baseline.signedSignatures > 0 && edited.sourceHash !== baseline.sourceHash) {
    violations.push('the original PDF contains a completed digital signature; resaving would invalidate its signed byte ranges.');
  }
  if (edited.pdfVersion !== baseline.pdfVersion) violations.push(`PDF version changed (${baseline.pdfVersion ?? 'unknown'} → ${edited.pdfVersion ?? 'unknown'}).`);
  if (edited.metadata !== baseline.metadata) violations.push('standard document metadata changed.');
  if (edited.infoDictionary !== baseline.infoDictionary) violations.push('the PDF Info dictionary changed.');
  if (edited.trailerId !== baseline.trailerId) violations.push('the document trailer ID changed.');
  if (edited.encryption !== baseline.encryption) violations.push('document encryption/security state changed.');
  if (edited.catalogFingerprint !== baseline.catalogFingerprint) violations.push('the PDF catalog changed outside the page-content tree.');
  if (edited.signatureFields !== baseline.signatureFields) violations.push('the number of digital-signature fields changed.');
  if (edited.signedSignatures !== baseline.signedSignatures) violations.push('the number of completed digital signatures changed.');

  for (const key of PROTECTED_CATALOG_KEYS) {
    if (edited.catalog[key] !== baseline.catalog[key]) violations.push(`${describeCatalogKey(key)} changed.`);
  }
  if (edited.pageCount !== baseline.pageCount) violations.push(`page count changed (${baseline.pageCount} → ${edited.pageCount}).`);

  const sharedPageCount = Math.min(edited.pages.length, baseline.pages.length);
  const touchedPages = new Set<number>();
  for (const pageIndex of policy.touchedPages) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= baseline.pageCount) {
      violations.push('the requested page-mutation policy was invalid.');
    } else {
      touchedPages.add(pageIndex);
    }
  }

  const annotationAdditions = normalizeAnnotationAdditions(policy, violations);
  for (const pageIndex of annotationAdditions.keys()) {
    if (pageIndex >= baseline.pageCount) {
      violations.push('the requested annotation-mutation policy was invalid.');
      continue;
    }
    if (!touchedPages.has(pageIndex)) {
      violations.push(`page ${pageIndex + 1} allowed an annotation addition without being marked as intentionally edited.`);
    }
  }

  const strictPageScope = policy.strictPageScope !== false;
  for (let pageIndex = 0; pageIndex < sharedPageCount; pageIndex++) {
    const before = baseline.pages[pageIndex];
    const after = edited.pages[pageIndex];
    if (before.geometry !== after.geometry) violations.push(`page ${pageIndex + 1} size or rotation changed.`);
    if (before.inheritedAttributes !== after.inheritedAttributes) violations.push(`page ${pageIndex + 1} inherited page settings changed.`);
    if (!strictPageScope) continue;

    if (!touchedPages.has(pageIndex)) {
      if (before.full !== after.full) violations.push(`untouched page ${pageIndex + 1} changed.`);
      if (before.effectiveResources !== after.effectiveResources) violations.push(`resources used by untouched page ${pageIndex + 1} changed.`);
      continue;
    }

    if (before.protectedStatic !== after.protectedStatic) {
      violations.push(`page ${pageIndex + 1} changed outside the allowed text-content / resource scope.`);
    }
    const expectedAdditions = annotationAdditions.get(pageIndex) ?? 0;
    if (expectedAdditions === 0) {
      if (JSON.stringify(before.annotations) !== JSON.stringify(after.annotations)) {
        violations.push(`annotations on page ${pageIndex + 1} changed even though no annotation change was authorized.`);
      }
    } else {
      if (after.annotations.length !== before.annotations.length + expectedAdditions) {
        violations.push(`page ${pageIndex + 1} did not contain exactly ${expectedAdditions} authorized new annotation(s).`);
      }
      if (!isOrderedSubsequence(before.annotations, after.annotations)) {
        violations.push(`an existing annotation on page ${pageIndex + 1} was removed, reordered, or modified.`);
      }
    }
  }

  return Array.from(new Set(violations));
}
