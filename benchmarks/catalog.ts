import { createHash } from "node:crypto";

export interface CodingTask {
  id: string;
  version: 1;
  category: string;
  difficulty: "easy" | "medium";
  objective: string;
  files: Record<string, string>;
  solution: Record<string, string>;
  grader: string;
  language: "javascript" | "typescript";
  editable: string[];
  fixtureHash: string;
}

const tasks: CodingTask[] = [];
function add(
  category: string,
  name: string,
  objective: string,
  broken: string,
  fixed: string,
  assertions: string,
  extra: Record<string, string> = {},
) {
  const files = { "index.cjs": broken, ...extra };
  tasks.push({
    id: `${category}-${name}`,
    version: 1,
    category,
    difficulty: ["async", "cross-file", "typescript"].includes(category)
      ? "medium"
      : "easy",
    objective: `${objective} Preserve the CommonJS exports in index.cjs. Read source before editing. Do not run shell commands; independent tests run after you finish.`,
    files,
    solution: { ...files, "index.cjs": fixed },
    grader: assertions,
    language: "javascript",
    editable: Object.keys(files),
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
  });
}

add(
  "algorithms",
  "stable-dedup",
  "Return unique values in first-occurrence order.",
  "exports.run=a=>a.sort().filter((x,i,b)=>!i||x!==b[i-1]);",
  "exports.run=a=>[...new Set(a)];",
  "assert.deepEqual(m.run([3,1,3,2,1]),[3,1,2]);assert.deepEqual(m.run([]),[]);",
);
add(
  "algorithms",
  "binary-search",
  "Return index of target in sorted array, or -1, including both boundaries.",
  "exports.run=(a,x)=>a.indexOf(x,1);",
  "exports.run=(a,x)=>a.indexOf(x);",
  "assert.equal(m.run([1,3,5],1),0);assert.equal(m.run([1,3,5],5),2);assert.equal(m.run([],1),-1);",
);
add(
  "algorithms",
  "intervals",
  "Merge overlapping or touching intervals without modifying input.",
  "exports.run=a=>a;",
  "exports.run=a=>a.map(x=>[...x]).sort((a,b)=>a[0]-b[0]).reduce((r,x)=>{const p=r.at(-1);if(p&&x[0]<=p[1])p[1]=Math.max(p[1],x[1]);else r.push(x);return r},[]);",
  "const a=[[5,8],[1,3],[3,6]];assert.deepEqual(m.run(a),[[1,8]]);assert.deepEqual(a,[[5,8],[1,3],[3,6]]);assert.deepEqual(m.run([]),[]);",
);
add(
  "algorithms",
  "chunks",
  "Split arrays into chunks; reject nonpositive or noninteger sizes with RangeError.",
  "exports.run=(a,n)=>[a];",
  "exports.run=(a,n)=>{if(!Number.isInteger(n)||n<1)throw new RangeError('size');return Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,(i+1)*n))};",
  "assert.deepEqual(m.run([1,2,3],2),[[1,2],[3]]);for(const n of [0,-1,1.5])assert.throws(()=>m.run([],n),RangeError);assert.deepEqual(m.run([],2),[]);",
);
add(
  "algorithms",
  "maximum",
  "Return maximum including negative inputs; return null for empty arrays.",
  "exports.run=a=>Math.max(0,...a);",
  "exports.run=a=>a.length?Math.max(...a):null;",
  "assert.equal(m.run([-7,-2]),-2);assert.equal(m.run([]),null);assert.equal(m.run([0,4]),4);",
);
add(
  "parsing",
  "csv",
  "Parse one CSV record, honoring quoted commas and doubled quotes.",
  "exports.run=s=>s.split(',');",
  "exports.run=s=>{const r=[];let v='',q=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='\"'){if(q&&s[i+1]==='\"'){v+='\"';i++}else q=!q}else if(c===','&&!q){r.push(v);v=''}else v+=c}r.push(v);return r};",
  "assert.deepEqual(m.run('a,\"b,c\",\"d\"\"e\"'),['a','b,c','d\"e']);assert.deepEqual(m.run('a,'),['a','']);",
);
add(
  "parsing",
  "escaped-delimiter",
  "Split on unescaped pipes; backslash escapes the next character and trailing backslash stays literal.",
  "exports.run=s=>s.split('|');",
  "exports.run=s=>{const r=[''];for(let i=0;i<s.length;i++){if(s[i]==='\\\\'&&i+1<s.length)r[r.length-1]+=s[++i];else if(s[i]==='|')r.push('');else r[r.length-1]+=s[i]}return r};",
  "assert.deepEqual(m.run('a\\\\|b|c'),['a|b','c']);assert.deepEqual(m.run('|'),['','']);",
);
add(
  "parsing",
  "query-values",
  "Return every decoded query value for a key, preserving repeats and blank values.",
  "exports.run=(q,k)=>[new URLSearchParams(q).get(k)];",
  "exports.run=(q,k)=>new URLSearchParams(q).getAll(k);",
  "assert.deepEqual(m.run('q=a+b&q=&q=c%2Bd','q'),['a b','','c+d']);assert.deepEqual(m.run('x=1','q'),[]);",
);
add(
  "parsing",
  "unicode",
  "Truncate a string to n Unicode code points without splitting surrogate pairs.",
  "exports.run=(s,n)=>s.slice(0,n);",
  "exports.run=(s,n)=>Array.from(s).slice(0,Math.max(0,n)).join('');",
  "assert.equal(m.run('😀ab',2),'😀a');assert.equal(m.run('abc',0),'');",
);
add(
  "parsing",
  "newlines",
  "Normalize CRLF and standalone CR line endings to LF, leaving other characters unchanged.",
  "exports.run=s=>s.replace('\\r\\n','\\n');",
  "exports.run=s=>s.replace(/\\r\\n?/g,'\\n');",
  "assert.equal(m.run('a\\r\\nb\\rc\\r\\n'),'a\\nb\\nc\\n');assert.equal(m.run('x\\ny'),'x\\ny');",
);
add(
  "validation",
  "missing-values",
  "Use fallback only for null or undefined, preserving false, zero, and empty strings.",
  "exports.run=(x,f)=>x||f;",
  "exports.run=(x,f)=>x??f;",
  "for(const x of [false,0,''])assert.equal(m.run(x,9),x);assert.equal(m.run(null,9),9);",
);
add(
  "validation",
  "bounds",
  "Accept finite numbers inclusively between min and max.",
  "exports.run=(x,min,max)=>x>min&&x<max;",
  "exports.run=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;",
  "assert.equal(m.run(0,0,10),true);assert.equal(m.run(10,0,10),true);assert.equal(m.run('5',0,10),false);assert.equal(m.run(NaN,0,10),false);",
);
add(
  "validation",
  "nested",
  "Accept objects with optional profile; when profile is supplied it must be a non-null object with a nonempty string name.",
  "exports.run=x=>!!x.profile.name;",
  "exports.run=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&(x.profile===undefined||(!!x.profile&&typeof x.profile==='object'&&!Array.isArray(x.profile)&&typeof x.profile.name==='string'&&x.profile.name.trim().length>0));",
  "assert.equal(m.run({}),true);assert.equal(m.run({profile:null}),false);assert.equal(m.run({profile:{name:'  '}}),false);assert.equal(m.run({profile:{name:'Ada'}}),true);",
);
add(
  "validation",
  "unknown-keys",
  "Accept non-null plain records containing only name and age keys.",
  "exports.run=x=>typeof x==='object';",
  "exports.run=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>['name','age'].includes(k));",
  "assert.equal(m.run({name:'a',admin:true}),false);assert.equal(m.run(null),false);assert.equal(m.run([]),false);assert.equal(m.run({age:0}),true);",
);
add(
  "validation",
  "calendar-date",
  "Validate real dates in exact YYYY-MM-DD format, including leap-year rules.",
  "exports.run=s=>!isNaN(Date.parse(s));",
  "exports.run=s=>typeof s==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;",
  "assert.equal(m.run('2023-02-29'),false);assert.equal(m.run('2024-02-29'),true);assert.equal(m.run('2024-2-1'),false);",
);
add(
  "api",
  "pagination",
  "Return pageSize entries for one-based pages; reject page/pageSize less than one.",
  "exports.run=(a,p,n)=>a.slice(p*n,p*n+n);",
  "exports.run=(a,p,n)=>{if(p<1||n<1)throw new RangeError('pagination');return a.slice((p-1)*n,p*n)};",
  "assert.deepEqual(m.run([1,2,3,4,5],2,2),[3,4]);assert.throws(()=>m.run([],0,1));",
);
add(
  "api",
  "filters",
  "Filter records by all supplied exact-match criteria; absent criteria match all.",
  "exports.run=(rows,q)=>rows.filter(r=>Object.entries(q).some(([k,v])=>r[k]===v));",
  "exports.run=(rows,q)=>rows.filter(r=>Object.entries(q).every(([k,v])=>r[k]===v));",
  "const r=[{a:1,b:2},{a:1,b:3}];assert.deepEqual(m.run(r,{a:1,b:2}),[r[0]]);assert.deepEqual(m.run(r,{}),r);",
);
add(
  "api",
  "error-status",
  "Map NOT_FOUND to 404, UNAUTHORIZED to 401, VALIDATION to 400, and everything else to 500.",
  "exports.run=e=>e.code==='NOT_FOUND'?404:200;",
  "exports.run=e=>({NOT_FOUND:404,UNAUTHORIZED:401,VALIDATION:400}[e?.code]??500);",
  "assert.equal(m.run({code:'UNAUTHORIZED'}),401);assert.equal(m.run({code:'VALIDATION'}),400);assert.equal(m.run(null),500);assert.equal(m.run({code:'NOT_FOUND'}),404);",
);
add(
  "api",
  "token-expiry",
  "A token is valid only when exp is a finite numeric Unix timestamp strictly after nowMs converted to seconds.",
  "exports.run=(t,now)=>t.exp>now;",
  "exports.run=(t,now)=>typeof t?.exp==='number'&&Number.isFinite(t.exp)&&t.exp>now/1000;",
  "assert.equal(m.run({exp:11},10000),true);assert.equal(m.run({exp:10},10000),false);assert.equal(m.run({exp:'11'},10000),false);",
);
add(
  "api",
  "idempotency",
  "create() returns a handler that runs fn once per key and caches falsy results too.",
  "exports.create=()=>{const c=new Map();return(k,fn)=>{if(c.get(k))return c.get(k);const v=fn();c.set(k,v);return v}};",
  "exports.create=()=>{const c=new Map();return(k,fn)=>{if(c.has(k))return c.get(k);const v=fn();c.set(k,v);return v}};",
  "const f=m.create();let n=0;assert.equal(f('x',()=>{n++;return 0}),0);assert.equal(f('x',()=>{n++;return 9}),0);assert.equal(n,1);",
);
add(
  "data",
  "group-sum",
  "Sum record amounts by group key, including keys such as __proto__, without prototype collisions.",
  "exports.run=rows=>rows.reduce((r,x)=>(r[x.group]=(r[x.group]||0)+x.amount,r),{});",
  "exports.run=rows=>rows.reduce((r,x)=>(r[x.group]=(r[x.group]||0)+x.amount,r),Object.create(null));",
  "const r=m.run([{group:'__proto__',amount:2},{group:'a',amount:3},{group:'a',amount:-1}]);assert.equal(r.__proto__,2);assert.equal(r.a,2);",
);
add(
  "data",
  "null-sort",
  "Sort numbers ascending with null values last without mutating input.",
  "exports.run=a=>a.sort((a,b)=>a-b);",
  "exports.run=a=>[...a].sort((a,b)=>a===null?(b===null?0:1):b===null?-1:a-b);",
  "const a=[2,null,1];assert.deepEqual(m.run(a),[1,2,null]);assert.deepEqual(a,[2,null,1]);",
);
add(
  "data",
  "immutable-update",
  "Update the matching record by ID without mutating records or input array.",
  "exports.run=(a,id,v)=>{a.find(x=>x.id===id).value=v;return a};",
  "exports.run=(a,id,v)=>a.map(x=>x.id===id?{...x,value:v}:x);",
  "const a=[{id:1,value:0},{id:2,value:4}];const b=m.run(a,1,9);assert.equal(a[0].value,0);assert.equal(b[0].value,9);assert.equal(b[1],a[1]);assert.deepEqual(m.run(a,3,7),a);",
);
add(
  "data",
  "left-join",
  "Left join rows by id, emitting every matching right row and a null right for unmatched left rows.",
  "exports.run=(a,b)=>a.map(x=>({left:x,right:b.find(y=>x.id===y.id)||null}));",
  "exports.run=(a,b)=>a.flatMap(x=>{const rows=b.filter(y=>x.id===y.id);return(rows.length?rows:[null]).map(y=>({left:x,right:y}))});",
  "const a=[{id:1},{id:2}],b=[{id:1,n:'a'},{id:1,n:'b'}];const r=m.run(a,b);assert.equal(r.length,3);assert.equal(r[2].right,null);assert.equal(r[1].right.n,'b');",
);
add(
  "data",
  "currency",
  "Sum integer cent amounts and return decimal currency units; avoid rounding each item to dollars.",
  "exports.run=cents=>cents.reduce((n,x)=>n+Math.round(x/100),0);",
  "exports.run=cents=>cents.reduce((n,x)=>n+x,0)/100;",
  "assert.equal(m.run([49,49,2]),1);assert.equal(m.run([-50,125]),0.75);assert.equal(m.run([]),0);",
);
add(
  "async",
  "deduplicate",
  "create() returns an async loader that shares an in-flight promise for the same key.",
  "exports.create=fn=>k=>fn(k);",
  "exports.create=fn=>{const c=new Map();return k=>{if(!c.has(k))c.set(k,Promise.resolve().then(()=>fn(k)));return c.get(k)}};",
  "let n=0;const f=m.create(async k=>{n++;return k});assert.deepEqual(await Promise.all([f('x'),f('x')]),['x','x']);assert.equal(n,1);",
);
add(
  "async",
  "rejection-cache",
  "Cache successful loader promises, but evict rejected ones so a later call retries.",
  "exports.create=fn=>{const c=new Map();return k=>{if(!c.has(k))c.set(k,Promise.resolve().then(()=>fn(k)));return c.get(k)}};",
  "exports.create=fn=>{const c=new Map();return k=>{if(!c.has(k))c.set(k,Promise.resolve().then(()=>fn(k)).catch(e=>{c.delete(k);throw e}));return c.get(k)}};",
  "let n=0;const f=m.create(async()=>{if(++n===1)throw Error('once');return 7});await assert.rejects(f('x'));assert.equal(await f('x'),7);assert.equal(await f('x'),7);assert.equal(n,2);",
);
add(
  "async",
  "stale-response",
  "create() exposes load(promise) and value(); only the newest load may update value.",
  "exports.create=()=>{let v;return{load:async p=>{v=await p},value:()=>v}};",
  "exports.create=()=>{let v,seq=0;return{load:async p=>{const s=++seq;const x=await p;if(s===seq)v=x},value:()=>v}};",
  "let resolve;const old=new Promise(r=>resolve=r);const x=m.create();const a=x.load(old);await x.load(Promise.resolve('new'));resolve('old');await a;assert.equal(x.value(),'new');",
);
add(
  "async",
  "concurrency",
  "Run asynchronous job functions with at most limit active jobs and preserve result order.",
  "exports.run=(jobs,limit)=>Promise.all(jobs.map(f=>f()));",
  "exports.run=async(jobs,limit)=>{if(limit<1)throw new RangeError('limit');const r=[];let i=0;await Promise.all(Array.from({length:Math.min(limit,jobs.length)},async()=>{while(i<jobs.length){const n=i++;r[n]=await jobs[n]()}}));return r};",
  "let active=0,peak=0;const jobs=[0,1,2,3].map(n=>async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return n});assert.deepEqual(await m.run(jobs,2),[0,1,2,3]);assert.ok(peak<=2);",
);
add(
  "async",
  "abort",
  "Before invoking work, reject with signal.reason when an AbortSignal is already aborted.",
  "exports.run=async(fn,signal)=>fn();",
  "exports.run=async(fn,signal)=>{signal.throwIfAborted();return fn()};",
  "const c=new AbortController();const reason=Error('stop');c.abort(reason);let called=false;await assert.rejects(m.run(()=>{called=true},c.signal),e=>e===reason);assert.equal(called,false);",
);

