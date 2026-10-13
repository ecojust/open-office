import { P, A, R, PR, child, children, readXml, relPart, relativePart, resolvePart } from './pptx-common'

/** The writer is structural so notes scaffolding does not own the archive. */
interface NotesWriter {
  parts: Map<string, Uint8Array>
  unique(stem: string, extension?: string): string
  put(part: string, content: string | Uint8Array, mime?: string): void
  rels(part: string, sourcePart?: string): Document
  relation(doc: Document, from: string, target: string, kind: string): string
  saveRels(part: string, document: Document): void
}

/** Notes masters are required by standard presentation consumers. Preserve all
 * source notes masters, adding a default only for newly created notes slides. */
export function ensureNotesMasters(writer: NotesWriter, presentation: Document, presentationRels: Document, presentationPart: string, themeXml: string): void {
  const currentRels = (part: string) => { const bytes = writer.parts.get(relPart(part)); return bytes ? readXml(bytes) : readXml(`<Relationships xmlns="${PR}"/>`) }
  const activeIds = new Set(children(child(presentation.documentElement, 'sldIdLst')).map(node => node.getAttributeNS(R, 'id')))
  const notes = new Set<string>()
  for (const relation of children(presentationRels.documentElement)) {
    if (!(relation.getAttribute('Type') || '').endsWith('/slide') || !activeIds.has(relation.getAttribute('Id'))) continue
    const slidePart = resolvePart(presentationPart, relation.getAttribute('Target') || ''), rels = currentRels(slidePart)
    for (const rel of children(rels.documentElement)) if ((rel.getAttribute('Type') || '').endsWith('/notesSlide') && rel.getAttribute('TargetMode') !== 'External') notes.add(resolvePart(slidePart, rel.getAttribute('Target') || ''))
  }
  const missing: Array<{ part: string; rels: Document }> = []
  for (const part of notes) { const rels = currentRels(part); if (!children(rels.documentElement).some(rel => (rel.getAttribute('Type') || '').endsWith('/notesMaster'))) missing.push({ part, rels }) }
  if (!missing.length) return

  let masterRelation = children(presentationRels.documentElement).find(rel => (rel.getAttribute('Type') || '').endsWith('/notesMaster') && rel.getAttribute('TargetMode') !== 'External')
  let masterPart = masterRelation ? resolvePart(presentationPart, masterRelation.getAttribute('Target') || '') : undefined
  if (!masterPart || !writer.parts.has(masterPart)) {
    masterPart = writer.unique('ppt/notesMasters/canvasNotesMaster')
    let themePart = [...writer.parts.keys()].find(part => /^ppt\/theme\/[^/]+\.xml$/.test(part))
    if (!themePart) { themePart = writer.unique('ppt/theme/canvasNotesTheme'); writer.put(themePart, themeXml, 'application/vnd.openxmlformats-officedocument.theme+xml') }
    const style = '<a:lvl1pPr algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>'
    writer.put(masterPart, `<p:notesMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld name="Notes Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4114800"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${'<a:p><a:endParaRPr lang="zh-CN"/></a:p>'}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:hf hdr="0" ftr="0" dt="0" sldNum="0"/><p:notesStyle>${style}</p:notesStyle></p:notesMaster>`, 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml')
    const rels = readXml(`<Relationships xmlns="${PR}"/>`)
    writer.relation(rels, masterPart, themePart, 'theme'); writer.saveRels(masterPart, rels)
    if (masterRelation) masterRelation.setAttribute('Target', relativePart(presentationPart, masterPart))
    else { const id = writer.relation(presentationRels, presentationPart, masterPart, 'notesMaster'); masterRelation = children(presentationRels.documentElement).find(rel => rel.getAttribute('Id') === id)! }
  }
  let list = child(presentation.documentElement, 'notesMasterIdLst')
  if (!list) {
    list = presentation.createElementNS(P, 'p:notesMasterIdLst')
    presentation.documentElement.insertBefore(list, children(presentation.documentElement).find(node => !['sldMasterIdLst', 'notesMasterIdLst'].includes(node.localName)) || null)
  }
  if (!children(list).some(node => node.getAttributeNS(R, 'id') === masterRelation!.getAttribute('Id'))) {
    const item = presentation.createElementNS(P, 'p:notesMasterId'); item.setAttributeNS(R, 'r:id', masterRelation!.getAttribute('Id')!); list.appendChild(item)
  }
  for (const note of missing) { writer.relation(note.rels, note.part, masterPart, 'notesMaster'); writer.saveRels(note.part, note.rels) }
}
