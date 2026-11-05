import { spawn } from 'node:child_process';
import { once } from 'node:events';
export default async function setup() {
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3100',DB_PATH:':memory:'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{if(String(chunk).includes('LockIn berjalan'))resolve();});child.on('exit',code=>reject(new Error(`Browser test server exited: ${code}`)));setTimeout(()=>reject(new Error('Browser test server timeout')),10000).unref();});
  return async()=>{child.kill();await once(child,'exit');};
}
