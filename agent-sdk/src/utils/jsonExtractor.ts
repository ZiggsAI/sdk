import { runtimeLog } from '../shared/runtimeLog.js';

export function extractJSON(content: string): string {
  if (!content || typeof content !== 'string') return '';

  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      content = jsonBlockMatch[1].trim();
    }
  }

  const firstBrace = content.indexOf('{');
  const firstBracket = content.indexOf('[');

  let startIdx = -1;
  let isArray = false;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    isArray = false;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    isArray = true;
  }

  if (startIdx === -1) return content.trim();

  const openChar = isArray ? '[' : '{';
  const closeChar = isArray ? ']' : '}';
  let depth = 0;
  let endIdx = startIdx;

  for (let i = startIdx; i < content.length; i++) {
    const char = content[i];
    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    } else if (char === '"') {
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\') i++;
        i++;
      }
    }
  }

  if (endIdx > startIdx) content = content.substring(startIdx, endIdx);

  content = content.trim();
  content = content.replace(/(?<!:)\/\/.*$/gm, '');
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');
  content = content.replace(/,(\s*[}\]])/g, '$1');

  return content;
}

function repairJsonStrings(jsonText: string): string {
  if (!jsonText || typeof jsonText !== 'string') return jsonText;
  const validEscapes = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  let out = '';
  let inString = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = jsonText[i + 1];
      out += (next && validEscapes.has(next)) ? ch : '\\\\';
      continue;
    }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    out += ch;
  }
  return out;
}

export function safeParseJSON<T = unknown>(content: string, fallback: T | null = null): T | null {
  try {
    const extracted = extractJSON(content);
    if (!extracted || extracted.trim().length === 0) throw new Error('Empty JSON content');
    try {
      return JSON.parse(extracted) as T;
    } catch {
      return JSON.parse(repairJsonStrings(extracted)) as T;
    }
  } catch {
    runtimeLog.error('JSONExtractor', 'Error parsing JSON', content.length > 500 ? `${content.slice(0, 500)}…` : content);
    return fallback ?? null;
  }
}
