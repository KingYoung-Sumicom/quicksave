/**
 * Path matching for subscription patterns.
 *
 * Patterns use `:name` for single-segment params (e.g. `/sessions/:id`).
 * Segments are separated by `/`. Leading `/` is optional but normalized away.
 *
 * Priority: static segments beat params at the same position.
 * Example: `/sessions/active` is preferred over `/sessions/:id` when matching
 * the path `/sessions/active`.
 */

export type PathPattern = {
  pattern: string;
  segments: Segment[];
  specificity: number;
};

type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string };

function normalize(path: string): string {
  if (path.length === 0) return '';
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function parsePattern(pattern: string): PathPattern {
  const normalized = normalize(pattern);
  const rawSegments = normalized.length === 0 ? [] : normalized.split('/');
  const segments: Segment[] = rawSegments.map((seg) => {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      if (name.length === 0) {
        throw new Error(`Invalid pattern "${pattern}": param must have a name`);
      }
      return { kind: 'param', name };
    }
    return { kind: 'static', value: seg };
  });
  // Specificity: each static segment contributes a higher weight than a param.
  // Longer paths are more specific than shorter ones at equal static counts.
  let specificity = 0;
  for (const seg of segments) {
    specificity = specificity * 4 + (seg.kind === 'static' ? 2 : 1);
  }
  return { pattern, segments, specificity };
}

export function matchPattern(
  pattern: PathPattern,
  path: string,
): Record<string, string> | null {
  const pathSegments = normalize(path).split('/');
  const normalizedPath = normalize(path);
  const actualSegments = normalizedPath.length === 0 ? [] : pathSegments;
  if (actualSegments.length !== pattern.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.segments.length; i++) {
    const patternSeg = pattern.segments[i]!;
    const pathSeg = actualSegments[i]!;
    if (patternSeg.kind === 'static') {
      if (patternSeg.value !== pathSeg) return null;
    } else {
      if (pathSeg.length === 0) return null;
      params[patternSeg.name] = pathSeg;
    }
  }
  return params;
}

/**
 * Sort patterns by descending specificity so the first match wins.
 * Mutates the input array.
 */
export function sortPatternsBySpecificity<T extends { pattern: PathPattern }>(
  entries: T[],
): T[] {
  entries.sort((a, b) => b.pattern.specificity - a.pattern.specificity);
  return entries;
}