function typed(
  name: string,
  objective: string,
  broken: string,
  fixed: string,
  contract: string,
) {
  const files = { "index.ts": broken };
  tasks.push({
    id: `typescript-${name}`,
    version: 1,
    category: "typescript",
    difficulty: "medium",
    objective: `${objective} Edit index.ts; preserve exports. Independent strict TypeScript compilation follows completion.`,
    files,
    solution: { "index.ts": fixed },
    grader: contract,
    language: "typescript",
    editable: ["index.ts"],
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
  });
}
typed(
  "union",
  "Fix discriminated-union handling so unwrap returns value for success and zero for error.",
  "type R={ok:true,value:number}|{ok:false,error:string};export function unwrap(r:R):number{return r.value}",
  "type R={ok:true,value:number}|{ok:false,error:string};export function unwrap(r:R):number{return r.ok?r.value:0}",
  "import {unwrap} from './index';const n:number=unwrap({ok:false,error:'x'});",
);
typed(
  "generic",
  "Make first generic so string and number arrays preserve element type, including undefined for empty arrays.",
  "export function first(a:number[]):number|undefined{return a[0]}",
  "export function first<T>(a:T[]):T|undefined{return a[0]}",
  "import {first} from './index';const a:string|undefined=first(['x']);const b:number|undefined=first([1]);",
);
typed(
  "nullable",
  "Return null when no matching user exists and give the function the correct return type.",
  "export function find(a:{id:number}[],id:number):{id:number}{return a.find(x=>x.id===id)}",
  "export function find(a:{id:number}[],id:number):{id:number}|null{return a.find(x=>x.id===id)??null}",
  "import {find} from './index';const x:{id:number}|null=find([],1);",
);
typed(
  "readonly",
  "Sort readonly numeric input by copying it; return a mutable sorted numeric array.",
  "export function sorted(a:readonly number[]):number[]{return a.sort((x,y)=>x-y)}",
  "export function sorted(a:readonly number[]):number[]{return [...a].sort((x,y)=>x-y)}",
  "import {sorted} from './index';const x:number[]=sorted([3,1] as const);",
);
typed(
  "overload",
  "Fix the implementation signature of convert overloads; strings become numbers and numbers become strings.",
  "export function convert(x:string):number;export function convert(x:number):string;export function convert(x:string):number{return Number(x)}",
  "export function convert(x:string):number;export function convert(x:number):string;export function convert(x:string|number):number|string{return typeof x==='string'?Number(x):String(x)}",
  "import {convert} from './index';const a:number=convert('2');const b:string=convert(2);",
);

