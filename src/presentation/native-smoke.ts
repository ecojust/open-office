import { parsePptxPackage } from './pptx-package'
import { base64ToBytes } from '../shared/document'
import type { OfficeExportResult } from '../office/types'
import type { PresentationAction, PresentationState } from './types'

interface Editor {
  presentationAction(action: PresentationAction): Promise<PresentationState>
  presentationObjectData(query: {type: 'table'|'chart'; id: string}): Promise<unknown>
  presentationEdit(patch: {transition: {type:'fade';durationMs:number};addMedia: Array<{kind:'audio';name:string;mimeType:string;data:Uint8Array;rect:{x:number;y:number;width:number;height:number};start:'click'}>}): Promise<void>
  exportFile(options?: {format:'pptx'|'pdf'}): Promise<OfficeExportResult>
  getPresentationState(): Promise<PresentationState>
}
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(`Presentation workbench: ${message}`) }
function wav() {
  const bytes=new Uint8Array(44+3200), view=new DataView(bytes.buffer), encoder=new TextEncoder()
  const text=(offset:number,value:string)=>bytes.set(encoder.encode(value),offset)
  text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true)
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true)
  view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,3200,true)
  return bytes
}
async function until(check:()=>boolean, message:string) {
  const deadline=Date.now()+25000
  while(!check()) {if(Date.now()>deadline)throw Error(message);await new Promise(resolve=>setTimeout(resolve,100))}
}
// Runs inside the delivered native WebView, using the actual OfficeEditor,
// package adapter, PDF.js canvas and media element. No browser/tool mocks.
export async function verifyNativePresentation(options: {
  create(): Promise<Editor>; reopen(base64:string): Promise<Editor>
  show(pdf:string,presentation:Awaited<ReturnType<typeof parsePptxPackage>>):Promise<void>; close():void
}) {
  let editor=await options.create()
  await editor.presentationAction({type:'rename-page',pageIndex:0,name:'Native saved page 中文'})
  await editor.presentationAction({type:'insert-text',text:'Native workbench editable 中文',x:15,y:15,width:180,height:20})
  await editor.presentationAction({type:'set-notes',pageIndex:0,text:'Native notes persisted 备注'})
  await editor.presentationAction({type:'insert-table',rows:2,columns:2,cells:[['项目','值'],['本机','42']],x:15,y:45,width:100,height:35})
  await editor.presentationAction({type:'insert-chart',chartType:'column',categories:['一','二'],series:['本机'],values:[[12],[24]],title:'Native editable chart',x:135,y:45,width:100,height:70})
  await editor.presentationAction({type:'add-page',layout:20})
  await editor.presentationAction({type:'insert-text',text:'Native second slide',x:20,y:20,width:150,height:20})
  await editor.presentationAction({type:'add-page',layout:20})
  await editor.presentationAction({type:'set-hidden',pageIndex:2,value:true})
  await editor.presentationAction({type:'select-page',pageIndex:0})
  await editor.presentationEdit({transition:{type:'fade',durationMs:300},addMedia:[{kind:'audio',name:'Native offline audio.wav',mimeType:'audio/wav',data:wav(),rect:{x:.05,y:.85,width:.3,height:.1},start:'click'}]})
  const output=await editor.exportFile({format:'pptx'}), document=await parsePptxPackage(base64ToBytes(output.base64))
  assert(document.slides.length===3 && document.slides[2]!.hidden,'hidden slide and page count must survive export')
  assert(document.slides[0]!.transition.type==='fade' && document.slides[0]!.media[0]?.data?.length===3244,'actual OOXML transition/audio bytes missing')
  editor=await options.reopen(output.base64)
  const state=await editor.getPresentationState()
  assert(state.pages[0]?.name==='Native saved page 中文','saved slide name must reopen')
  assert(state.currentPage.notes.includes('Native notes persisted'),'speaker notes must reopen')
  assert(state.objects.some(shape=>shape.text.includes('Native workbench editable 中文')),'text must remain editable')
  const table=state.objects.find(shape=>shape.type==='table'),chart=state.objects.find(shape=>shape.type==='chart')
  assert(table && chart,'table and chart must remain native editable objects')
  const tableData=await editor.presentationObjectData({type:'table',id:table.id}), chartData=await editor.presentationObjectData({type:'chart',id:chart.id})
  assert(JSON.stringify(tableData).includes('本机') && JSON.stringify(chartData).includes('24'),'embedded object data must reopen')
  const resaved=await editor.exportFile({format:'pptx'}), replay=await parsePptxPackage(base64ToBytes(resaved.base64))
  assert(replay.slides[0]?.transition.type==='fade' && replay.slides[0]?.media[0]?.data?.length===3244,'transition and audio must survive reopening and a second save')
  const pdf=await editor.exportFile({format:'pdf'})
  try {
    await options.show(pdf.base64,replay)
    await until(()=>documentQuery('[data-testid="slide-preview-canvas"]')?.getAttribute('data-page-index')==='0' && documentQuery('[data-testid="slide-preview"]')?.getAttribute('data-rendering')==='false','Native presentation canvas did not render')
    const audio=documentQuery('audio.slide-media') as HTMLAudioElement | null
    assert(audio,'embedded audio element missing')
    await until(()=>audio.readyState>=1 && Number.isFinite(audio.duration),'Native embedded audio metadata did not load under the application CSP')
    const mediaDuration=audio.duration
    assert(Math.abs(mediaDuration-.2)<.05,'native WAV duration differs from fixture')
    const next=documentQuery('[data-testid="slide-preview-next"]') as HTMLButtonElement | null
    assert(next && !next.disabled,'next visible page unavailable');next.click()
    await until(()=>documentQuery('[data-testid="slide-preview-canvas"]')?.getAttribute('data-page-index')==='1' && documentQuery('[data-testid="slide-preview"]')?.getAttribute('data-rendering')==='false','Native second page did not render')
    assert((documentQuery('[data-testid="slide-preview-next"]') as HTMLButtonElement)?.disabled,'hidden final page was not skipped')
    return {ok:true,pageCount:state.pageCount,hiddenPageIndex:2,slideName:state.pages[0]!.name,notes:state.currentPage.notes,
      editableTable:true,editableChart:true,transition:document.slides[0]!.transition.type,mediaBytes:3244,mediaDuration,pdfCanvasPages:[0,1]}
  } finally { options.close() }
}
function documentQuery(selector:string) { return window.document.querySelector(selector) }
