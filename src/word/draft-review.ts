import type { WriterState } from './types'

export interface WriterDraftOrigin { id: string; revision: number; selection: string; styleName: string }
export interface WriterDraftReview {
  panel: 'page' | 'header' | 'footer'; documentId: string; revision: number; selectionId: string; styleName: string
  draftJson: string; targetJson: string; rows: Array<{ label: string; current: string; proposed: string }>
}
const pageFields = [['width','纸张宽度'],['height','纸张高度'],['marginTop','上边距'],['marginBottom','下边距'],['marginLeft','左边距'],['marginRight','右边距']] as const
function targetValues(panel: WriterDraftReview['panel'], state: WriterState) {
  if (panel === 'page') return pageFields.map(([key]) => state.page[key])
  return panel === 'header' ? [state.page.headerEnabled,state.page.headerText,state.page.headerTruncated] : [state.page.footerEnabled,state.page.footerText,state.page.footerTruncated]
}
export function createWriterDraftReview(panel: WriterDraftReview['panel'], state: WriterState, draft: Record<string,string>, origin: WriterDraftOrigin): WriterDraftReview {
  if (!state || state.documentId !== origin.id || state.selection.id !== origin.selection || state.page.styleName !== origin.styleName)
    throw Error('文档、光标或页面样式已改变，不能将这份输入转移到其他目标。输入已保留。')
  if (!Number.isSafeInteger(state.revision) || state.revision < origin.revision) throw Error('未取得当前文档版本，输入已保留。')
  if (!['page','header','footer'].includes(panel)) throw Error('此输入暂不支持重新核对，请在画布中编辑。')
  const rows: WriterDraftReview['rows'] = []
  if (panel === 'page') for (const [key,label] of pageFields) rows.push({label:label+'（毫米）',current:String(state.page[key]),proposed:draft[key]})
  else {
    const header=panel==='header',enabled=header?state.page.headerEnabled:state.page.footerEnabled,truncated=header?state.page.headerTruncated:state.page.footerTruncated
    if (enabled || truncated) throw Error('当前页眉或页脚已启用，或仅有摘要，可能含字段和图片。请保留输入并在画布中核对；此处不会替换复杂内容。')
    rows.push({label:'启用状态',current:'关闭',proposed:draft.enabled==='true'?'启用':'关闭'}, {label:header?'页眉文字':'页脚文字',current:header?state.page.headerText:state.page.footerText,proposed:draft.text})
  }
  return {panel,documentId:state.documentId,revision:state.revision,selectionId:state.selection.id,styleName:state.page.styleName,draftJson:JSON.stringify(draft),targetJson:JSON.stringify(targetValues(panel,state)),rows}
}
export function writerDraftReviewMatches(review: WriterDraftReview, state: WriterState | null | undefined, draft: Record<string,string>): boolean {
  return !!state && review.documentId===state.documentId && review.revision===state.revision && review.selectionId===state.selection.id && review.styleName===state.page.styleName && review.draftJson===JSON.stringify(draft) && review.targetJson===JSON.stringify(targetValues(review.panel,state))
}
