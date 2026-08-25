import pg from 'pg'; import { readFileSync } from 'node:fs';
const env=readFileSync('/Users/robert/projects/kanban/apps/api/.env','utf8');
const url=env.split('\n').find(l=>l.startsWith('DATABASE_URL')).split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const c=new pg.Client({connectionString:url}); await c.connect();
let last=(await c.query("select coalesce(max(id),0) m from runner.card_events where card_id='0055'")).rows[0].m;
const DONE=['ready','merged','poisoned','dropped','needs-human'];
for(;;){
  const r=await c.query("select stage,type,payload,created_at from runner.card_events where card_id='0055' and id>$1 and type<>'tool.denied' order by id",[last]);
  for(const x of r.rows){ last=x.id;
    const extra=['stage.failed','transition.written','chain.stopped'].includes(x.type)?' '+JSON.stringify(x.type==='stage.failed'?x.payload?.failures:x.payload).slice(0,200):'';
    console.log(`${x.created_at.toISOString().slice(11,19)} ${(x.stage||'-').padEnd(12)} ${x.type}${extra}`); }
  const s=(await c.query("select stage,needs_human from runner.cards where id='0055'")).rows[0];
  if(DONE.includes(s.stage)){ console.log(`0055 SETTLED: ${s.stage}${s.needs_human?' (flagged)':''}`); break; }
  await new Promise(r=>setTimeout(r,20000));
}
await c.end();
