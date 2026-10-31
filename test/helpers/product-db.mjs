import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export class D1 {
  constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(readFileSync(new URL('../../hosted/drizzle/0000_aromatic_slapstick.sql',import.meta.url),'utf8'));}
  prepare(query){const statement=this.sql.prepare(query);let args=[];const run=()=>{if(/^SELECT/.test(query))return {results:statement.all(...args),meta:{changes:0}};return {results:[],meta:{changes:Number(statement.run(...args).changes)}};};return {bind(...values){args=values;return this;},run,all:run};}
  async batch(statements){this.sql.exec('BEGIN');try{const result=statements.map(s=>s.run());this.sql.exec('COMMIT');return result;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
}