add(
  "ui-state",
  "functional-update",
  "Apply every queued updater in sequence, passing each the latest state.",
  "exports.run=(state,updates)=>updates.reduce((s,f)=>f(state),state);",
  "exports.run=(state,updates)=>updates.reduce((s,f)=>f(s),state);",
  "assert.equal(m.run(0,[x=>x+1,x=>x+1]),2);assert.equal(m.run(3,[]),3);",
);
add(
  "ui-state",
  "remove-item",
  "Remove an item by ID without mutating the input list.",
  "exports.run=(items,id)=>{items.splice(items.findIndex(x=>x.id===id),1);return items};",
  "exports.run=(items,id)=>items.filter(x=>x.id!==id);",
  "const a=[{id:1},{id:2}];assert.deepEqual(m.run(a,9),a);assert.deepEqual(m.run(a,1),[{id:2}]);assert.equal(a.length,2);",
);
add(
  "ui-state",
  "selection",
  "Retain selected IDs still present in items, preserving selection order.",
  "exports.run=(selected,items)=>selected;",
  "exports.run=(selected,items)=>selected.filter(id=>items.some(x=>x.id===id));",
  "assert.deepEqual(m.run([3,1,2],[{id:1},{id:3}]),[3,1]);assert.deepEqual(m.run([1],[]),[]);",
);
add(
  "ui-state",
  "unsubscribe",
  "subscribe(target,fn) registers a change listener and returns cleanup removing that exact listener.",
  "exports.subscribe=(t,f)=>{t.on('change',f);return()=>t.removeAllListeners('change')};",
  "exports.subscribe=(t,f)=>{t.on('change',f);return()=>t.off('change',f)};",
  "const {EventEmitter}=require('node:events');const t=new EventEmitter();let a=0,b=0;const off=m.subscribe(t,()=>a++);m.subscribe(t,()=>b++);off();t.emit('change');assert.equal(a,0);assert.equal(b,1);",
);
add(
  "ui-state",
  "derived-filter",
  "Filter labels case-insensitively by trimmed query; do not cache stale results between calls.",
  "let cached;exports.run=(items,q)=>cached??=items.filter(x=>x.includes(q));",
  "exports.run=(items,q)=>items.filter(x=>x.toLowerCase().includes(q.trim().toLowerCase()));",
  "assert.deepEqual(m.run(['Alpha','Beta'],' AL '),['Alpha']);assert.deepEqual(m.run(['Gamma'],'ga'),['Gamma']);",
);
add(
  "cross-file",
  "result-contract",
  "Adapt the service to parser's {value} return contract, returning doubled numeric value.",
  "const p=require('./parser.cjs');exports.run=s=>p.parse(s)*2;",
  "const p=require('./parser.cjs');exports.run=s=>p.parse(s).value*2;",
  "assert.equal(m.run('4'),8);assert.equal(m.run('-2'),-4);",
  { "parser.cjs": "exports.parse=s=>({value:Number(s)});" },
);
add(
  "cross-file",
  "config-default",
  "Use exported default pageSize only when options.pageSize is nullish, preserving zero.",
  "const c=require('./config.cjs');exports.run=o=>o.pageSize||c.defaultSize;",
  "const c=require('./config.cjs');exports.run=o=>o.pageSize??c.pageSize;",
  "assert.equal(m.run({}),25);assert.equal(m.run({pageSize:0}),0);",
  { "config.cjs": "exports.pageSize=25;" },
);
add(
  "cross-file",
  "validator",
  "Use the shared email validator before saving; invalid email throws and does not call save.",
  "exports.run=(email,save)=>save(email);",
  "const {valid}=require('./validation.cjs');exports.run=(email,save)=>{if(!valid(email))throw Error('invalid');return save(email)};",
  "let n=0;assert.throws(()=>m.run('bad',()=>n++));assert.equal(n,0);assert.equal(m.run('a@b.co',x=>x),'a@b.co');",
  {
    "validation.cjs":
      "exports.valid=s=>typeof s==='string'&&/^[^@ ]+@[^@ ]+\\.[^@ ]+$/.test(s);",
  },
);
add(
  "cross-file",
  "shared-error",
  "Throw the exported NotFound class for absent records, so callers can use instanceof.",
  "exports.run=(a,id)=>{const x=a.find(x=>x.id===id);if(!x)throw Error('not found');return x};",
  "const {NotFound}=require('./errors.cjs');exports.run=(a,id)=>{const x=a.find(x=>x.id===id);if(!x)throw new NotFound('not found');return x};",
  "const {NotFound}=candidate('errors.cjs');assert.throws(()=>m.run([],1),NotFound);assert.equal(m.run([{id:1}],1).id,1);",
  { "errors.cjs": "exports.NotFound=class NotFound extends Error{};" },
);
add(
  "cross-file",
  "dependency-injection",
  "create(store) must use the supplied store rather than singleton default storage.",
  "const store=require('./store.cjs');exports.create=injected=>id=>store.get(id);",
  "exports.create=store=>id=>store.get(id);",
  "assert.equal(m.create({get:id=>'custom:'+id})('x'),'custom:x');",
  { "store.cjs": "exports.get=id=>'default:'+id;" },
);
add(
  "features",
  "ttl-cache",
  "create(now) returns set(key,value,ttlMs)/get(key); expiration is inclusive and uses injected clock.",
  "exports.create=now=>{const c=new Map();return{set:(k,v,ttl)=>c.set(k,v),get:k=>c.get(k)}};",
  "exports.create=now=>{const c=new Map();return{set:(k,v,ttl)=>c.set(k,{v,until:now()+ttl}),get:k=>{const x=c.get(k);return x&&now()<x.until?x.v:undefined}}};",
  "let t=0;const c=m.create(()=>t);c.set('x',0,10);assert.equal(c.get('x'),0);t=10;assert.equal(c.get('x'),undefined);",
);
add(
  "features",
  "retry-budget",
  "run(fn,attempts) retries rejected async work up to attempts total, then throws last error.",
  "exports.run=async(fn,n)=>fn();",
  "exports.run=async(fn,n)=>{if(n<1)throw new RangeError('attempts');let error;for(let i=0;i<n;i++){try{return await fn()}catch(e){error=e}}throw error};",
  "let n=0;assert.equal(await m.run(async()=>{if(++n<3)throw Error('retry');return 4},3),4);assert.equal(n,3);let k=0;await assert.rejects(m.run(async()=>{k++;throw Error('bad')},2));assert.equal(k,2);",
);
add(
  "features",
  "once-event",
  "once(emitter,event,fn) must invoke fn at most once and pass event arguments.",
  "exports.once=(e,n,f)=>e.on(n,f);",
  "exports.once=(e,n,f)=>e.once(n,f);",
  "const {EventEmitter}=require('node:events');const e=new EventEmitter();const values=[];m.once(e,'x',v=>values.push(v));e.emit('x',3);e.emit('x',4);assert.deepEqual(values,[3]);",
);
add(
  "features",
  "options-compat",
  "Accept either legacy boolean or options object; return {enabled}, defaulting true only when unspecified.",
  "exports.run=o=>({enabled:!!o});",
  "exports.run=o=>({enabled:typeof o==='boolean'?o:o?.enabled??true});",
  "assert.deepEqual(m.run(false),{enabled:false});assert.deepEqual(m.run({enabled:false}),{enabled:false});assert.deepEqual(m.run(),{enabled:true});",
);
add(
  "features",
  "pure-parser",
  "Parse key=value lines into a fresh object on each call; ignore blank lines and split only the first equals sign.",
  "const result={};exports.run=s=>{for(const line of s.split('\\n')){const [k,v]=line.split('=');result[k]=v}return result};",
  "exports.run=s=>{const result={};for(const line of s.split('\\n')){if(!line.trim())continue;const i=line.indexOf('=');if(i>=0)Object.defineProperty(result,line.slice(0,i),{value:line.slice(i+1),enumerable:true,writable:true,configurable:true})}return result};",
  "assert.deepEqual(m.run('a=x=y\\n'),{a:'x=y'});assert.deepEqual(m.run('b=2'),{b:'2'});",
);

export const catalog: readonly CodingTask[] = tasks;
