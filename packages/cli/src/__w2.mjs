import pg from 'pg'; import { readFileSync } from 'node:fs';
const env=readFileSync('/Users/robert/projects/kanban/apps/api/.env','utf8');
const url=env.split('\n').find(l=>l.startsWith('DATABASE_URL')).split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const c=new pg.Client({connectionString:url}); await c.connect();
const DONE=['ready','merged','poisoned','dropped'];
for(;;){
  const s=await c.query("select id,stage,needs_human from runner.cards where id in ('0082','0043')");
  if(s.rows.every(r=>DONE.includes(r.stage)||r.needs_human)){
    console.log('BOTH SETTLED: '+s.rows.map(r=>`${r.id}=${r.stage}${r.needs_human?'(FLAGGED)':''}`).join(' '));
    break;
  }
  await new Promise(r=>setTimeout(r,20000));
}
await c.end();
