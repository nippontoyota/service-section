// Explicit operational reset. Preserves all staff accounts, credentials and sessions.
// Dry run by default; --apply first backs up all selected records and stored objects.
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const apply=process.argv.includes('--apply');
const service=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const tables=['gate_pass_bills','gate_passes','customer_bill_links','audit_events','payments','bill_edit_log','bills','uploads','settlement_cases','desk_operations','customers','purge_runs'];
const keys={gate_pass_bills:'pass_id',customer_bill_links:'code_hash'};
async function rows(table){const all=[];for(let offset=0;;offset+=1000){const query=service.from(table).select('*').order(keys[table]||'id');if(table==='gate_pass_bills')query.order('bill_id');const {data,error}=await query.range(offset,offset+999);if(error)throw new Error(`${table}: ${error.message}`);all.push(...data);if(data.length<1000)return all;}}
async function objects(prefix=''){const all=[];for(let offset=0;;offset+=100){const {data,error}=await service.storage.from('bills').list(prefix,{limit:100,offset,sortBy:{column:'name',order:'asc'}});if(error)throw new Error(error.message);for(const item of data){const path=prefix?`${prefix}/${item.name}`:item.name;if(item.id)all.push({path,id:item.id,updated_at:item.updated_at});else all.push(...await objects(path));}if(data.length<100)return all;}}
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname;
const snapshot={};for(const table of tables)snapshot[table]=await rows(table);
const profiles=await rows('profiles');
const {data:credentials,error:credentialError}=await service.from('staff_credentials').select('*').order('staff_id');
if(credentialError)throw new Error('Could not verify staff credentials; nothing deleted');
const paths=await objects();
console.log('Project:',project);console.log('Keep all staff accounts:',profiles.length);console.log('Operational records:',Object.fromEntries(tables.map(t=>[t,snapshot[t].length])),'Stored files:',paths.length);
if(!apply){console.log('Dry run only. No records changed.');process.exit(0);}
const backup=resolve('output','operational-reset-'+new Date().toISOString().replaceAll(':','-'));
await mkdir(backup,{recursive:true,mode:0o700});
const manifest=[];
for(const [index,item] of paths.entries()){const {data,error}=await service.storage.from('bills').download(item.path);if(error||!data)throw new Error(`Backup failed for object ${index}; nothing deleted`);const bytes=Buffer.from(await data.arrayBuffer());await writeFile(resolve(backup,`${index}.pdf`),bytes,{mode:0o600});manifest.push({...item,file:`${index}.pdf`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await writeFile(resolve(backup,'database.json'),JSON.stringify({project,createdAt:new Date().toISOString(),snapshot,profiles,credentials,objects:manifest},null,2),{mode:0o600});
console.log('Private backup:',backup);
// Abort before deleting if traffic changed any of the captured records during backup.
for(const table of tables)if(JSON.stringify(await rows(table))!==JSON.stringify(snapshot[table]))throw new Error(`Database changed during backup (${table}). Pause app traffic and retry. Nothing deleted.`);
if(JSON.stringify(await objects())!==JSON.stringify(paths))throw new Error('Storage changed during backup. Nothing deleted.');
for(const table of tables){const records=snapshot[table],key=keys[table]||'id';if(records.length){const ids=[...new Set(records.map(r=>r[key]))];
 // Payments include reversal self-references: delete their captured IDs in one statement.
 const {error}=await service.from(table).delete().in(key,ids);if(error)throw new Error(`Reset stopped at ${table}: ${error.message}. Restore from ${backup} if needed.`);
 }if((await rows(table)).length)throw new Error(`New records detected in ${table}; stopped. Backup: ${backup}`);}
for(let i=0;i<paths.length;i+=100){const {error}=await service.storage.from('bills').remove(paths.slice(i,i+100).map(p=>p.path));if(error)throw new Error(`Storage cleanup failed; backup: ${backup}`);}
const afterProfiles=await rows('profiles');
const {data:afterCredentials,error:verifyError}=await service.from('staff_credentials').select('*').order('staff_id');
if(verifyError||JSON.stringify(afterProfiles)!==JSON.stringify(profiles)||JSON.stringify(afterCredentials)!==JSON.stringify(credentials))throw new Error('Staff verification mismatch. Review backup before further action.');
for(const table of tables)if((await rows(table)).length)throw new Error(`${table} is not empty; new app traffic detected.`);
if((await objects()).length)throw new Error('Storage is not empty; new app traffic detected.');
await writeFile(resolve(backup,'verification.json'),JSON.stringify({project,verifiedAt:new Date().toISOString(),staffRetained:profiles.length,operationalRecords:0,storedFiles:0},null,2),{mode:0o600});
console.log('Verified: operational records and PDFs are empty. All staff accounts and password hashes are unchanged.');
