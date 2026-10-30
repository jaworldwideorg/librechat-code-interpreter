/** AWS adapter boundary. Admission domain/backends depend on the store interface. */
import { DynamoDBClient, GetItemCommand, BatchGetItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import { MicrovmAdmissionError, validateAdmissionPolicy, type AdmissionPolicy, type AdmissionLease, type AdmissionDecision, type MicrovmAdmissionStore } from './admission';

type Item = Record<string,AttributeValue>;
const key=(pk:string)=>({pk:{S:pk}});
const leaseKey=(id:string)=>`lease#${id}`;
const ownerKey=(lease:AdmissionLease)=>`owner#${lease.owner}#${lease.kind}#${lease.lane}${lease.lane==='execution'?'#'+lease.id:''}`;
const totalKey=(slot:number)=>`slot#total#${slot}`;
const kindKey=(kind:string,slot:number)=>`slot#${kind}#${slot}`;
const token=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,36);

export class DynamoMicrovmAdmissionStore implements MicrovmAdmissionStore {
  private readonly client:DynamoDBClient;
  constructor(private readonly table:string,options:{region?:string;client?:DynamoDBClient}={}) {
    if(!table) throw new MicrovmAdmissionError('UNAVAILABLE','Missing admission table');
    this.client=options.client??new DynamoDBClient({region:options.region,maxAttempts:3});
  }
  private async item(pk:string,signal:AbortSignal):Promise<Item|undefined> {
    return (await this.client.send(new GetItemCommand({TableName:this.table,Key:key(pk),ConsistentRead:true}),{abortSignal:signal})).Item;
  }
  async policy(signal:AbortSignal):Promise<AdmissionPolicy|undefined> {
    const item=await this.item('policy#active',signal);
    if(!item) return undefined;
    const policy=validateAdmissionPolicy(JSON.parse(item.payload.S!));
    if(item.revision.S!==policy.revision) throw new MicrovmAdmissionError('UNAVAILABLE','Admission policy receipt is inconsistent');
    return policy;
  }
  async get(id:string,signal:AbortSignal):Promise<AdmissionLease|undefined> {
    const item=await this.item(leaseKey(id),signal);
    if(!item) return undefined;
    const lease=JSON.parse(item.payload.S!) as AdmissionLease;
    if(lease.id!==id || lease.fingerprint!==item.fingerprint.S || item.lease_id.S!==id
        || !/^[a-f0-9]{64}$/.test(lease.owner) || !['coding','app'].includes(lease.kind)
        || !['workspace','execution','app'].includes(lease.lane) || (lease.kind==='app')!==(lease.lane==='app')
        || !lease.request?.clientToken || lease.request.runHookPayload != null
        || !Number.isInteger(lease.request.maximumDurationSeconds) || lease.request.maximumDurationSeconds<1 || lease.request.maximumDurationSeconds>28_800
        || !Number.isInteger(lease.totalSlot) || lease.totalSlot!<0 || lease.totalSlot!>=14
        || !Number.isInteger(lease.kindSlot) || lease.kindSlot!<0 || lease.kindSlot!>=(lease.kind==='coding'?10:4)
        || lease.id!==createHash('sha256').update(JSON.stringify([lease.kind,lease.request.clientToken])).digest('hex')
        || lease.fingerprint!==createHash('sha256').update(JSON.stringify([lease.owner,lease.kind,lease.lane,lease.request])).digest('hex')) {
      throw new MicrovmAdmissionError('CONFLICT','Admission reservation is inconsistent');
    }
    return {...lease,vmId:item.vm_id?.S,retiring:item.retiring?.BOOL};
  }
  private async rows(names:string[],signal:AbortSignal):Promise<Map<string,Item>> {
    const occupied=new Map<string,Item>();
    let keys:Item[]=names.map(key);
    for(let attempt=0;keys.length && attempt<8;attempt++) {
      const response=await this.client.send(new BatchGetItemCommand({RequestItems:{[this.table]:{Keys:keys,ConsistentRead:true}}}),{abortSignal:signal});
      for(const item of response.Responses?.[this.table]??[]) occupied.set(item.pk.S!,item);
      keys=response.UnprocessedKeys?.[this.table]?.Keys??[];
      if(keys.length) await new Promise<void>((resolve,reject)=>{
        if(signal.aborted){reject(signal.reason);return;}
        const done=()=>{signal.removeEventListener('abort',abort);resolve();};
        const timer=setTimeout(done,20*(attempt+1));
        const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
        signal.addEventListener('abort',abort,{once:true});
      });
    }
    if(keys.length) throw new MicrovmAdmissionError('UNAVAILABLE','Admission reads are throttled');
    return occupied;
  }
  async leases(signal:AbortSignal):Promise<AdmissionLease[]> {
    const rows=await this.rows(Array.from({length:14},(_,i)=>totalKey(i)),signal);
    const ids=[...new Set([...rows.values()].map(item=>item.lease_id.S!))];
    const leases=await Promise.all(ids.map(id=>this.get(id,signal)));
    if(leases.some(lease=>!lease)) throw new MicrovmAdmissionError('CONFLICT','Admission slot is missing its reservation');
    return leases as AdmissionLease[];
  }
  async reserve(lease:AdmissionLease,policy:AdmissionPolicy,signal:AbortSignal):Promise<AdmissionDecision> {
    validateAdmissionPolicy(policy);
    const totalNames=Array.from({length:policy.total},(_,i)=>totalKey(i));
    const kindNames=Array.from({length:policy[lease.kind]},(_,i)=>kindKey(lease.kind,i));
    for(let attempt=0;attempt<8;attempt++) {
      signal.throwIfAborted();
      const existing=await this.get(lease.id,signal);
      if(existing) {
        if(existing.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','Launch reservation identity changed');
        return 'existing';
      }
      if((await this.policy(signal))?.revision!==policy.revision) return 'policy_changed';
      if(await this.item(ownerKey(lease),signal)) return 'owner_busy';
      const occupied=await this.rows([...totalNames,...kindNames],signal);
      const totalSlot=totalNames.findIndex(name=>!occupied.has(name));
      const kindSlot=kindNames.findIndex(name=>!occupied.has(name));
      if(totalSlot<0 || kindSlot<0) return 'full';
      const accepted={...lease,totalSlot,kindSlot};
      const slotRows=[totalKey(totalSlot),kindKey(lease.kind,kindSlot),ownerKey(lease)].map(pk=>({
        Put:{TableName:this.table,Item:{...key(pk),lease_id:{S:lease.id}},ConditionExpression:'attribute_not_exists(pk)'}
      }));
      const transaction=[
        {ConditionCheck:{TableName:this.table,Key:key('policy#active'),ConditionExpression:'#revision = :revision',ExpressionAttributeNames:{'#revision':'revision'},ExpressionAttributeValues:{':revision':{S:policy.revision}}}},
        ...slotRows,
        {Put:{TableName:this.table,Item:{...key(leaseKey(lease.id)),lease_id:{S:lease.id},fingerprint:{S:lease.fingerprint},payload:{S:JSON.stringify(accepted)}},ConditionExpression:'attribute_not_exists(pk)'}}
      ];
      try {
        await this.client.send(new TransactWriteItemsCommand({TransactItems:transaction,ClientRequestToken:token(['reserve',accepted,policy.revision,attempt])}),{abortSignal:signal});
        return 'reserved';
      } catch(error) {
        const failure=error as {name?:string;CancellationReasons?:{Code?:string}[]};
        if(failure.name!=='TransactionCanceledException' || failure.CancellationReasons?.some(e=>e.Code && !['None','ConditionalCheckFailed','TransactionConflict'].includes(e.Code))) throw error;
        // A concurrent winner or policy update is resolved by fresh strongly
        // consistent reads. Unknown provider failures never release capacity.
      }
    }
    throw new MicrovmAdmissionError('UNAVAILABLE','VM admission is contended');
  }
  async beginRetirement(id:string,fingerprint:string,signal:AbortSignal):Promise<boolean> {
    try {
      await this.client.send(new UpdateItemCommand({TableName:this.table,Key:key(leaseKey(id)),UpdateExpression:'SET retiring = :yes',
        ConditionExpression:'#fingerprint = :fingerprint AND (attribute_not_exists(vm_id) OR retiring = :yes)',
        ExpressionAttributeNames:{'#fingerprint':'fingerprint'},ExpressionAttributeValues:{':fingerprint':{S:fingerprint},':yes':{BOOL:true}}}),{abortSignal:signal});
      return true;
    } catch(error) {
      if((error as {name?:string}).name==='ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async bind(id:string,fingerprint:string,vmId:string,signal:AbortSignal,retiring=false):Promise<void> {
    try {
      await this.client.send(new UpdateItemCommand({TableName:this.table,Key:key(leaseKey(id)),UpdateExpression:'SET vm_id = :vm',
        ConditionExpression:'#fingerprint = :fingerprint AND (attribute_not_exists(vm_id) OR vm_id = :vm) AND '+(retiring?'retiring = :yes':'attribute_not_exists(retiring)'),ExpressionAttributeNames:{'#fingerprint':'fingerprint'},
        ExpressionAttributeValues:{':fingerprint':{S:fingerprint},':vm':{S:vmId},...(retiring?{':yes':{BOOL:true}}:{})}}),{abortSignal:signal});
    } catch(error) {
      if((error as {name?:string}).name==='ConditionalCheckFailedException') throw new MicrovmAdmissionError('CONFLICT','Provider VM binding changed');
      throw error;
    }
  }
  async release(lease:AdmissionLease,expectedVmId:string,signal:AbortSignal):Promise<void> {
    const current=await this.get(lease.id,signal);
    if(!current) return;
    if(current.fingerprint!==lease.fingerprint || current.vmId!==expectedVmId) throw new MicrovmAdmissionError('CONFLICT','VM admission release identity changed');
    const rows=[totalKey(current.totalSlot!),kindKey(current.kind,current.kindSlot!),ownerKey(current)].map(pk=>({Delete:{
      TableName:this.table,Key:key(pk),ConditionExpression:'lease_id = :id',ExpressionAttributeValues:{':id':{S:lease.id}}
    }}));
    try { await this.client.send(new TransactWriteItemsCommand({ClientRequestToken:randomUUID(),TransactItems:[...rows,{Delete:{
      TableName:this.table,Key:key(leaseKey(lease.id)),ConditionExpression:'lease_id = :id AND vm_id = :vm AND #fingerprint = :fingerprint',
      ExpressionAttributeNames:{'#fingerprint':'fingerprint'},ExpressionAttributeValues:{':id':{S:lease.id},':vm':{S:expectedVmId},':fingerprint':{S:lease.fingerprint}}
    }}]}),{abortSignal:signal}); } catch(error) {
      if((error as {name?:string}).name==='TransactionCanceledException' && !await this.get(lease.id,signal)) return;
      throw error;
    }
  }
}
