import { describe, expect, test } from 'bun:test';
import { admissionLease, MicrovmAdmission, MicrovmAdmissionError, validateAdmissionPolicy, type AdmissionLease, type AdmissionPolicy, type MicrovmAdmissionStore, type AdmissionDecision } from './admission';
import { LambdaMicrovmApiError, type LambdaMicrovmClient } from './lambda-client';

class Store implements MicrovmAdmissionStore {
  records = new Map<string,AdmissionLease>();
  configured: AdmissionPolicy | undefined = {revision:'approved-v1',total:2,coding:10,app:4};
  async leases() { return [...this.records.values()]; }
  async policy() { return this.configured; }
  async get(id:string) { return this.records.get(id); }
  async reserve(lease:AdmissionLease,policy:AdmissionPolicy):Promise<AdmissionDecision> {
    const existing=this.records.get(lease.id);
    if(existing) {
      if(existing.fingerprint!==lease.fingerprint) throw new MicrovmAdmissionError('CONFLICT','changed');
      return 'existing';
    }
    if(this.configured?.revision!==policy.revision) return 'policy_changed';
    const all=[...this.records.values()];
    if(lease.lane!=='execution' && all.some(e=>e.owner===lease.owner && e.kind===lease.kind && e.lane===lease.lane)) return 'owner_busy';
    if(all.length>=policy.total || all.filter(e=>e.kind===lease.kind).length>=policy[lease.kind]) return 'full';
    this.records.set(lease.id,{...lease});
    return 'reserved';
  }
  async beginRetirement(id:string,fingerprint:string) {
    const e=this.records.get(id);
    if(!e || e.fingerprint!==fingerprint || e.vmId && !e.retiring) return false;
    this.records.set(id,{...e,retiring:true});return true;
  }
  async bind(id:string,fingerprint:string,vmId:string,_signal?:AbortSignal,retiring=false) {
    const e=this.records.get(id);
    if(!e || e.fingerprint!==fingerprint || e.vmId && e.vmId!==vmId || Boolean(e.retiring)!==retiring) throw new MicrovmAdmissionError('CONFLICT','binding');
    this.records.set(id,{...e,vmId});
  }
  async release(lease:AdmissionLease,expected:string) {
    const e=this.records.get(lease.id);
    if(e?.fingerprint!==lease.fingerprint || e.vmId!==expected) throw new MicrovmAdmissionError('CONFLICT','release');
    this.records.delete(lease.id);
  }
}
const signal=()=>AbortSignal.timeout(5000);
function lease(user='one',token='token-one',kind:'coding'|'app'='coding',lane:'workspace'|'execution'|'app'=kind==='app'?'app':'workspace') {
  return admissionLease({tenant:'tenant',user,kind,lane,request:{imageIdentifier:'runner',imageVersion:'2.0',clientToken:token,maximumDurationSeconds:900}});
}
const client=(overrides:Partial<LambdaMicrovmClient>)=>overrides as LambdaMicrovmClient;

