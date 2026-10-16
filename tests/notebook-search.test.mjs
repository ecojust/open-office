import test from 'node:test'
import assert from 'node:assert/strict'
import { createNoteSearchHighlighter, noteSearchMatches, searchSegments } from '../src/notes/search.ts'

test('search segments preserve original literal text and casing without interpreting markup or regular expressions', () => {
 const source = '<b>Price [a+b] 中文😀 PRICE [A+B]</b>'
 const segments = searchSegments(source, ' [a+b] ')
 assert.equal(segments.map(part => part.text).join(''), source)
 assert.deepEqual(segments.filter(part => part.match).map(part => part.text), ['[a+b]','[A+B]'])
 assert.deepEqual(searchSegments(source, '   '), [{ text:source, match:false }])
 assert.deepEqual(searchSegments('', 'x'), [{ text:'', match:false }])
 assert.deepEqual(noteSearchMatches('aaaa', 'aa'), [{ start:0, end:2 },{ start:2, end:4 }])
})

test('Unicode casing expansions and supplementary characters keep valid source offsets', () => {
 assert.deepEqual(searchSegments('😀İstanbul İSTANBUL', 'i').filter(part => part.match), [{ text:'İ', match:true },{ text:'İ', match:true }])
 assert.deepEqual(searchSegments('Straße STRASSE', 'strasse').filter(part => part.match), [{ text:'Straße', match:true },{ text:'STRASSE', match:true }])
 assert.deepEqual(noteSearchMatches('ß', 's'), [{ start:0, end:1 }])
 assert.deepEqual(noteSearchMatches('😀𐐀x𐐨', '𐐨'), [{ start:2, end:4 },{ start:5, end:7 }])
 assert.deepEqual(searchSegments('ΟΣ ος οσ', 'οσ').filter(part => part.match).map(part => part.text), ['ΟΣ','ος','οσ'])
 assert.deepEqual(searchSegments('ﬃ', 'ffi'), [{ text:'ﬃ', match:true }])
 assert.deepEqual(searchSegments('µ Μ μ', 'μ').filter(part => part.match).map(part => part.text), ['µ','Μ','μ'])
 assert.deepEqual(noteSearchMatches('ı I i', 'i'), [{ start:2, end:3 },{ start:4, end:5 }])
})

function environment({ native=true } = {}) {
 const frames = new Map(), observers = [], resizeObservers = [], listeners = new Map(), registry = new Map()
 let nextFrame = 0
 const document = { createRange() {
  return { setStart(node, offset) { this.startContainer=node;this.startOffset=offset }, setEnd(node, offset) { this.endContainer=node;this.endOffset=offset },
   getClientRects() { return [{ left:0,top:10,right:100,bottom:50 }] } }
 }, createElement:tag=>element(tag), createDocumentFragment:()=>element('#fragment'),
  addEventListener:(event, fn)=>listeners.set(`document:${event}`,fn), removeEventListener:event=>listeners.delete(`document:${event}`),
  getSelection() { throw Error('Highlighting must not inspect or change selection') },
 }
 const view = document.defaultView = {
  CSS:native ? { highlights:registry } : {}, Highlight:native ? class { constructor() { this.ranges=[] } add(range) { this.ranges.push(range) } } : undefined,
  MutationObserver:class { constructor(callback) { this.callback=callback;this.elements=[];observers.push(this) } observe(element) { this.elements.push(element) } disconnect() { this.elements=[] } },
  ResizeObserver:class { constructor(callback) { this.callback=callback;this.elements=[];resizeObservers.push(this) } observe(element) { this.elements.push(element) } disconnect() { this.elements=[] } },
  requestAnimationFrame:callback=>{const id=++nextFrame;frames.set(id,callback);return id},cancelAnimationFrame:id=>frames.delete(id),
  addEventListener:(event, fn)=>listeners.set(`window:${event}`,fn),removeEventListener:event=>listeners.delete(`window:${event}`),
  getComputedStyle:node=>node.computed ?? {overflowX:'visible',overflowY:'visible'},innerWidth:200,innerHeight:100,
 }
 function element(tag, children=[], attributes={}) {
  const item = { nodeType:1,tagName:tag.toUpperCase(),style:{},dataset:{},ownerDocument:document,isConnected:true,childNodes:[],parentElement:null,
   getAttribute:key=>attributes[key] ?? null,setAttribute:(key,value)=>{attributes[key]=value},
   get textContent() { return this.childNodes.map(child=>child.textContent ?? '').join('') },
   set textContent(value) { this.childNodes=[text(value)] },
   append(...nodes) { for (const node of nodes) { this.childNodes.push(node);node.parentElement=this } },
   remove() { const parent=this.parentElement;if(parent)parent.childNodes=parent.childNodes.filter(node=>node!==this);this.parentElement=null },
   replaceChildren(fragment) { this.childNodes=[...fragment.childNodes];for(const child of this.childNodes)child.parentElement=this },
  }
  item.append(...children);return item
 }
 function text(value) { return { nodeType:3,textContent:value,parentElement:null,ownerDocument:document } }
 document.head=element('head');document.body=element('body')
 return { document,view,element,text,registry,observers,resizeObservers,frames,listeners,flush() { const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback()) } }
}

