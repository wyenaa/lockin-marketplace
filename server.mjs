import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || resolve(root, 'data/lockin.sqlite');
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vendors(id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id), name TEXT, category TEXT, price INTEGER, deposit INTEGER DEFAULT 0, rating REAL, completed INTEGER, verified INTEGER, color TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), vendor_id INTEGER REFERENCES vendors(id), event_date TEXT, location TEXT, start_time TEXT, price INTEGER, deposit INTEGER, paid INTEGER DEFAULT 0, state TEXT, agreement TEXT, hash TEXT, created TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, booking_id TEXT REFERENCES bookings(id), method TEXT, amount INTEGER, outcome TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS disputes(id TEXT PRIMARY KEY, booking_id TEXT UNIQUE REFERENCES bookings(id), reason TEXT, evidence TEXT, response TEXT DEFAULT '', decision TEXT, refund INTEGER DEFAULT 0, created TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, booking_id TEXT REFERENCES bookings(id), state TEXT, hash TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY, contact TEXT UNIQUE, created TEXT);`);
const hashPassword = password => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); };
const checkPassword = (password, saved) => { const [salt, hash] = saved.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex')); };
if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
  for (const [name, email, role] of [['Pelanggan Demo','user@lockin.demo','customer'],['Vendor Demo','vendor@lockin.demo','vendor'],['Admin Demo','admin@lockin.demo','admin']]) db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)').run(name,email,hashPassword('LockInDemo123!'),role);
}
if (!db.prepare('SELECT id FROM vendors LIMIT 1').get()) {
  const vendors = [
    ['Teman Wisuda','PA Wisuda',250000,0,4.9,48,1,'pink','Pendamping wisuda seharian: bantu toga, barang bawaan, dan kebutuhan di hari istimewamu.'],
    ['Glow Graduation','GCC',450000,0,4.9,36,1,'blue','Dokumentasi foto dan video pendek wisuda. Termasuk 30 file edit dan satu kali revisi.'],
    ['Nara Beauty','Hijab & Hair Stylist',350000,0,4.8,52,1,'green','Hijab styling dan hair do untuk satu orang, satu hari. Tampil percaya diri di hari wisuda.'],
    ['Aurelia Makeup','MUA',500000,0,4.9,64,1,'gold','Makeup wisuda natural dan tahan lama, termasuk persiapan serta konsultasi tampilan.'],
    ['Ruang Akrilik','Standing Sign',150000,100000,4.8,28,1,'purple','Acrylic standing sign 40 × 60 cm, sewa satu hari. Nama dan teks disiapkan sebelum hari H.'],
    ['Cerita Kampus','GCC',375000,0,4.7,23,1,'red','Abadikan momen wisuda dengan foto dan video vertikal. Termasuk 20 file edit dan satu revisi.']
  ];
  for(const v of vendors) db.prepare('INSERT INTO vendors(owner_id,name,category,price,deposit,rating,completed,verified,color,description) VALUES(2,?,?,?,?,?,?,?,?,?)').run(...v);
}
const fail = (status, message) => { throw Object.assign(new Error(message),{status}); };
const now = () => new Date().toISOString();
const localToday = () => new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jakarta'});
const digest = text => '0x'+createHash('sha256').update(text).digest('hex');
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } }
function audit(id,state) { const previous=db.prepare('SELECT hash FROM audit WHERE booking_id=? ORDER BY id DESC LIMIT 1').get(id)?.hash || ''; db.prepare('INSERT INTO audit(booking_id,state,hash,created) VALUES(?,?,?,?)').run(id,state,digest(previous+id+state+now()),now()); }
function expire() { db.prepare("UPDATE bookings SET state='Expired' WHERE state='Pending' AND expires < ?").run(Date.now()); }
function booking(id,user) {
  const b=db.prepare('SELECT b.*,v.name vendor_name,v.category,v.owner_id FROM bookings b JOIN vendors v ON v.id=b.vendor_id WHERE b.id=?').get(id);
  if(!b) fail(404,'Booking tidak ditemukan.');
  if(user.role!=='admin' && b.user_id!==user.id && !(user.role==='vendor' && b.owner_id===user.id)) fail(403,'Anda tidak memiliki akses ke booking ini.');
  return b;
}
async function body(req) { let chunks='', size=0; for await(const c of req) { size+=c.length; if(size>100000) fail(413,'Data terlalu besar.'); chunks+=c; } try { return JSON.parse(chunks||'{}'); } catch { fail(400,'JSON tidak valid.'); } }
function text(value,label,max=500) { if(typeof value!=='string'||!value.trim()||value.length>max) fail(400,`${label} tidak valid.`); return value.trim(); }
function userOf(req) { const token=/lockin_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1]; return db.prepare('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token||'',Date.now()); }
function send(res,status,data,headers={}) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}); res.end(JSON.stringify(data)); }
async function api(req,res,url) {
  expire();
  const path=url.pathname, method=req.method, user=userOf(req);
  if(method!=='GET' && req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`) fail(403,'Origin tidak diizinkan.');
  if(path==='/api/health') return send(res,200,{ok:true,mode:'sandbox',database:'SQLite'});
  if(path==='/api/auth/me') return send(res,200,{user:user||null});
  if(path==='/api/auth/logout' && method==='POST') { const token=/lockin_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1]; db.prepare('DELETE FROM sessions WHERE token=?').run(token||''); return send(res,200,{ok:true},{'Set-Cookie':'lockin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}); }
  if(['/api/auth/login','/api/auth/register'].includes(path)&&method==='POST') {
    const d=await body(req), email=text(d.email,'Email',160).toLowerCase(), password=text(d.password,'Password',128);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Format email tidak valid.');
    if(path.endsWith('register')) { if(password.length<10) fail(400,'Password minimal 10 karakter.'); if(db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail(409,'Email sudah terdaftar.'); db.prepare("INSERT INTO users(name,email,password,role) VALUES(?,?,?,'customer')").run(text(d.name,'Nama',80),email,hashPassword(password)); }
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!u||!checkPassword(password,u.password)) fail(401,'Email atau password salah.');
    const token=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,u.id,Date.now()+86400000);
    const {password:_,...safe}=u; return send(res,200,{user:safe},{'Set-Cookie':`lockin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`});
  }
  if(path==='/api/vendors' && method==='GET') {
    let rows=db.prepare('SELECT id,name,category,price,deposit,rating,completed,verified,color,description FROM vendors').all();
    const category=url.searchParams.get('category'),city=url.searchParams.get('city'),date=url.searchParams.get('date');
    if(category&&category!=='Semua') rows=rows.filter(v=>v.category===category);
    if(city && !'malang'.includes(city.toLowerCase())) rows=[];
    if(date) rows=rows.filter(v=>!db.prepare("SELECT id FROM bookings WHERE vendor_id=? AND event_date=? AND state NOT IN ('Expired','Cancelled','Refunded')").get(v.id,date));
    if(url.searchParams.get('sort')==='price') rows.sort((a,b)=>a.price-b.price);
    if(url.searchParams.get('sort')==='rating') rows.sort((a,b)=>b.rating-a.rating);
    return send(res,200,rows);
  }
  if(/^\/api\/vendors\/\d+$/.test(path)&&method==='GET') {
    const v=db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(path.split('/').pop())); if(!v) fail(404,'Vendor tidak ditemukan.');
    const reserved=db.prepare("SELECT event_date FROM bookings WHERE vendor_id=? AND state NOT IN ('Expired','Cancelled','Refunded')").all(v.id).map(x=>x.event_date); return send(res,200,{...v,reserved});
  }
  if(path==='/api/leads'&&method==='POST') { const d=await body(req),contact=text(d.contact,'Email atau WhatsApp',160); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)&&!/^\+?[\d\s-]{9,18}$/.test(contact)) fail(400,'Masukkan email atau nomor WhatsApp yang valid.'); db.prepare('INSERT OR IGNORE INTO leads(contact,created) VALUES(?,?)').run(contact,now()); return send(res,201,{message:'Terima kasih! Pendaftaran minat vendor tersimpan.'}); }
  if(!user) fail(401,'Silakan masuk terlebih dahulu.');
  if(path==='/api/bookings'&&method==='GET') { const rows=db.prepare('SELECT b.*,v.name vendor_name,v.category,v.owner_id FROM bookings b JOIN vendors v ON v.id=b.vendor_id ORDER BY b.created DESC').all().filter(b=>user.role==='admin'||b.user_id===user.id||(user.role==='vendor'&&b.owner_id===user.id)); return send(res,200,rows); }
  if(path==='/api/bookings'&&method==='POST') {
    if(user.role!=='customer') fail(403,'Gunakan akun pelanggan untuk membuat booking.');
    const d=await body(req),v=db.prepare('SELECT * FROM vendors WHERE id=?').get(Number(d.vendorId)); if(!v) fail(404,'Vendor tidak ditemukan.');
    if(!d.agreed) fail(400,'Setujui perjanjian terlebih dahulu.');
    const date=text(d.date,'Tanggal',10); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date<new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jakarta'})) fail(400,'Pilih tanggal acara yang valid dan belum lewat.');
    const location=text(d.location,'Lokasi',200), start=text(d.startTime,'Jam mulai',5); if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) fail(400,'Jam mulai tidak valid.');
    const id='LI-'+randomBytes(5).toString('hex').toUpperCase(), agreement=JSON.stringify({vendorId:v.id,category:v.category,date,location,startTime:start,price:v.price,deposit:v.deposit,refund:v.deposit?'H-3:100%;H-2:0%':'H-7:100%;H-3:50%;H-2:0%',scope:v.description,...(v.category==='GCC'?{revisions:1,files:v.id===6?20:30}:{})});
    transaction(()=>{ if(db.prepare("SELECT id FROM bookings WHERE vendor_id=? AND event_date=? AND state NOT IN ('Expired','Cancelled','Refunded')").get(v.id,date)) fail(409,'Vendor sudah dipesan pada tanggal ini. Pilih tanggal lain.'); db.prepare("INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,0,'Pending',?,?,?,?)").run(id,user.id,v.id,date,location,start,v.price,v.deposit,agreement,digest(agreement),now(),Date.now()+86400000); audit(id,'AgreementLocked'); });
    return send(res,201,booking(id,user));
  }
  const match=/^\/api\/bookings\/([^/]+)(?:\/(payment|complete|cancel|dispute|audit))?$/.exec(path);
  if(match) {
    const b=booking(match[1],user),action=match[2];
    if(method==='GET'&&!action) return send(res,200,{...b,dispute:db.prepare('SELECT * FROM disputes WHERE booking_id=?').get(b.id)||null});
    if(method==='GET'&&action==='audit') return send(res,200,db.prepare('SELECT state,hash,created FROM audit WHERE booking_id=? ORDER BY id').all(b.id));
    if(method!=='POST') fail(405,'Metode tidak diizinkan.');
    if(b.user_id!==user.id) fail(403,'Tindakan ini hanya untuk pemilik booking.');
    const d=await body(req);
    if(action==='payment') {
      if(!['Pending','DPPaid'].includes(b.state)) fail(409,'Booking tidak dapat dibayar pada status ini.');
      if(d.expectedState && d.expectedState!==b.state) fail(409,'Status pembayaran telah berubah. Muat ulang halaman sebelum melanjutkan.');
      if(!['QRIS','Virtual Account','E-wallet'].includes(d.method)) fail(400,'Metode pembayaran tidak valid.');
      if(!['success','failed','expired'].includes(d.outcome)) fail(400,'Skenario pembayaran tidak valid.');
      const amount=b.state==='Pending'?(b.deposit?b.price+b.deposit:Math.round(b.price*.3)):b.price-b.paid;
      transaction(()=>{ db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?)').run(randomBytes(12).toString('hex'),b.id,d.method,amount,d.outcome,now()); if(d.outcome==='success'){ const state=b.deposit||b.state==='DPPaid'?'Paid':'DPPaid'; db.prepare('UPDATE bookings SET paid=paid+?,state=? WHERE id=?').run(amount,state,b.id); audit(b.id,state); } else if(d.outcome==='expired'){db.prepare("UPDATE bookings SET state='Expired' WHERE id=?").run(b.id);audit(b.id,'Expired');} });
      return send(res,200,{...booking(b.id,user),outcome:d.outcome});
    }
    if(action==='complete') { if(b.state!=='Paid') fail(409,'Booking harus lunas dan tidak sedang sengketa.'); if(b.event_date>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jakarta'})) fail(409,'Acara belum berlangsung. Konfirmasi setelah tanggal acara.'); transaction(()=>{db.prepare("UPDATE bookings SET state='Completed' WHERE id=?").run(b.id);audit(b.id,'Completed');});return send(res,200,booking(b.id,user)); }
    if(action==='cancel') { if(!['Pending','DPPaid','Paid'].includes(b.state)) fail(409,'Booking tidak dapat dibatalkan.'); const days=Math.round((Date.parse(b.event_date)-Date.parse(localToday()))/86400000),rate=b.deposit?(days>=3?1:0):(days>=7?1:days>=3?.5:0),refund=Math.round(Math.min(b.paid,b.price)*rate)+(b.deposit&&b.paid?b.deposit:0); transaction(()=>{db.prepare("UPDATE bookings SET state='Cancelled' WHERE id=?").run(b.id);audit(b.id,'Cancelled:refund='+refund);});return send(res,200,{...booking(b.id,user),refund}); }
    if(action==='dispute') { if(!['DPPaid','Paid'].includes(b.state)) fail(409,'Keluhan hanya dapat diajukan untuk booking yang sudah dibayar.'); const elapsed=Date.now()-Date.parse(b.event_date+'T00:00:00+07:00'); if(elapsed<0||elapsed>3*86400000) fail(409,'Keluhan dapat diajukan pada hari acara hingga 48 jam setelah akhir hari acara.'); const reason=text(d.reason,'Alasan',1000),evidence=text(d.evidence,'Bukti atau keterangan',4000),id='DSP-'+randomBytes(4).toString('hex'); transaction(()=>{db.prepare('INSERT INTO disputes(id,booking_id,reason,evidence,created) VALUES(?,?,?,?,?)').run(id,b.id,reason,evidence,now());db.prepare("UPDATE bookings SET state='Disputed' WHERE id=?").run(b.id);audit(b.id,'Disputed');});return send(res,201,{id}); }
  }
  if(path==='/api/disputes'&&method==='GET') { if(user.role!=='admin'&&user.role!=='vendor') fail(403,'Akses ditolak.'); const rows=db.prepare('SELECT d.*,b.event_date,b.paid,b.hash,b.agreement,b.state,v.name vendor_name,v.owner_id FROM disputes d JOIN bookings b ON b.id=d.booking_id JOIN vendors v ON v.id=b.vendor_id ORDER BY d.created DESC').all();return send(res,200,rows.filter(d=>user.role==='admin'||d.owner_id===user.id)); }
  const disputeMatch=/^\/api\/disputes\/([^/]+)\/(resolve|response)$/.exec(path);
  if(disputeMatch&&method==='POST') { const d=await body(req),dispute=db.prepare('SELECT * FROM disputes WHERE id=?').get(disputeMatch[1]); if(!dispute) fail(404,'Sengketa tidak ditemukan.');const b=booking(dispute.booking_id,user);if(dispute.decision) fail(409,'Sengketa telah diputuskan.');
    if(disputeMatch[2]==='response'){if(user.role!=='vendor'||b.owner_id!==user.id)fail(403,'Hanya vendor terkait yang dapat menanggapi.');db.prepare('UPDATE disputes SET response=? WHERE id=?').run(text(d.response,'Tanggapan',4000),dispute.id);return send(res,200,{ok:true});}
    if(user.role!=='admin') fail(403,'Hanya admin yang dapat memutuskan sengketa.'); if(!['release','partial','full'].includes(d.decision))fail(400,'Keputusan tidak valid.');const percent=d.decision==='full'?100:d.decision==='release'?0:Number(d.percent);if(!Number.isFinite(percent)||percent<0||percent>100)fail(400,'Persentase harus 0–100.'); const refund=Math.round(b.paid*percent/100);transaction(()=>{db.prepare('UPDATE disputes SET decision=?,refund=? WHERE id=?').run(d.decision,refund,dispute.id);db.prepare('UPDATE bookings SET state=? WHERE id=?').run(percent===100?'Refunded':'Resolved',b.id);audit(b.id,'Resolved:refund='+refund);});return send(res,200,{ok:true,refund}); }
  fail(404,'Endpoint tidak ditemukan.');
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
  try { const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(!['GET','HEAD'].includes(req.method))fail(405,'Metode tidak diizinkan.');
    const publicRoot=resolve(root,'public'),file=resolve(publicRoot,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(publicRoot+'\\')&&!file.startsWith(publicRoot+'/'))fail(403,'Akses ditolak.');if(!existsSync(file))fail(404,'Halaman tidak ditemukan.');const data=readFileSync(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:data);
  } catch(e){send(res,e.status||500,{error:e.status?e.message:'Terjadi kesalahan server.'});if(!e.status)console.error(e);}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`LockIn berjalan di http://${process.env.HOST||'127.0.0.1'}:${server.address().port} (sandbox)`));
