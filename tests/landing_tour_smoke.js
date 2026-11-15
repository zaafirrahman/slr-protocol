// Uji logika carousel di landing (tombol, titik, keyboard, batas, prefers-reduced-motion) dengan DOM tiruan:  node tests/landing_tour_smoke.js
const fs=require('fs'),vm=require('vm'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','templates','landing.html'),'utf8');
const code=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
let ok=0,bad=0;const t=(c,m)=>{c?ok++:(bad++,console.log('GAGAL:',m))};
function mkEl(extra={}){const L={};return Object.assign({listeners:L,attrs:{},disabled:false,textContent:'',addEventListener(e,f){(L[e]=L[e]||[]).push(f)},setAttribute(k,v){this.attrs[k]=String(v)},getAttribute(k){return this.attrs[k]}},extra)}
function run({reduce=false}={}){
  const N=8, slides=[...Array(N)].map((_,i)=>mkEl({offsetLeft:i*1100}));
  const dots=[...Array(N)].map(()=>mkEl()), prev=mkEl(), next=mkEl(), count=mkEl({textContent:'1 / 8'});
  const calls=[]; const track=mkEl({scrollLeft:0,children:slides,scrollTo(o){calls.push(o);this.scrollLeft=o.left;(this.listeners.scroll||[]).forEach(f=>f());flush()}});
  const tour=mkEl({querySelector:s=>s==='.tour-track'?track:s==='[data-dir="-1"]'?prev:s==='[data-dir="1"]'?next:s==='.tour-count'?count:null,querySelectorAll:s=>s==='.tour-dot'?dots:[]});
  const htmlEl={classList:{add:c=>htmlEl.cls=(htmlEl.cls||[]).concat(c)}};
  const q=[]; const flush=()=>{while(q.length)q.shift()()}; const win={matchMedia:()=>({matches:reduce}),addEventListener(){}, requestAnimationFrame:f=>{q.push(f);return q.length}};
  vm.runInContext(code,vm.createContext({document:{documentElement:htmlEl,getElementById:id=>id==='tour'?tour:null},window:win,requestAnimationFrame:win.requestAnimationFrame,Array,Math}));
  const key=(k)=>{let pd=false;(track.listeners.keydown||[]).forEach(f=>f({key:k,preventDefault(){pd=true}}));return pd};
  return {slides,dots,prev,next,count,track,calls,htmlEl,key,flush};
}
let r=run();
t((r.htmlEl.cls||[]).includes('js'),'kelas js ditambahkan ke <html>');
t(r.count.textContent==='1 / 8' && r.prev.disabled===true && r.next.disabled===false,'awal: 1 / 8, tombol sebelumnya nonaktif');
t(r.dots[0].attrs['aria-current']==='true' && r.dots[1].attrs['aria-current']==='false','awal: titik pertama aktif');
r.next.listeners.click[0](); t(r.calls[0].left===1100 && r.calls[0].behavior==='smooth','tombol berikutnya menggulir ke slide 2 (smooth)');
t(r.count.textContent==='2 / 8' && r.dots[1].attrs['aria-current']==='true' && r.prev.disabled===false,'setelah scroll: 2 / 8, titik 2 aktif, tombol sebelumnya aktif');
r.track.scrollLeft=3*1100+40; r.track.listeners.scroll[0](); r.track.listeners.scroll[0](); r.flush(); t(r.count.textContent==='4 / 8','geser manual mendekati slide 4 -> 4 / 8 (snap terdekat)');
t(r.key('ArrowRight')===true && r.calls.at(-1).left===4*1100,'ArrowRight -> slide 5 dan default dicegah');
r.key('ArrowLeft'); t(r.calls.at(-1).left===3*1100,'ArrowLeft -> slide 4');
r.key('End'); t(r.calls.at(-1).left===7*1100 && r.count.textContent==='8 / 8' && r.next.disabled===true && r.prev.disabled===false,'End -> slide 8, tombol berikutnya nonaktif');
r.next.listeners.click[0](); t(r.calls.at(-1).left===7*1100,'tombol berikutnya di slide terakhir tidak melewati batas');
r.key('Home'); t(r.count.textContent==='1 / 8' && r.prev.disabled===true,'Home -> slide 1');
r.prev.listeners.click[0](); t(r.calls.at(-1).left===0,'tombol sebelumnya di slide pertama tidak melewati batas');
r.dots[5].listeners.click[0](); t(r.calls.at(-1).left===5*1100 && r.count.textContent==='6 / 8','klik titik ke-6 -> slide 6');
t(r.key('Tab')===false,'tombol lain tidak dicegat');
const rm=run({reduce:true}); rm.next.listeners.click[0](); t(rm.calls[0].behavior==='auto','prefers-reduced-motion -> gulir tanpa animasi');
console.log(`${ok} lulus, ${bad} gagal`); process.exit(bad?1:0);
