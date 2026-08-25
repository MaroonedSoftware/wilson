import pg from 'pg'; import { readFileSync } from 'node:fs';
const env=readFileSync('/Users/robert/projects/kanban/apps/api/.env','utf8');
const url=env.split('\n').find(l=>l.startsWith('DATABASE_URL')).split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const c=new pg.Client({connectionString:url}); await c.connect();
const ids=process.argv.slice(2);
let last=(await c.query("select coalesce(max(id),0) m from runner.card_events where card_id = any($1)",[ids])).rows[0].m;
const DONE=['ready','merged','poisoned','dropped'];
for(;;){
  const r=await c.query("select card_id,stage,type,payload,created_at from runner.card_events where card_id = any($1) and id>$2 and type in ('stage.failed','chain.stopped','stage.poisoned','card.over-budget') order by id",[ids,last]);
  for(const x of r.rows){ last=x.id;
    console.log(`${x.created_at.toISOString().slice(11,19)} ${x.card_id} ${(x.stage||'-').padEnd(12)} ${x.type} ${String(JSON.stringify(x.type==='stage.failed'?x.payload?.failures:x.payload) ?? '').slice(0,150)}`); }
  const m=await c.query("select coalesce(max(id),0) m from runner.card_events where card_id = any($1)",[ids]); last=m.rows[0].m;
  const s=await c.query("select id,stage,needs_human from runner.cards where id = any($1)",[ids]);
  if(s.rows.every(r=>DONE.includes(r.stage)||r.needs_human)){ console.log('SETTLED: '+s.rows.map(r=>`${r.id}=${r.stage}${r.needs_human?'(FLAGGED)':''}`).join(' ')); break; }
  await new Promise(r=>setTimeout(r,20000));
}
await c.end();