test('native highlights span inline formatting but omit controls and cannot match across unrelated blocks or regions', () => {
 const env=environment(), {element,text,document}=env
 const first=text('hel'),second=text('LO'), editable=element('div',[
  element('p',[first,element('strong',[second]),element('button',[text('hello')]),element('span',[text('hello')],{'aria-hidden':'true'})]),
  element('p',[text('hel')]),element('p',[text('lo')]),element('span',[text('hello')],{contenteditable:'false'}),
 ])
 const otherRegion=element('div',[text('lo')]), helper=createNoteSearchHighlighter(document)
 const original=editable.textContent
 helper.refresh([editable,otherRegion], 'hello')
 const ranges=[...env.registry.values()][0].ranges
 assert.equal(ranges.length,1);assert.equal(ranges[0].startContainer,first);assert.equal(ranges[0].startOffset,0)
 assert.equal(ranges[0].endContainer,second);assert.equal(ranges[0].endOffset,2)
 assert.equal(editable.textContent,original);assert.equal(editable.childNodes[0].childNodes[1].tagName,'STRONG')
 assert.equal(document.body.childNodes.length,0,'No decoration is inserted in the document or editable content')
 helper.destroy();assert.equal(env.registry.size,0);assert.equal(document.head.childNodes.length,0)
})

test('each notebook owns its persistent highlights and refresh follows editing, page navigation and clearing', () => {
 const env=environment(), node=env.text('needle'), page=env.element('div',[node]), other=env.element('div',[env.text('needle')])
 const first=createNoteSearchHighlighter(env.document), second=createNoteSearchHighlighter(env.document)
 first.refresh([page], 'needle');second.refresh([other], 'needle')
 assert.equal(env.registry.size,2)
 node.textContent='changed needle needle';env.observers[0].callback();env.flush()
 assert.equal([...env.registry.values()][0].ranges.length,2)
 first.refresh([env.element('div',[env.text('no matching text')])], 'needle')
 assert.equal([...env.registry.values()].filter(highlight=>highlight.ranges.length===0).length,1)
 assert.equal(env.registry.size,2)
 first.refresh([page], '');assert.equal(env.registry.size,1);assert.equal(env.observers[0].elements.length,0)
 second.destroy();assert.equal(env.registry.size,0)
 first.destroy();assert.equal(env.document.head.childNodes.length,0)
 first.refresh([page], 'needle');assert.equal(env.registry.size,0,'Destroyed editors cannot leave new highlights behind')
})

test('fallback paints noninteractive clipped rectangles, updates on scrolling and removes decorations on clear', () => {
 const env=environment({native:false}), page=env.element('div',[env.text('needle')]), scroller=env.element('div',[page])
 Object.assign(scroller,{computed:{overflowX:'auto',overflowY:'auto'},clientLeft:0,clientTop:0,clientWidth:120,clientHeight:30,getBoundingClientRect:()=>({left:10,top:20})})
 env.document.body.append(scroller)
 const helper=createNoteSearchHighlighter(env.document);helper.refresh([page], 'needle')
 const layer=env.document.body.childNodes.find(node=>node.dataset.noteSearchOverlay)
 assert.ok(layer);assert.equal(layer.style.pointerEvents,'none');assert.equal(layer.getAttribute('aria-hidden'),'true')
 assert.deepEqual(Object.fromEntries(['left','top','width','height'].map(key=>[key,layer.childNodes[0].style[key]])),{left:'10px',top:'20px',width:'90px',height:'30px'})
 assert.equal(page.childNodes.length,1);assert.equal(page.textContent,'needle')
 env.listeners.get('document:scroll')();assert.equal(env.frames.size,1);env.flush();assert.equal(layer.childNodes.length,1)
 env.resizeObservers[0].callback();assert.equal(env.frames.size,1)
 helper.clear();assert.equal(env.frames.size,0);assert.equal(env.listeners.size,0);assert.equal(env.document.body.childNodes.length,1)
 assert.equal(env.resizeObservers[0].elements.length,0);assert.equal(env.observers[0].elements.length,0)
 helper.destroy()
})
