import express from 'express';
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'); /* point DATA_DIR at a persistent disk */
const VAPID_FILE = path.join(DATA, 'vapid.json');
const SUB_FILE = path.join(DATA, 'subscriptions.json');
fs.mkdirSync(DATA, {recursive:true});

function readJson(file, fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function writeJson(file, value){fs.writeFileSync(file, JSON.stringify(value,null,2))}
let vapid=readJson(VAPID_FILE,null);
if(!vapid?.publicKey||!vapid?.privateKey){const k=webpush.generateVAPIDKeys();vapid={publicKey:k.publicKey,privateKey:k.privateKey};writeJson(VAPID_FILE,vapid)}
const subject=process.env.VAPID_SUBJECT||'mailto:hello@example.com';
webpush.setVapidDetails(subject,vapid.publicKey,vapid.privateKey);
let subs=readJson(SUB_FILE,{});
const app=express();
app.set('trust proxy',1);app.disable('x-powered-by');
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'camera=(), geolocation=(), payment=()','Strict-Transport-Security':'max-age=31536000; includeSubDomains','Content-Security-Policy':"object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"});next()});
const hits=new Map();
const limit=(name,max,ms)=>(req,res,next)=>{const k=name+':'+req.ip,n=Date.now();let h=hits.get(k);if(!h||n>h.reset){h={n:0,reset:n+ms};hits.set(k,h)}if(++h.n>max)return res.status(429).json({error:'Too many requests'});next()};
setInterval(()=>{const n=Date.now();for(const [k,h] of hits)if(n>h.reset)hits.delete(k)},6e4).unref();
const PUSH_HOST=/(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const okEndpoint=u=>{try{const x=new URL(u);return x.protocol==='https:'&&PUSH_HOST.test(x.hostname)}catch{return false}};
app.use(express.json({limit:'64kb',verify:(req,res,buf)=>{req.rawBody=buf}}));

app.use('/api/translate',limit('tr',30,6e4));app.use('/api/ui',limit('ui',30,6e4));app.use('/api/push',limit('push',20,6e4));app.use('/api/pay',limit('pay',60,6e4));
app.get('/api/push/config',(req,res)=>res.json({publicKey:vapid.publicKey}));
app.post('/api/push/subscribe',(req,res)=>{
  const {sub,tz,mode,times,count,interval,intervalAnchor,accountId,nativeLang,learnLang}=req.body||{};
  if(!sub?.endpoint||!okEndpoint(sub.endpoint)||!sub?.keys?.p256dh||!sub?.keys?.auth)return res.status(400).json({error:'Invalid push subscription'});
  const id=crypto.createHash('sha256').update(sub.endpoint).digest('hex');
  subs[id]={id,sub,tz:tz||'UTC',mode:mode==='random'?'random':'fixed',times:Array.isArray(times)?times.slice(0,6):[],count:Number(count)||2,interval:Number(interval)||0,intervalAnchor:Number(intervalAnchor)||0,accountId:String(accountId||'guest'),nativeLang:String(nativeLang||'English'),learnLang:String(learnLang||'English'),fired:Array.isArray(subs[id]?.fired)?subs[id].fired:[],updated:Date.now()};
  writeJson(SUB_FILE,subs);res.json({ok:true,id});
});
app.post('/api/push/unsubscribe',(req,res)=>{
  const endpoint=req.body?.endpoint;
  if(endpoint){const id=crypto.createHash('sha256').update(endpoint).digest('hex');delete subs[id];writeJson(SUB_FILE,subs)}
  res.json({ok:true});
});


/* ---------- AI-assisted translation (optional, server-side) ----------
   Set OPENAI_API_KEY in the server environment to enable the high-quality AI
   translator. The key never reaches the browser. Without a key, the route
   falls back to the same public machine-translation providers already used by
   the app. Results are cached in memory for this server process. */
const translationCache=new Map();
const TRANSLATION_CACHE_LIMIT=500;
const langClean=v=>String(v||'Auto-detect').trim().slice(0,80);
const cacheKey=(text,from,to)=>JSON.stringify([String(text).trim(),langClean(from),langClean(to)]);
function cacheSet(k,v){if(translationCache.has(k))translationCache.delete(k);translationCache.set(k,v);while(translationCache.size>TRANSLATION_CACHE_LIMIT)translationCache.delete(translationCache.keys().next().value)}
function parseJsonText(raw){
  const t=String(raw||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(t)}catch{return null}
}
async function openaiTranslate(text,from,to){
  const key=process.env.OPENAI_API_KEY;
  if(!key)return null;
  const model=process.env.OPENAI_TRANSLATION_MODEL||'gpt-5.6-luna';
  const system=`You are LaingoPop's professional vocabulary translator. Translate the user's text from ${from==='Auto-detect'?'the detected source language':from} to ${to}. Preserve meaning, intent, tense, plurality, politeness, names, numbers, punctuation, and register. Prefer the natural translation a native speaker would actually use, not a literal word-for-word rendering. For a single word, return the most common learner-friendly equivalent; include a brief alternative only when the source word is genuinely ambiguous. Do not invent context. If the input already matches the target language, return it unchanged. For English and Spanish, also return a simple Latin-letter reading aid with accents and non-Latin symbols removed. Return JSON only in the form {"text":"...","pronunciation":"..."}.`; 
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:String(text)}]}]})});
  if(!r.ok)throw new Error('AI translation HTTP '+r.status);
  const j=await r.json();
  const raw=j.output_text||((j.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join(''));
  const out=parseJsonText(raw);
  if(!out||!String(out.text||'').trim())throw new Error('AI translation returned invalid JSON');
  return {text:String(out.text).trim(),pron:String(out.pronunciation||'').trim(),engine:'ai'};
}
async function claudeTranslate(text,from,to){
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key)return null;
  const model=process.env.ANTHROPIC_TRANSLATION_MODEL||'claude-sonnet-5';
  const system=`You are a professional human-level translator inside a language-learning app. Translate from ${from==='Auto-detect'?'the automatically detected language':from} to ${to}. Keep exact meaning, tense, plurality, tone, register, names and numbers. Use the wording a native speaker would naturally say, never literal word-for-word; give natural equivalents for idioms; for a single word give its most common everyday meaning. For English and Spanish, also provide a simple Latin-letter reading aid with accents and non-Latin symbols removed. Reply with ONLY JSON: {"text":"...","pronunciation":"..."}`;
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model,max_tokens:600,system,messages:[{role:'user',content:String(text)}]})});
  if(!r.ok)throw new Error('Claude translation HTTP '+r.status);
  const j=await r.json(),raw=(j.content||[]).map(x=>x.text||'').join('');
  const out=parseJsonText(raw);
  if(!out||!String(out.text||'').trim())throw new Error('Claude translation returned invalid JSON');
  return {text:String(out.text).trim(),pron:String(out.pronunciation||'').trim(),engine:'claude'};
}
async function aiTranslate(text,from,to){
  try{const c=await claudeTranslate(text,from,to);if(c)return c}catch(e){console.warn('Claude translation failed:',e.message)}
  return openaiTranslate(text,from,to);
}
async function fallbackTranslate(text,from,to){
  const iso={English:'en',Spanish:'es',French:'fr',German:'de',Hindi:'hi',Hinglish:'en',Portuguese:'pt',Italian:'it',Japanese:'ja',Korean:'ko','Chinese (Simplified)':'zh-CN',Arabic:'ar',Russian:'ru',Turkish:'tr',Urdu:'ur',Bengali:'bn',Tamil:'ta',Telugu:'te',Marathi:'mr',Gujarati:'gu',Punjabi:'pa',Kannada:'kn',Malayalam:'ml',Dutch:'nl',Polish:'pl',Swedish:'sv',Norwegian:'no',Danish:'da',Finnish:'fi',Greek:'el',Hebrew:'he',Hungarian:'hu',Czech:'cs',Romanian:'ro',Ukrainian:'uk',Thai:'th',Vietnamese:'vi',Indonesian:'id',Malay:'ms',Filipino:'fil',Swahili:'sw',Persian:'fa'};
  if(from===to)return {text:String(text).trim(),pron:'',engine:'identity'};
  const sl=from==='Auto-detect'?'auto':iso[from],tl=iso[to];
  if(!tl||!sl)throw new Error('Unsupported language pair');
  try{
    const u='https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=rm&sl='+encodeURIComponent(sl)+'&tl='+encodeURIComponent(tl)+'&q='+encodeURIComponent(text);
    const r=await fetch(u);if(r.ok){const j=await r.json(),parts=j&&j[0]||[],t=parts.map(x=>x&&x[0]||'').join('').trim();if(t)return {text:t,pron:'',engine:'google'};}
  }catch{}
  try{
    const lp=(from==='Auto-detect'?'Autodetect':sl)+'|'+tl;
    const r=await fetch('https://api.mymemory.translated.net/get?q='+encodeURIComponent(text)+'&langpair='+encodeURIComponent(lp));
    const j=await r.json(),t=j?.responseData?.translatedText;
    if(t&&!/INVALID|MYMEMORY WARNING|QUERY LENGTH/i.test(t))return {text:String(t).trim(),pron:'',engine:'mymemory'};
  }catch{}
  throw new Error('No translation provider available');
}
app.post('/api/translate',async(req,res)=>{
  const text=String(req.body?.text||'').trim(),from=langClean(req.body?.from),to=langClean(req.body?.to);
  if(!['English','Spanish'].includes(to))return res.status(400).json({error:'Only English and Spanish translations are supported'});
  if(!text)return res.status(400).json({error:'Text is required'});
  if(text.length>2000)return res.status(413).json({error:'Text is too long'});
  const key=cacheKey(text,from,to),hit=translationCache.get(key);
  if(hit)return res.json({...hit,cached:true});
  try{
    let out;
    try{out=await aiTranslate(text,from,to)}catch(e){console.warn('AI translation failed:',e.message)}
    if(!out)out=await fallbackTranslate(text,from,to);
    cacheSet(key,out);
    res.json(out);
  }catch(e){res.status(502).json({error:'Translation unavailable'});}
});

