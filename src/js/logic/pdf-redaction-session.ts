import type {
  FormattedSelection,
  PdfRect,
} from './pdf-editor-session.js';

export type PendingRedactionItem = {
  id: string;
  page: number;
  [key: string]: any;
};

export type IsolatedRedactionSession = {
  scope: any;
  preservedItems: PendingRedactionItem[];
  preservedSelection: { page: number; id: string } | null;
  queuedItems: PendingRedactionItem[];
  originalActiveType: string | null;
  commitStarted: boolean;
  closed: boolean;
};

export function restoreRedactionSession(
  session: IsolatedRedactionSession
): void {
  if (session.closed) return;
  session.closed = true;

  try {
    session.scope.clearPending();
    if (session.preservedItems.length > 0) {
      session.scope.addPending(session.preservedItems);
    }

    if (session.preservedSelection) {
      const selectedStillExists = session.preservedItems.some(
        (item) =>
          item.page === session.preservedSelection?.page &&
          item.id === session.preservedSelection?.id
      );
      if (selectedStillExists) {
        session.scope.selectPending(
          session.preservedSelection.page,
          session.preservedSelection.id
        );
      }
    }
  } finally {
    session.scope.endRedact?.();
    switch (session.originalActiveType) {
      case 'redact':
        session.scope.enableRedact?.();
        break;
      case 'marqueeRedact':
        session.scope.enableMarqueeRedact?.();
        break;
      case 'redactSelection':
        session.scope.enableRedactSelection?.();
        break;
    }
  }
}

export async function queueIsolatedSelection(
  registry: any,
  documentId: string,
  formattedSelection: FormattedSelection[]
): Promise<IsolatedRedactionSession> {
  const scope = registry
    .getPlugin('redaction')
    .provides()
    .forDocument(documentId) as any;
  const originalActiveType = scope.getState?.().activeType ?? null;
  const preservedItems = flattenPendingRedactions(scope);
  const preservedSelection = scope.getSelectedPending?.() ?? null;

  for (const item of preservedItems) {
    scope.removePending(item.page, item.id);
  }

  const session: IsolatedRedactionSession = {
    scope,
    preservedItems,
    preservedSelection,
    queuedItems: [],
    originalActiveType,
    commitStarted: false,
    closed: false,
  };

  try {
    const requestedItems = buildTransparentRedactionItems(
      formattedSelection
    );
    scope.addPending(requestedItems);
    session.queuedItems = flattenPendingRedactions(scope);

    const queuedIds = new Set(session.queuedItems.map((item) => item.id));
    if (
      requestedItems.length === 0 ||
      session.queuedItems.length !== requestedItems.length ||
      requestedItems.some((item) => !queuedIds.has(item.id))
    ) {
      throw new Error(
        'Could not isolate the selected text for transparent removal.'
      );
    }

    return session;
  } catch (error) {
    restoreRedactionSession(session);
    throw error;
  }
}

export async function commitIsolatedRedactions(
  session: IsolatedRedactionSession
): Promise<void> {
  session.commitStarted = true;
  try {
    const redacted = await session.scope.commitAllPending().toPromise();
    if (!redacted) {
      throw new Error('The PDF engine did not confirm text removal.');
    }
  } finally {
    restoreRedactionSession(session);
  }
}

function flattenPendingRedactions(scope: any): PendingRedactionItem[] {
  const pending = scope.getState?.().pending ?? {};
  return Object.values(pending).flatMap((items) =>
    Array.isArray(items) ? (items as PendingRedactionItem[]) : []
  );
}

function buildTransparentRedactionItems(
  formattedSelection: FormattedSelection[]
): PendingRedactionItem[] {
  return formattedSelection.map((selection) => {
    const rects = selection.segmentRects?.filter(validPdfRect) ?? [];
    const effectiveRects =
      rects.length > 0
        ? rects
        : validPdfRect(selection.rect)
          ? [selection.rect]
          : [];

    if (effectiveRects.length === 0) {
      throw new Error(
        `Page ${selection.pageIndex + 1} did not provide a valid text-selection area.`
      );
    }

    return {
      id: createRandomId('remove'),
      kind: 'text',
      page: selection.pageIndex,
      rect: validPdfRect(selection.rect)
        ? selection.rect
        : unionRects(effectiveRects),
      rects: effectiveRects,
      source: 'legacy',
      markColor: '#FF0000',
      redactionColor: 'transparent',
    };
  });
}

export function validPdfRect(rect: PdfRect): boolean {
  return (
    Number.isFinite(rect?.origin?.x) &&
    Number.isFinite(rect?.origin?.y) &&
    Number.isFinite(rect?.size?.width) &&
    Number.isFinite(rect?.size?.height) &&
    rect.size.width > 0 &&
    rect.size.height > 0
  );
}

export function selectionRects(
  formattedSelection: FormattedSelection[]
): PdfRect[] {
  return formattedSelection.flatMap((selection) => {
    const segments = selection.segmentRects?.filter(validPdfRect) ?? [];
    if (segments.length > 0) return segments;
    return validPdfRect(selection.rect) ? [selection.rect] : [];
  });
}

export function unionRects(rects: PdfRect[]): PdfRect {
  if (rects.length === 0 || rects.some((rect) => !validPdfRect(rect))) {
    throw new Error('The selected text did not provide a valid PDF area.');
  }

  const left = Math.min(...rects.map((rect) => rect.origin.x));
  const top = Math.min(...rects.map((rect) => rect.origin.y));
  const right = Math.max(
    ...rects.map((rect) => rect.origin.x + rect.size.width)
  );
  const bottom = Math.max(
    ...rects.map((rect) => rect.origin.y + rect.size.height)
  );

  return {
    origin: { x: left, y: top },
    size: {
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    },
  };
}

export function createRandomId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const random = new Uint8Array(16);
    globalThis.crypto.getRandomValues(random);
    return `${prefix}-${Array.from(random)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
