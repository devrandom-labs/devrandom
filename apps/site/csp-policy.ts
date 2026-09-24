import { createHash } from 'node:crypto';

function sourceHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
}

function decodedAttribute(value: string): string {
  return value.replaceAll(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      default: {
        const hexadecimal = entity.startsWith('&#x');
        const digits = entity.slice(hexadecimal ? 3 : 2, -1);
        const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
        if (!Number.isSafeInteger(codePoint)) {
          throw new Error('Static HTML contains an invalid encoded style attribute');
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
}

function inlineElementSources(document: string, element: 'script' | 'style'): readonly string[] {
  const expression = new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)</${element}>`, 'giu');
  const sources: string[] = [];
  for (const match of document.matchAll(expression)) {
    const source = match[1];
    const openingTag = match[0].slice(0, match[0].indexOf('>') + 1);
    if (source !== undefined && source.length > 0 && !/\ssrc=/iu.test(openingTag)) {
      sources.push(source);
    }
  }
  return sources;
}

function inlineStyleAttributes(document: string): readonly string[] {
  const sources: string[] = [];
  for (const match of document.matchAll(/\sstyle=(?:"([^"]*)"|'([^']*)')/giu)) {
    const encoded = match[1] ?? match[2];
    if (encoded !== undefined && encoded.length > 0) {
      sources.push(decodedAttribute(encoded));
    }
  }
  return sources;
}

function hashes(sources: readonly string[]): readonly string[] {
  return [...new Set(sources.map(sourceHash))].sort();
}

const runtimeStyleAttributes = [''] as const;

export function staticSiteContentSecurityPolicy(documents: readonly string[]): string {
  const scriptHashes = hashes(
    documents.flatMap((document) => inlineElementSources(document, 'script')),
  );
  const styleElementHashes = hashes(
    documents.flatMap((document) => inlineElementSources(document, 'style')),
  );
  const styleAttributeHashes = hashes([
    ...runtimeStyleAttributes,
    ...documents.flatMap(inlineStyleAttributes),
  ]);

  return [
    "default-src 'none'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trimEnd(),
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-hashes' ${[...styleElementHashes, ...styleAttributeHashes].join(' ')}`.trimEnd(),
    `style-src-attr 'unsafe-hashes' ${styleAttributeHashes.join(' ')}`.trimEnd(),
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