app.post('/api/push/ack',(req,res)=>{const e=Object.values(subs).find(x=>x.sub.endpoint===req.body?.endpoint);if(e&&e.pending){e.pending=null;writeJson(SUB_FILE,subs)}res.json({ok:true})});
app.post('/api/push/test',async(req,res)=>{
  const endpoint=req.body?.endpoint;const entry=Object.values(subs).find(x=>x.sub.endpoint===endpoint);
  if(!entry)return res.status(404).json({error:'Subscription not found'});
  try{const c=copyFor(entry.nativeLang);await send(entry,{title:c[0],body:c[1],url:'./?action=alarm',tag:'laingopop-device-test'});res.json({ok:true})}
  catch(e){if(e.statusCode===404||e.statusCode===410){delete subs[entry.id];writeJson(SUB_FILE,subs)}res.status(502).json({error:'Push delivery failed'})}
});

function localParts(date,tz){const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(date);const o={};for(const x of p)if(x.type!=='literal')o[x.type]=x.value;return o}
function dayKey(date,tz){const p=localParts(date,tz);return `${p.year}-${p.month}-${p.day}`}
function minuteKey(date,tz){const p=localParts(date,tz);return `${p.year}-${p.month}-${p.day}@${p.hour}:${p.minute}`}
const REMIND_COPY={
  English:[['Time to practise!','Your learning words are waiting. Tap to start.'],['Still waiting on you','Your words are piling up. Tap to clear today\u2019s session.'],['This won\u2019t stop','Finish the session and it goes quiet. Tap now.']],
  Hinglish:[['Practice ka time ho gaya!','Tumhare words wait kar rahe hain. Tap karke start karo.'],['Abhi tak nahi kiya?','Jab tak session complete nahi hota, ye peecha nahi chhodega.'],['Bhai session baki hai','2 minute ka kaam hai, abhi nipta de warna phir se aayega.']],
  Hindi:[['अभ्यास का समय!','आपके शब्द इंतज़ार कर रहे हैं। अभी टैप करें।'],['अभी तक नहीं किया?','जब तक सेशन पूरा नहीं होगा, यह याद दिलाता रहेगा।'],['सेशन बाकी है','सिर्फ़ 2 मिनट का काम है, अभी कर लो।']],
  Spanish:[['¡Hora de practicar!','Tus palabras están listas. Toca para empezar.']],
  French:[['C’est l’heure de pratiquer !','Tes mots sont prêts. Touche pour commencer.']],
  German:[['Zeit zum Üben!','Deine Lernwörter sind bereit. Tippe zum Starten.']]
};
function copyFor(lang,n){const arr=REMIND_COPY[lang]||REMIND_COPY.English;return arr[Math.min(n||0,arr.length-1)]}
function dailyRandom(accountId,day,count){let seed=0;for(const c of `${accountId}:${day}`)seed=(seed*31+c.charCodeAt(0))>>>0;const out=[];for(let i=0;i<count;i++){seed=(seed*1664525+1013904223)>>>0;const m=480+(seed%841);if(out.every(x=>Math.abs(x-m)>=80))out.push(m);else i--}return out.sort((a,b)=>a-b).map(m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'))}
function due(entry,now){
  const tz=entry.tz||'UTC', day=dayKey(now,tz), key=minuteKey(now,tz), p=localParts(now,tz), hm=`${p.hour}:${p.minute}`;
  const fires=[];
  const times=entry.mode==='random'?dailyRandom(entry.accountId||'guest',day,Math.max(2,Math.min(6,entry.count||2))):(entry.times||[]);
  if(times.includes(hm)){const c=copyFor(entry.nativeLang);fires.push({key:`daily:${key}`,title:c[0],body:c[1],url:'./?action=quiz&alarm=1'});}
  if(entry.interval&&entry.intervalAnchor){
    const intervalMs=entry.interval*60000, n=Math.floor((now.getTime()-entry.intervalAnchor)/intervalMs);
    if(n>=1){const ik=`interval:${Math.floor(entry.intervalAnchor/1000)}:${n}`;if(!entry.fired.includes(ik)){const c=copyFor(entry.nativeLang);fires.push({key:ik,title:c[0],body:c[1],url:'./?action=quiz&alarm=1'})}}
  }
  return fires;
}
async function send(entry,msg){return webpush.sendNotification(entry.sub,JSON.stringify(msg),{TTL:300,urgency:'high'})}
function nagDelay(n){return n<5?60000:(n<25?300000:900000)} /* 1min x5, then 5min x20, then 15min \u2014 genuinely won't stop */
async function tick(){const now=new Date();let changed=false;
  for(const entry of Object.values(subs)){
    entry.fired=(entry.fired||[]).slice(-120);
    const pd=entry.pending;
    if(pd){
      if(Date.now()-pd.started>=3*3600000){entry.pending=null;changed=true}
      else if(Date.now()-pd.last>=nagDelay(pd.sent)){
        const c=copyFor(entry.nativeLang,Math.floor(pd.sent/5));
        try{await send(entry,{...pd.msg,title:c[0],body:c[1],tag:'laingopop-reminder'});pd.sent++;pd.last=Date.now();changed=true}
        catch(e){if(e.statusCode===404||e.statusCode===410){delete subs[entry.id];changed=true;continue}}
      }
    }
    for(const msg of due(entry,now)){
      if(entry.fired.includes(msg.key))continue;
      try{await send(entry,msg);entry.fired.push(msg.key);entry.pending={msg,sent:1,last:Date.now(),started:Date.now()};changed=true}catch(e){if(e.statusCode===404||e.statusCode===410){delete subs[entry.id];changed=true}break}
    }
  }
  if(changed)writeJson(SUB_FILE,subs);
}
setInterval(tick,15000);setTimeout(tick,1500);
/* ===== Payments (Stripe Checkout). Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (+ PUBLIC_URL) to go live. ===== */
const ENT_FILE=path.join(DATA,'entitlements.json');let ents=readJson(ENT_FILE,{});
const PLANS={trial:{name:'LaingoPop Pro - 7 day pass',cents:199,mode:'payment',days:7},monthly:{name:'LaingoPop Pro - Monthly',cents:399,mode:'subscription',interval:'month',days:31},yearly:{name:'LaingoPop Pro - Yearly',cents:2999,mode:'subscription',interval:'year',days:366}};
const STRIPE=process.env.STRIPE_SECRET_KEY||'',WH=process.env.STRIPE_WEBHOOK_SECRET||'';
async function stripe(p,body){const r=await fetch('https://api.stripe.com/v1'+p,{method:'POST',headers:{Authorization:'Bearer '+STRIPE,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()});const j=await r.json();if(!r.ok)throw new Error(j.error?.message||'Stripe error');return j}
function grant(cid,plan,until,sub){if(!cid)return;ents[cid]={plan,until,sub:sub||ents[cid]?.sub||''};writeJson(ENT_FILE,ents)}
app.get('/api/pay/config',(req,res)=>res.json({live:!!STRIPE}));
app.post('/api/pay/checkout',async(req,res)=>{
  try{if(!STRIPE)return res.status(503).json({error:'Payments are not configured on the server yet.'});
    const {plan,cid,method}=req.body||{},P=PLANS[plan];if(!P||!/^[\w-]{8,64}$/.test(cid||''))return res.status(400).json({error:'Bad request'});
    const base=(process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');
    const b={mode:P.mode,client_reference_id:cid,'metadata[plan]':plan,'metadata[cid]':cid,success_url:base+'/?paid=1',cancel_url:base+'/?paid=0','line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(P.cents),'line_items[0][price_data][product_data][name]':P.name};
    if(P.mode==='subscription'){b['line_items[0][price_data][recurring][interval]']=P.interval;b['subscription_data[metadata][cid]']=cid}
    /* Only "card" is forced. Otherwise Stripe shows every method enabled in your Dashboard (wallets, UPI, netbanking where your account country supports them). */
    if(method==='card')b['payment_method_types[0]']='card';
    const s=await stripe('/checkout/sessions',b);res.json({url:s.url});
  }catch(e){res.status(500).json({error:e.message})}});
app.get('/api/pay/status',(req,res)=>{const e=ents[String(req.query.cid||'')];res.json(e&&e.until>Date.now()?{active:true,plan:e.plan,until:e.until}:{active:false})});
app.post('/api/pay/webhook',(req,res)=>{
  try{const sig=String(req.get('stripe-signature')||''),t=/t=(\d+)/.exec(sig)?.[1],v=[...sig.matchAll(/v1=([a-f0-9]+)/g)].map(m=>m[1]);
    if(!WH||!t||Math.abs(Date.now()/1000-t)>600)return res.status(400).end();
    const exp=crypto.createHmac('sha256',WH).update(t+'.'+req.rawBody).digest('hex');
    if(!v.some(x=>x.length===exp.length&&crypto.timingSafeEqual(Buffer.from(x),Buffer.from(exp))))return res.status(400).end();
    const ev=req.body,o=ev.data.object;
    if(ev.type==='checkout.session.completed'&&o.payment_status==='paid'){const P=PLANS[o.metadata?.plan];if(P)grant(o.client_reference_id,o.metadata.plan,Date.now()+P.days*864e5,o.subscription)}
    if(ev.type==='invoice.paid'){const cid=Object.keys(ents).find(k=>ents[k].sub&&ents[k].sub===o.subscription),end=o.lines?.data?.[0]?.period?.end;if(cid&&end)grant(cid,ents[cid].plan,end*1000+864e5)}
    res.json({received:true})}catch{res.status(400).end()}});

/* ---- UI localisation: translate app strings in batches, cache per language on disk (each string is translated once for all users) ---- */
const UI_LANGS=new Set('Hindi|Hinglish|Bengali|Urdu|Tamil|Telugu|Marathi|Gujarati|Punjabi|Kannada|Malayalam|Nepali|Sinhala|Arabic|Persian|Turkish|Hebrew|Spanish|Portuguese|French|German|Italian|Dutch|Russian|Ukrainian|Polish|Czech|Slovak|Romanian|Hungarian|Greek|Bulgarian|Serbian|Croatian|Swedish|Norwegian|Danish|Finnish|Icelandic|Estonian|Latvian|Lithuanian|Georgian|Armenian|Azerbaijani|Kazakh|Uzbek|Mongolian|Chinese (Simplified)|Chinese (Traditional)|Japanese|Korean|Thai|Vietnamese|Indonesian|Malay|Filipino|Khmer|Lao|Burmese|Swahili|Amharic|Hausa|Yoruba|Zulu|Afrikaans|Somali'.split('|'));
const uiC={},uiFile=l=>path.join(DATA,'ui-'+l.replace(/[^A-Za-z]/g,'')+'.json'),uiGet=l=>uiC[l]||(uiC[l]=readJson(uiFile(l),{}));
async function claudeUi(strs,lang){const key=process.env.ANTHROPIC_API_KEY;if(!key)return null;
  const system=`You localize a mobile English-vocabulary app's interface into ${lang}${lang==='Hinglish'?' (natural casual Hindi written in Roman letters, the way Indians text)':''}. Input: a JSON object {"1":"english",...}. Reply with ONLY a JSON object with the same keys and translated values. Keep {#} placeholders, emoji, punctuation and the words LaingoPop, LaingoBot, Pro, PDF unchanged. Use short, natural UI wording, never literal word-for-word.`;
  const obj={};strs.forEach((s,i)=>obj[i+1]=s);
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:process.env.ANTHROPIC_TRANSLATION_MODEL||'claude-sonnet-5',max_tokens:6000,system,messages:[{role:'user',content:JSON.stringify(obj)}]})});
  if(!r.ok)throw new Error('Claude HTTP '+r.status);const j=await r.json(),o=parseJsonText((j.content||[]).map(x=>x.text||'').join(''));if(!o)throw new Error('bad JSON');
  return strs.map((s,i)=>String(o[i+1]||'').trim())}
app.post('/api/ui/translate',async(req,res)=>{const lang=String(req.body?.lang||''),raw=Array.isArray(req.body?.strings)?req.body.strings:[];
  if(!UI_LANGS.has(lang))return res.status(400).json({error:'Unsupported language'});
  const list=[...new Set(raw.map(x=>String(x).trim()).filter(x=>x&&x.length<=220&&/[A-Za-z]/.test(x)))].slice(0,60),c=uiGet(lang),miss=list.filter(s=>!c[s]);
  if(miss.length){try{const t=await claudeUi(miss,lang);if(t)miss.forEach((s,i)=>{if(t[i])c[s]=t[i]})}catch(e){console.warn('ui translate:',e.message)}
    for(const s of miss.filter(s=>!c[s]).slice(0,15)){try{c[s]=(await fallbackTranslate(s,'English',lang)).text}catch{}}
    if(Object.keys(c).length<6000)writeJson(uiFile(lang),c)}
  const map={};list.forEach(s=>{if(c[s])map[s]=c[s]});res.json({map})});

/* ---- admin: ADMIN_KEY (16+ chars) in server env. Panel at /admin ---- */
const bad=new Map();
function adminAuth(req,res,next){const A=process.env.ADMIN_KEY||'',n=Date.now();let b=bad.get(req.ip);if(!b||n-b.t>9e5){b={n:0,t:n};bad.set(req.ip,b)}
  if(b.n>=5)return res.status(429).json({error:'Too many wrong keys. Try again in 15 minutes.'});
  const k=String(req.get('x-admin-key')||'');
  if(A.length<16||k.length!==A.length||!crypto.timingSafeEqual(Buffer.from(k),Buffer.from(A))){b.n++;return res.status(401).json({error:'Wrong key'})}
  b.n=0;next()}
app.get('/admin',(req,res)=>{res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex'});res.sendFile('admin.html',{root:__dirname})});
app.post(['/api/admin/grant','/api/pay/admin/grant'],adminAuth,(req,res)=>{const {cid,plan}=req.body||{},P=PLANS[plan];if(!P||!/^[\w-]{8,64}$/.test(cid||''))return res.status(400).json({error:'Bad device ID or plan'});grant(cid,plan,Date.now()+P.days*864e5);res.json({ok:true})});
app.post('/api/admin/revoke',adminAuth,(req,res)=>{const cid=String(req.body?.cid||'');if(ents[cid]){delete ents[cid];writeJson(ENT_FILE,ents)}res.json({ok:true})});
app.get('/api/admin/list',adminAuth,(req,res)=>res.json(Object.entries(ents).map(([cid,e])=>({cid,plan:e.plan,until:e.until})).sort((a,b)=>b.until-a.until)));

/* serve ONLY the public app files (never server/, data/, vapid.json, entitlements.json) */
const send1=f=>(req,res)=>res.sendFile(f,{root:ROOT,dotfiles:'deny'});
app.get(['/','/index.html'],send1('index.html'));app.get('/sw.js',send1('sw.js'));app.get('/manifest.webmanifest',send1('manifest.webmanifest'));app.get('/privacy.html',send1('privacy.html'));app.get('/.well-known/assetlinks.json',(q,r)=>r.sendFile('.well-known/assetlinks.json',{root:ROOT,dotfiles:'allow'}));
app.use('/assets',express.static(path.join(ROOT,'assets'),{dotfiles:'deny'}));app.use('/icons',express.static(path.join(ROOT,'icons'),{dotfiles:'deny'}));
app.use((err,req,res,next)=>res.status(400).json({error:'Bad request'}));
const port=Number(process.env.PORT||8787);
app.listen(port,()=>console.log(`LaingoPop device server: http://localhost:${port}`));
