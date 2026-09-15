// 動作確認用の静的サーバ。配布物ではない(index.html は file:// で直接開ける)。
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=__dirname;
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.heic':'image/heic'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end('404');}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f).toLowerCase()]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
}).listen(8777,()=>console.log('http://localhost:8777'));
