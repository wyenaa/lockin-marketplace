import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['backend/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: '0', HOST: '127.0.0.1',
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
    MIDTRANS_SERVER_KEY: '', SEPOLIA_RPC_URL: '', SEPOLIA_WRITER_PRIVATE_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let baseUrl;
let log = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Server gagal mulai: ${log}`)), 8000);
  server.stdout.on('data', chunk => {
    log += chunk;
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (match) { clearTimeout(timer); baseUrl = `http://127.0.0.1:${match[1]}`; resolve(); }
  });
  server.once('error', reject);
});
async function call(path, { method = 'GET', data, cookie } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(data ? { 'content-type': 'application/json' } : {})
    },
    body: data ? JSON.stringify(data) : undefined
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

test('login dan otorisasi role tidak bisa dipalsukan dari frontend', async t => {
  await ready;
  t.after(() => server.kill());
  const unauthenticated = await call('/api/auth/me');
  assert.equal(unauthenticated.data.user, null);
  assert.equal((await call('/api/bookings')).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', data: {
    email: 'admin@lockin.demo', password: 'salah'
  } })).status, 401);
  const customer = await call('/api/auth/login', { method: 'POST', data: {
    email: 'user@lockin.demo', password: 'LockInDemo123!'
  } });
  assert.equal(customer.status, 200);
  assert.equal(customer.data.user.role, 'customer');
  assert.equal((await call('/api/auth/me', { cookie: customer.cookie })).data.user.role, 'customer');
  assert.equal((await call('/api/disputes', { cookie: customer.cookie })).status, 403);
  const vendor = await call('/api/auth/login', { method: 'POST', data: {
    email: 'vendor@lockin.demo', password: 'LockInDemo123!'
  } });
  assert.equal(vendor.data.user.role, 'vendor');
  const admin = await call('/api/auth/login', { method: 'POST', data: {
    email: 'admin@lockin.demo', password: 'LockInDemo123!'
  } });
  assert.equal(admin.data.user.role, 'admin');
  assert.equal((await call('/api/disputes', { cookie: admin.cookie })).status, 200);
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: admin.cookie })).status, 200);
  assert.equal((await call('/api/auth/me', { cookie: admin.cookie })).data.user, null);
  const spoof = await call('/api/auth/register', { method: 'POST', data: {
    name: 'Coba', email: 'fakeadmin@example.com', password: 'super-secure-test', role: 'admin'
  } });
  assert.equal(spoof.status, 201);
  const spoofLogin = await call('/api/auth/login', { method: 'POST', data: {
    email: 'fakeadmin@example.com', password: 'super-secure-test'
  } });
  assert.equal(spoofLogin.data.user.role, 'customer');
});
