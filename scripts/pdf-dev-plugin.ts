import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/** Development-only bridge. Production always uses the bounded native process. */
export function pdfDevPlugin(): Plugin {
  return { name:'local-pdf-development', apply:'serve', configureServer(server) {
    server.middlewares.use('/__pdf-dev', (request,response) => {
      const host=request.headers.host || ''
      const listening=server.httpServer?.address()
      const localHost=listening && typeof listening==='object' && listening.address==='127.0.0.1' ? `127.0.0.1:${listening.port}` : null
      if(request.method!=='POST' || !localHost || host!==localHost || request.headers.origin!==`http://${localHost}` || !request.headers['content-type']?.startsWith('application/json')) {
        response.writeHead(403);response.end('Local development requests only');return
      }
      const pieces:Buffer[]=[];let size=0, finished=false
      const send=(status:number,body:string)=>{if(finished)return;finished=true;response.writeHead(status,{'Content-Type':'application/json'});response.end(body)}
      request.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>100*1024*1024){send(413,JSON.stringify({error:'Request too large'}));request.destroy()}else pieces.push(chunk)})
      request.on('end',()=>{
        if(finished)return
        const python=resolve('pdf-backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')
        if(!existsSync(python)){send(503,JSON.stringify({error:'Run npm run pdf:ensure to prepare the local PDF engine'}));return}
        const child=spawn(python,[resolve('pdf-backend/engine.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true})
        const output:Buffer[]=[];let outputSize=0
        const timeout=setTimeout(()=>{child.kill('SIGKILL');send(504,JSON.stringify({error:'PDF operation timed out'}))},90000)
        child.stdout.on('data',(chunk:Buffer)=>{outputSize+=chunk.length;if(outputSize>100*1024*1024){child.kill();send(502,JSON.stringify({error:'PDF output limit'}))}else output.push(chunk)})
        child.stderr.resume()
        child.stdin.on('error',()=>{})
        child.on('error',()=>{clearTimeout(timeout);send(503,JSON.stringify({error:'PDF engine unavailable'}))})
        child.on('exit',code=>{clearTimeout(timeout);send(code===0?200:502,Buffer.concat(output).toString('utf8')||JSON.stringify({error:'PDF process failed'}))})
        child.stdin.end(Buffer.concat(pieces))
      })
    })
  }}
}
