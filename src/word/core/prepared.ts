import type { NativeDocument } from '../../types'
import type { WordDocument } from './model'

type DocumentSource = Pick<NativeDocument, 'id' | 'base64'>

/** A single delivery to the editor, never a document cache or tab snapshot. */
export interface PreparedWordDocument {
  take(source: DocumentSource): WordDocument | undefined
  discard(): void
}

export function prepareWordDocument(source: DocumentSource, model: WordDocument): PreparedWordDocument {
  let pending: { id: string; base64: string; model: WordDocument } | undefined = { id: source.id, base64: source.base64, model }
  return {
    take(source) {
      const value = pending
      pending = undefined
      return value?.id === source.id && value.base64 === source.base64 ? value.model : undefined
    },
    discard() { pending = undefined },
  }
}
