type Paint = { fill?: string; stroke?: string; opacity?: string; 'fill-opacity'?: string; 'stroke-opacity'?: string }
export type IconDrawing = { paint: Paint; paths: (Paint & { d: string })[] }

const attributes = (text: string) => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]))
function paint(values: Record<string, string>): Paint {
  const result: Paint = {}
  for (const key of ['fill', 'stroke', 'opacity', 'fill-opacity', 'stroke-opacity'] as const) {
    if (values[key] !== undefined) result[key] = values[key] === '#5b73e8' ? 'var(--ui-accent, #5b73e8)' : values[key]
  }
  return result
}

/** Local, build-validated path-only artwork. Keep SVG inheritance without injecting markup. */
export function iconDrawing(source: string): IconDrawing {
  const root = attributes(source.match(/<svg\s+([^>]+)>/)?.[1] ?? '')
  return {
    paint: { fill: 'currentColor', stroke: 'none', ...paint(root) },
    paths: [...source.matchAll(/<path\s+([^>]+)\/?\s*>/g)].map(([, text]) => {
      const values = attributes(text!)
      return { d: values.d ?? '', ...paint(values) }
    }),
  }
}
