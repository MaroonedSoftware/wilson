import pg from 'pg'; import { readFileSync } from 'node:fs';
const env=readFileSync('/Users/robert/projects/kanban/apps/api/.env','utf8');
const url=env.split('\n').find(l=>l.startsWith('DATABASE_URL')).split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const c=new pg.Client({connectionString:url}); await c.connect();
const ids=['0053','0054'];
let last=(await c.query("select coalesce(max(id),0) m from runner.card_events where card_id = any($1)",[ids])).rows[0].m;
for(;;){
  const r=await c.query("select card_id,type,stage,payload,created_at from runner.card_events where card_id = any($1) and id>$2 and type <> 'tool.denied' order by id",[ids,last]);
  for(const x of r.rows){ last=x.id;
    const extra = x.type==='stage.failed'||x.type==='transition.written' ? ' '+JSON.stringify(x.payload).slice(0,160) : '';
    console.log(`${x.created_at.toISOString().slice(11,19)} ${x.card_id} ${x.stage||'-'} ${x.type}${extra}`); }
  const st=await c.query("select id,stage from runner.cards where id = any($1)",[ids]);
  if(st.rows.every(r=>['ready','merged','poisoned','dropped'].includes(r.stage))){ console.log('BOTH SETTLED: '+st.rows.map(r=>r.id+'='+r.stage).join(' ')); break; }
  await new Promise(r=>setTimeout(r,20000));
}
await c.end();