describe('durable MicroVM admission domain',()=>{
  test('requires an operator-owned valid policy before new admission',async()=>{
    const store=new Store();store.configured=undefined;
    await expect(new MicrovmAdmission(store).reserve(lease(),signal())).rejects.toMatchObject({code:'UNAVAILABLE'});
    expect(store.records.size).toBe(0);
    for(const value of [0,15,1.5]) expect(()=>validateAdmissionPolicy({revision:'x',total:value,coding:10,app:4})).toThrow();
  });
  test('pseudonymizes trusted owner fields and separates tenants',()=>{
    const a=lease();
    const b=admissionLease({tenant:'other',user:'one',kind:'coding',lane:'workspace',request:a.request});
    expect(a.owner).not.toBe(b.owner);
    expect(a.owner).toMatch(/^[a-f0-9]{64}$/);
    expect(()=>admissionLease({tenant:'',user:'one',kind:'coding',lane:'workspace',request:a.request})).toThrow();
  });
  test('replays the same launch reservation without consuming another slot',async()=>{
    const store=new Store(),a=new MicrovmAdmission(store),e=lease();
    await a.reserve(e,signal());
    await a.reserve({...e,createdAt:Date.now()+1000},signal());
    expect(store.records.size).toBe(1);
    await expect(a.reserve({...e,fingerprint:'changed'},signal())).rejects.toMatchObject({code:'CONFLICT'});
  });
  test('enforces the provider-wide cap across coding and apps',async()=>{
    const store=new Store(),a=new MicrovmAdmission(store);
    await a.reserve(lease(),signal());
    await a.reserve(lease('two','app-two','app'),signal());
    await expect(a.reserve(lease('three','third'),signal())).rejects.toMatchObject({code:'FULL'});
    expect(store.records.size).toBe(2);
  });
  test('a second workspace is rejected while independent app/execution lanes remain available',async()=>{
    const store=new Store();store.configured={revision:'x',total:14,coding:10,app:4};const a=new MicrovmAdmission(store);
    await a.reserve(lease(),signal());
    await expect(a.reserve(lease('one','second-workspace'),signal())).rejects.toMatchObject({code:'OWNER_BUSY'});
    await a.reserve(lease('one','execution','coding','execution'),signal());
    await a.reserve(lease('one','execution-two','coding','execution'),signal());
    await a.reserve(lease('one','app','app'),signal());
    expect(store.records.size).toBe(4);
  });
  test('cannot change the provider VM bound to an accepted reservation',async()=>{
    const store=new Store(),a=new MicrovmAdmission(store),e=await a.reserve(lease(),signal());
    await a.bind(e,'vm-one',signal());await a.bind(e,'vm-one',signal());
    await expect(a.bind(e,'vm-two',signal())).rejects.toMatchObject({code:'CONFLICT'});
  });
  test.each(['RUNNING','SUSPENDED','TERMINATING'] as const)('elapsed time never frees %s capacity',async state=>{
    const store=new Store(),a=new MicrovmAdmission(store),e=await a.reserve({...lease(),createdAt:0},signal());
    await a.bind(e,'vm-one',signal());
    expect(await a.releaseIfTerminated(e,client({getMicrovm:async()=>({microvmId:'vm-one',state})}),signal())).toBe(false);
    expect(store.records.size).toBe(1);
  });
  test('provider errors retain capacity while authoritative not-found releases it',async()=>{
    const store=new Store(),a=new MicrovmAdmission(store),e=await a.reserve(lease(),signal());await a.bind(e,'vm-one',signal());
    await expect(a.releaseIfTerminated(e,client({getMicrovm:async()=>{throw new Error('network failure');}}),signal())).rejects.toThrow();
    expect(store.records.size).toBe(1);
    expect(await a.releaseIfTerminated(e,client({getMicrovm:async()=>{throw new LambdaMicrovmApiError('not_found','GetMicrovm','gone');}}),signal())).toBe(true);
    expect(store.records.size).toBe(0);
  });
  test('an unbound ambiguous launch holds a slot and recent intents are not replayed',async()=>{
    const store=new Store(),a=new MicrovmAdmission(store),e=await a.reserve(lease(),signal());
    expect(await a.releaseIfTerminated(e,client({}),signal())).toBe(false);
    let runs=0;
    expect(await a.retireUnbound(e,client({runMicrovm:async()=>{runs++;throw Error();}}),{signal:signal(),minimumAgeMs:120000,beforeRun:async()=>{}})).toBe(false);
    expect(runs).toBe(0);expect(store.records.size).toBe(1);
  });
  test('old ambiguous intents replay exact arguments and retain capacity until termination finishes',async()=>{
    const store=new Store(),a=new MicrovmAdmission(store),e=await a.reserve({...lease(),createdAt:0},signal());
    let terminated=false,throttled=false;
    const c=client({runMicrovm:async args=>{expect(args).toEqual(e.request);expect(throttled).toBe(true);return {microvmId:'vm-recovered',state:'RUNNING'};},terminateMicrovm:async()=>{terminated=true;},getMicrovm:async()=>({microvmId:'vm-recovered',state:'TERMINATING'})});
    expect(await a.retireUnbound(e,c,{signal:signal(),minimumAgeMs:120000,beforeRun:async()=>{throttled=true;}})).toBe(false);
    expect(terminated).toBe(true);expect(store.records.size).toBe(1);
    expect(await a.releaseIfTerminated(e,client({getMicrovm:async()=>({microvmId:'vm-recovered',state:'TERMINATED'})}),signal())).toBe(true);
  });
});
